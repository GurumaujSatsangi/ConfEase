// Regression tests for the chair-uploaded "DrillBit AI & Plagiarism
// Report" (submissions.plagiarism_report_public_id/_resource_type/_format,
// db/migrations/037_plagiarism_report.sql) and the "Reviews" link shown
// for a desk-rejected submission.
//
// A DESK ACCEPT submission with a report uploaded shows only the report
// link; a DESK REJECT one shows both the "Reviews" link (its own page,
// GET /submission/desk-reject-reviews/:id) and the report link; neither
// shows for any other status. Report rows are seeded directly (not
// through a real Cloudinary upload - see file04-private-papers.test.mjs
// for the same reasoning) with a plausible public_id, then asserted on
// via the rendered signed delivery link.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const authorEmail = "plag-test-author@example.com";
const coAuthorEmail = "plag-test-coauthor@example.com";
const strangerEmail = "plag-test-stranger@example.com";
const chairEmail = "plag-test-chair@example.com";
const otherChairEmail = "plag-test-other-chair@example.com";

const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "Plag Test Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const coAuthorToken = jwt.sign({ typ: "access", email: coAuthorEmail, name: "Plag Test Co-Author", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const strangerToken = jwt.sign({ typ: "access", email: strangerEmail, name: "Plag Test Stranger", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Plag Test Chair", user_id: 4, role: "chair" }, secret, { expiresIn: "5m" });
const otherChairToken = jwt.sign({ typ: "chair", email: otherChairEmail, name: "Plag Test Other Chair", user_id: 5, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token) => fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId;
let acceptSubmissionId, rejectSubmissionId, pendingSubmissionId;
const REPORT_PUBLIC_ID = "plag-test-reports/report-" + crypto.randomBytes(4).toString("hex");
const REJECT_REMARKS = "Formatting does not follow the required template.";

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, deadline_peer_review) values ($1,$2,$3) returning conference_id",
    ["PLAG_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "2099-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const acceptSub = await pool.query(
    `insert into submissions (conference_id, primary_author, co_authors, title, paper_code, paper_number, submission_status, plagiarism_report_public_id, plagiarism_report_resource_type, plagiarism_report_format)
     values ($1,$2,$3,'Plag Test Accepted Paper','PLAGA',901,'DESK ACCEPT',$4,'image','pdf') returning submission_id`,
    [conferenceId, authorEmail, [coAuthorEmail], REPORT_PUBLIC_ID]
  );
  acceptSubmissionId = acceptSub.rows[0].submission_id;

  const rejectSub = await pool.query(
    `insert into submissions (conference_id, primary_author, co_authors, title, paper_code, paper_number, submission_status, plagiarism_report_public_id, plagiarism_report_resource_type, plagiarism_report_format)
     values ($1,$2,$3,'Plag Test Rejected Paper','PLAGB',902,'DESK REJECT',$4,'image','pdf') returning submission_id`,
    [conferenceId, authorEmail, [coAuthorEmail], REPORT_PUBLIC_ID]
  );
  rejectSubmissionId = rejectSub.rows[0].submission_id;
  await pool.query("insert into desk_review(paper_id,decision,user_email,remarks) values ($1,'DESK REJECT',$2,$3)", [rejectSubmissionId, chairEmail, REJECT_REMARKS]);

  const pendingSub = await pool.query(
    `insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status)
     values ($1,$2,'Plag Test Pending Paper','PLAGC',903,'Submitted for Review') returning submission_id`,
    [conferenceId, authorEmail]
  );
  pendingSubmissionId = pendingSub.rows[0].submission_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a DESK ACCEPT submission shows the DrillBit AI & Plagiarism Report link, but no Reviews link", async () => {
  const html = await (await get(`/conference/${conferenceId}`, authorToken)).text();
  assert.ok(html.includes("DrillBit AI &amp; Plagiarism Report"), "the report link must be shown");
  assert.ok(html.includes(REPORT_PUBLIC_ID), "the report link must be a signed delivery URL bearing the report's own public_id");
  assert.ok(!html.includes(`/submission/desk-reject-reviews/${acceptSubmissionId}`), "a desk-accepted submission must not show a Reviews link");
});

test("a DESK REJECT submission shows both the Reviews link and the report link", async () => {
  const html = await (await get(`/conference/${conferenceId}`, authorToken)).text();
  assert.ok(html.includes(`/submission/desk-reject-reviews/${rejectSubmissionId}`), "the Reviews link must point at the desk-reject-reviews page for this submission");
  assert.ok(html.includes("DrillBit AI &amp; Plagiarism Report"), "the report link must still be shown alongside Reviews");
});

test("a pending (not yet desk-decided) submission shows neither link", async () => {
  const html = await (await get(`/conference/${conferenceId}`, authorToken)).text();
  assert.ok(html.includes("PLAGC"), "the pending submission must still render");
  assert.ok(!html.includes(`/submission/desk-reject-reviews/${pendingSubmissionId}`), "a pending submission must not show a Reviews link");
});

test("a co-author also sees both links on a desk-rejected submission", async () => {
  const html = await (await get(`/conference/${conferenceId}`, coAuthorToken)).text();
  assert.ok(html.includes(`/submission/desk-reject-reviews/${rejectSubmissionId}`));
  assert.ok(html.includes("DrillBit AI &amp; Plagiarism Report"));
});

test("GET /submission/desk-reject-reviews/:id shows the chair's remarks to the primary author", async () => {
  const html = await (await get(`/submission/desk-reject-reviews/${rejectSubmissionId}`, authorToken)).text();
  assert.ok(html.includes(REJECT_REMARKS), "the chair's desk-rejection remarks must be shown");
});

test("GET /submission/desk-reject-reviews/:id also works for a co-author", async () => {
  const html = await (await get(`/submission/desk-reject-reviews/${rejectSubmissionId}`, coAuthorToken)).text();
  assert.ok(html.includes(REJECT_REMARKS));
});

test("GET /submission/desk-reject-reviews/:id rejects a user who is neither the primary author nor a co-author", async () => {
  const res = await get(`/submission/desk-reject-reviews/${rejectSubmissionId}`, strangerToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized/);
});

test("GET /submission/desk-reject-reviews/:id refuses a submission that isn't DESK REJECT", async () => {
  const res = await get(`/submission/desk-reject-reviews/${acceptSubmissionId}`, authorToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /only available for a desk-rejected submission/);
});

test("POST /chair/dashboard/desk/upload-plagiarism-report/:id rejects a chair who does not own the conference", async () => {
  const res = await post(`/chair/dashboard/desk/upload-plagiarism-report/${pendingSubmissionId}`, otherChairToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized/);
});

test("POST /chair/dashboard/desk/upload-plagiarism-report/:id redirects with a message when no file is attached", async () => {
  const res = await post(`/chair/dashboard/desk/upload-plagiarism-report/${pendingSubmissionId}`, chairToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /choose a PDF file/);
});
