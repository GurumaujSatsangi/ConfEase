// Regression tests for the admin "Manage Co-Author Requests" modal
// (Manage Conferences accordion, views/admin.ejs): admin-side
// accept/reject/remove for a conference's co-author requests, and the
// "Send Email Alert" reminder to the primary author. These are separate
// routes from the primary-author-only ones (POST /co-author-request/
// accept|reject/:request_id, POST /remove-co-author/:id/:co_author), gated
// by requireAdmin instead of submission ownership - generic anonymous/
// non-admin rejection for these routes is covered by test/authz.test.mjs's
// ADMIN_ROUTES table; this file covers the concrete side effects and the
// admin-authorized happy path. sendMail is intercepted via mailer.js's
// test-only recorder (SKIP_AUTOLISTEN=1), so no real email is sent.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || "acr-test-admin@example.com";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");
const { testSentEmails, resetTestSentEmails } = await import("../mailer.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const adminEmail = "acr-test-admin@example.com";
const primaryAuthorEmail = "acr-test-primary@example.com";
const coAuthorEmail = "acr-test-coauthor@example.com";
const coAuthor2Email = "acr-test-coauthor-2@example.com";

const adminToken = jwt.sign({ typ: "access", email: adminEmail, name: "Admin", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const post = (path, token) =>
  fetch(base + path, { method: "POST", redirect: "manual", headers: token ? { Authorization: `Bearer ${token}` } : {} });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId, submissionId;
let pendingRequestId, acceptedRequestId, pendingRequestId2;

before(async () => {
  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["ACR Test Primary", primaryAuthorEmail]);
  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["ACR Test Co-Author", coAuthorEmail]);

  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["ACR_TEST_" + crypto.randomBytes(3).toString("hex"), "acr-test-chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'ACR Test Paper','ACR01',501,'Submitted for Review') returning submission_id",
    [conferenceId, primaryAuthorEmail]
  );
  submissionId = sub.rows[0].submission_id;
});

beforeEach(async () => {
  resetTestSentEmails();
  await pool.query("delete from co_author_requests where submission_id = $1", [submissionId]);
  await pool.query("update submissions set co_authors = ARRAY[]::text[] where submission_id = $1", [submissionId]);

  const pending = await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Pending') returning request_id",
    [conferenceId, submissionId, primaryAuthorEmail, coAuthorEmail]
  );
  pendingRequestId = pending.rows[0].request_id;

  const accepted = await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Accepted') returning request_id",
    [conferenceId, submissionId, primaryAuthorEmail, coAuthor2Email]
  );
  acceptedRequestId = accepted.rows[0].request_id;
  await pool.query("update submissions set co_authors = ARRAY[$1]::text[] where submission_id = $2", [coAuthor2Email, submissionId]);
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from co_author_requests where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("GET /admin lists this conference's pending and accepted co-author requests", async () => {
  const res = await fetch(base + "/admin", { headers: { Authorization: `Bearer ${adminToken}` } });
  const html = await res.text();
  assert.match(html, /ACR Test Paper/);
  assert.match(html, new RegExp(coAuthorEmail.replace(/[.@]/g, "\\$&") + " \\(Pending\\)"));
  assert.match(html, new RegExp(coAuthor2Email.replace(/[.@]/g, "\\$&") + " \\(Accepted\\)"));
});

test("an admin can approve a pending co-author request", async () => {
  const res = await post(`/admin/co-author-requests/accept/${pendingRequestId}`, adminToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /accepted/);

  const row = await pool.query("select status from co_author_requests where request_id = $1", [pendingRequestId]);
  assert.equal(row.rows[0].status, "Accepted");

  const sub = await pool.query("select co_authors from submissions where submission_id = $1", [submissionId]);
  assert.ok(sub.rows[0].co_authors.includes(coAuthorEmail));

  assert.equal(testSentEmails.length, 1);
  assert.equal(testSentEmails[0].to, coAuthorEmail);
});

test("an admin can reject a pending co-author request", async () => {
  const res = await post(`/admin/co-author-requests/reject/${pendingRequestId}`, adminToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /rejected/);

  const row = await pool.query("select status from co_author_requests where request_id = $1", [pendingRequestId]);
  assert.equal(row.rows[0].status, "Rejected");

  assert.equal(testSentEmails.length, 1);
  assert.equal(testSentEmails[0].to, coAuthorEmail);
});

test("an admin can remove an already-accepted co-author", async () => {
  const res = await post(`/admin/co-author-requests/remove/${submissionId}/${encodeURIComponent(coAuthor2Email)}`, adminToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /removed/);

  const sub = await pool.query("select co_authors from submissions where submission_id = $1", [submissionId]);
  assert.ok(!sub.rows[0].co_authors.includes(coAuthor2Email));

  const row = await pool.query("select 1 from co_author_requests where request_id = $1", [acceptedRequestId]);
  assert.equal(row.rows.length, 0, "the co_author_requests row must be deleted entirely, not just flagged");

  assert.equal(testSentEmails.length, 1);
  assert.equal(testSentEmails[0].to, coAuthor2Email);
});

test("Send Email Alert reminds the primary author, listing every pending co-author for that submission", async () => {
  // Add a second pending request for the same submission, so the reminder
  // must list both, not just whichever one a button happened to be on.
  await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Pending') returning request_id",
    [conferenceId, submissionId, primaryAuthorEmail, "acr-test-coauthor-3@example.com"]
  );

  const res = await post(`/admin/co-author-requests/send-reminder/${submissionId}`, adminToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /Reminder emailed/);

  assert.equal(testSentEmails.length, 1);
  assert.equal(testSentEmails[0].to, primaryAuthorEmail);
  assert.match(testSentEmails[0].subject, /^Action Required: Pending Co-Author Requests \| Paper ID: 0501 \|/);
});

test("Send Email Alert is refused when the submission has no pending requests, and sends no email", async () => {
  await pool.query("update co_author_requests set status = 'Accepted' where submission_id = $1 and status = 'Pending'", [submissionId]);

  const res = await post(`/admin/co-author-requests/send-reminder/${submissionId}`, adminToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /no pending co-author requests/);
  assert.equal(testSentEmails.length, 0);
});
