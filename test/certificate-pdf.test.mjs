// Regression tests for the on-the-fly certificate PDF feature:
// - POST /chair/dashboard/enable-pdf-download/:id inserts a GENERATED
//   certificates row for every Poster Scored / Presentation Completed
//   submission in that conference, skips everything else, is idempotent,
//   and is blocked for a chair who doesn't own the conference.
// - GET /submission/download-certificate/:id streams a real PDF (no file
//   is ever stored - it's rendered fresh from assets/certificate_template.png
//   on every request) when a GENERATED row exists, is blocked for a
//   non-author, and redirects instead of serving a PDF when no GENERATED
//   row exists yet.
// Uses the real routes and the real local Postgres database.

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

test("enable-pdf-download inserts GENERATED rows only for Poster Scored / Presentation Completed submissions, and is idempotent", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["CERT_PDF_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const posterScored = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Poster Paper','CPA','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );
  const presentationCompleted = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Oral Paper','CPB','Presentation Completed') returning submission_id",
    [conferenceId, authorEmail]
  );
  const notEligible = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Still Pending','CPC','DESK ACCEPT') returning submission_id",
    [conferenceId, authorEmail]
  );

  const res = await post(`/chair/dashboard/enable-pdf-download/${conferenceId}`, chairToken);
  assert.equal(res.status, 302);

  const rows = await pool.query("select submission_id, status from certificates where conference_id = $1", [conferenceId]);
  const bySubmission = Object.fromEntries(rows.rows.map((r) => [r.submission_id, r.status]));
  assert.equal(bySubmission[posterScored.rows[0].submission_id], "GENERATED");
  assert.equal(bySubmission[presentationCompleted.rows[0].submission_id], "GENERATED");
  assert.equal(bySubmission[notEligible.rows[0].submission_id], undefined, "a submission that isn't scored/completed gets no row");

  // Clicking it again must not create duplicate rows for the same submissions.
  const res2 = await post(`/chair/dashboard/enable-pdf-download/${conferenceId}`, chairToken);
  assert.equal(res2.status, 302);
  const rowsAfter = await pool.query("select count(*)::int as n from certificates where conference_id = $1", [conferenceId]);
  assert.equal(rowsAfter.rows[0].n, 2, "re-running must not duplicate rows");
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

test("download-certificate streams a real PDF for the author once a GENERATED row exists", async () => {
  const res = await get(`/submission/download-certificate/${(await pool.query("select submission_id from submissions where conference_id=$1 and paper_code='CPA'", [conferenceId])).rows[0].submission_id}`, authorToken);

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/pdf/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString("ascii"), "%PDF-", "response body must be a real PDF");
  assert.ok(buf.length > 1000, "the generated PDF should contain the embedded template image, not be near-empty");
});

test("download-certificate redirects (no PDF) when no GENERATED row exists yet", async () => {
  const pending = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'No Cert Yet','CPE','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );

  const res = await get(`/submission/download-certificate/${pending.rows[0].submission_id}`, authorToken);
  assert.equal(res.status, 302);
  assert.doesNotMatch(res.headers.get("location") || "", /download-certificate/);
});

test("download-certificate is blocked for a user who is not an author on the submission", async () => {
  const posterScoredId = (await pool.query("select submission_id from submissions where conference_id=$1 and paper_code='CPA'", [conferenceId])).rows[0].submission_id;
  const res = await get(`/submission/download-certificate/${posterScoredId}`, strangerToken);
  assert.equal(res.status, 302);
  assert.notEqual(res.headers.get("content-type"), "application/pdf");
});
