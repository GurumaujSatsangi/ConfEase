// Regression tests for the chair's "Co-Author Update Required" button on
// the Manage Submissions page (POST
// /chair/dashboard/request-co-author-update/:id): emails the primary
// author asking them to have their co-authors join via Paper Code.
// Uses the real route and the real local Postgres database; sendMail is
// intercepted via mailer.js's test-only recorder (SKIP_AUTOLISTEN=1), so
// no real email is sent by this test.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");
const { testSentEmails, resetTestSentEmails } = await import("../mailer.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "cau-test-chair@example.com";
const otherChairEmail = "cau-test-other-chair@example.com";
const primaryAuthorEmail = "cau-test-author@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const otherChairToken = jwt.sign({ typ: "chair", email: otherChairEmail, name: "Other Chair", user_id: 2, role: "chair" }, secret, { expiresIn: "5m" });

const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId, submissionId;

before(async () => {
  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["CAU Test Author", primaryAuthorEmail]);

  const conf = await pool.query(
    "insert into conferences (title, created_by, full_paper_submission) values ($1,$2,$3) returning conference_id",
    ["CAU_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "2026-12-15"]
  );
  conferenceId = conf.rows[0].conference_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'CAU Test Paper','CAU01',701,'Submitted for Review') returning submission_id",
    [conferenceId, primaryAuthorEmail]
  );
  submissionId = sub.rows[0].submission_id;
});

beforeEach(() => {
  resetTestSentEmails();
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  await pool.query("delete from users where email = $1", [primaryAuthorEmail]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("emails the primary author with the paper's own details, and redirects with a success message", async () => {
  const res = await post(`/chair/dashboard/request-co-author-update/${submissionId}`, chairToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /Co-author update request emailed to the primary author/);

  assert.equal(testSentEmails.length, 1);
  const sent = testSentEmails[0];
  assert.equal(sent.to, primaryAuthorEmail);
  assert.match(sent.subject, /^Request to Add Co-Authors on the DEI CMT Portal \| Paper ID: 0701 \| CAU_TEST_/);
});

test("a chair who does not own the conference is rejected, and no email is sent", async () => {
  const res = await post(`/chair/dashboard/request-co-author-update/${submissionId}`, otherChairToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized/);
  assert.equal(testSentEmails.length, 0);
});

test("a nonexistent submission id is rejected cleanly, and no email is sent", async () => {
  const res = await post(`/chair/dashboard/request-co-author-update/${crypto.randomUUID()}`, chairToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized/);
  assert.equal(testSentEmails.length, 0);
});
