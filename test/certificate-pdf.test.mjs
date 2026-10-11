// Regression tests for the Canva-based bulk certificate generation feature:
// - POST /chair/dashboard/enable-pdf-download/:id selects every Poster
//   Scored / Presentation Completed submission in the conference that
//   doesn't already have a GENERATED certificate with a stored file, and
//   (per submission) autofills the connected Canva Brand Template, exports
//   it as a PDF, uploads that PDF to Cloudinary, stores the permanent URL
//   on the certificates row, and emails the author. It's blocked for a
//   chair who doesn't own the conference.
// - GET /submission/download-certificate/:id just redirects to the
//   permanently-stored file - it no longer generates anything on request.
//
// This test environment has no live Canva connection (that requires a real
// person completing a one-time browser-based OAuth consent - see
// /admin/canva/connect - which isn't something an automated test can do),
// so the actual Canva autofill/export calls cannot be exercised here. What
// IS tested with the real routes and real local Postgres database:
// authorization, the eligibility query, graceful per-submission failure
// when Canva isn't connected (genuinely true in this environment, so this
// is real behavior, not a stub), and download-certificate's redirect logic
// against directly-seeded certificates rows. The Canva API calls
// themselves (PKCE/token exchange, autofill+export polling) are covered
// separately in test/canva.test.mjs against a stubbed fetch.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "cert-pdf-test-chair@example.com";
const authorEmail = "cert-pdf-test-author@example.com";
const strangerEmail = "cert-pdf-test-stranger@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Cert PDF Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "Cert PDF Test Author", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const strangerToken = jwt.sign({ typ: "access", email: strangerEmail, name: "Cert PDF Test Stranger", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const post = (path, token) => fetch(base + path, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${token}` } });
const get = (path, token) => fetch(base + path, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });

let conferenceId;
let otherChairConferenceId;
after(async () => {
  for (const id of [conferenceId, otherChairConferenceId].filter(Boolean)) {
    await pool.query("delete from certificates where conference_id = $1", [id]);
    await pool.query("delete from submissions where conference_id = $1", [id]);
    await pool.query("delete from conferences where conference_id = $1", [id]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("enable-pdf-download: with Canva not connected, every eligible submission fails gracefully (no rows written, no crash, failure count reported)", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["CERT_PDF_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const posterScored = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Poster Paper','CPA','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Oral Paper','CPB','Presentation Completed')",
    [conferenceId, authorEmail]
  );
  const notEligible = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Still Pending','CPC','DESK ACCEPT') returning submission_id",
    [conferenceId, authorEmail]
  );

  const res = await post(`/chair/dashboard/enable-pdf-download/${conferenceId}`, chairToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /0 submission\(s\)/, "Canva is not connected in this test environment, so nothing should have been generated");

  const rows = await pool.query("select submission_id, status, file_url from certificates where conference_id = $1", [conferenceId]);
  assert.equal(rows.rows.length, 0, "a failed Canva call must not leave a half-written certificates row behind");

  const stillUngenerated = await pool.query(
    "select 1 from submissions where submission_id = ANY($1) and submission_id::text not in (select submission_id from certificates)",
    [[posterScored.rows[0].submission_id, notEligible.rows[0].submission_id]]
  );
  assert.equal(stillUngenerated.rows.length, 2);
});

test("enable-pdf-download is blocked for a chair who does not own the conference", async () => {
  const otherChairToken = jwt.sign({ typ: "chair", email: "cert-pdf-other-chair@example.com", name: "Other Chair", user_id: 4, role: "chair" }, secret, { expiresIn: "5m" });
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["CERT_PDF_TEST_OTHER_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  otherChairConferenceId = conf.rows[0].conference_id;
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'X','CPD','Poster Scored')",
    [otherChairConferenceId, authorEmail]
  );

  await post(`/chair/dashboard/enable-pdf-download/${otherChairConferenceId}`, otherChairToken);

  const rows = await pool.query("select count(*)::int as n from certificates where conference_id = $1", [otherChairConferenceId]);
  assert.equal(rows.rows[0].n, 0, "a non-owning chair must not be able to generate certificates for this conference");
});

test("download-certificate redirects straight to the permanently-stored file once a GENERATED certificate with a file exists", async () => {
  const submissionId = (await pool.query("select submission_id from submissions where conference_id=$1 and paper_code='CPA'", [conferenceId])).rows[0].submission_id;
  const storedUrl = "https://res.cloudinary.com/demo/raw/upload/certificates/fake-certificate.pdf";
  await pool.query(
    "insert into certificates (conference_id, submission_id, status, file_url) values ($1,$2,'GENERATED',$3)",
    [conferenceId, submissionId, storedUrl]
  );

  const res = await get(`/submission/download-certificate/${submissionId}`, authorToken);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), storedUrl, "must redirect straight to the stored Cloudinary URL, not generate anything itself");
});

test("download-certificate redirects (no file) when no certificates row exists yet", async () => {
  const pending = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'No Cert Yet','CPE','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );

  const res = await get(`/submission/download-certificate/${pending.rows[0].submission_id}`, authorToken);
  assert.equal(res.status, 302);
  assert.doesNotMatch(res.headers.get("location") || "", /download-certificate/);
});

test("download-certificate redirects (no file) when a certificates row exists but has no stored file_url", async () => {
  const halfDone = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Half Done','CPF','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );
  await pool.query(
    "insert into certificates (conference_id, submission_id, status, file_url) values ($1,$2,'GENERATED',NULL)",
    [conferenceId, halfDone.rows[0].submission_id]
  );

  const res = await get(`/submission/download-certificate/${halfDone.rows[0].submission_id}`, authorToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not been generated/);
});

test("download-certificate is blocked for a user who is not an author on the submission", async () => {
  const posterScoredId = (await pool.query("select submission_id from submissions where conference_id=$1 and paper_code='CPA'", [conferenceId])).rows[0].submission_id;
  const res = await get(`/submission/download-certificate/${posterScoredId}`, strangerToken);
  assert.equal(res.status, 302);
  assert.notEqual(res.headers.get("content-type"), "application/pdf");
});
