// Regression tests for POST /chair/dashboard/enable-pdf-download/:id's
// authorization, and for GET /submission/download-certificate/:id, which
// just redirects to a submission's permanently-stored certificate file -
// it no longer generates anything on request.
//
// The eligibility query, the per-status Brand Template selection, the
// Reviewer/Session Chair/Invited Speaker categories, and the graceful
// no-partial-write failure path when Canva isn't connected all live in
// test/canva.test.mjs instead, since they depend on canva_connection's
// state and that table is a true app-wide singleton - see that file's
// header comment for why every test touching it has to live in one place.

import { test, before, after } from "node:test";
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

// This file deliberately never reads or writes canva_connection (a true,
// app-wide singleton - id always 1). Any test that needs a specific
// connected/disconnected state lives in test/canva.test.mjs instead, which
// is the one file responsible for that table, precisely so two test FILES
// (node --test runs separate files in parallel) never race on it - and so
// this suite never risks silently destroying a real, working Canva
// connection an Admin has already set up for real.
let conferenceId;
let otherChairConferenceId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["CERT_PDF_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Poster Paper','CPA','Poster Scored')",
    [conferenceId, authorEmail]
  );
});

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
