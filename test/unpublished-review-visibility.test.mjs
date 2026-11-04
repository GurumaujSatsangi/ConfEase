// Regression tests for chair-only visibility into in-progress reviews:
// a reviewer's/meta-reviewer's score, remarks, and decision are visible
// to the chair on the Review Details modal as soon as they're submitted
// - not only once /publish/review-results has run - while the author's
// side (conference.ejs, the submission email) stays exactly as it was,
// seeing nothing until that publish happens.

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
const chairEmail = "urv-test-chair@example.com";
const authorEmail = "urv-test-author@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "Author", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

function extractReviewModalHtml(html, submissionId) {
  const startMarker = `id="reviewModal-${submissionId}"`;
  const start = html.indexOf(startMarker);
  if (start === -1) return "";
  const searchFrom = start + startMarker.length;
  const nextModalId = html.indexOf("Modal-", searchFrom);
  return html.slice(start, nextModalId === -1 ? undefined : html.lastIndexOf("<div", nextModalId));
}

let conferenceId, submissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, acceptance_notification) values ($1,$2,$3) returning conference_id",
    ["URV_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "2020-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'URV Paper','URV1',201,'DESK ACCEPT') returning submission_id",
    [conferenceId, authorEmail]
  );
  submissionId = sub.rows[0].submission_id;

  await pool.query(
    "insert into peer_review (conference_id, submission_id, reviewer, mean_score, remarks, acceptance_status) values ($1,$2,$3,$4,$5,$6)",
    [conferenceId, submissionId, "urv-test-reviewer@example.com", 4.2, "URV_SECRET_REVIEWER_REMARKS", "Accepted for Oral Presentation"]
  );
  await pool.query(
    "insert into meta_reviewer_decision (submission_id, status, remarks) values ($1,$2,$3)",
    [submissionId, "Accepted for Oral Presentation", "URV_SECRET_META_REMARKS"]
  );
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from meta_reviewer_decision where submission_id = $1", [submissionId]);
    await pool.query("delete from peer_review where submission_id = $1", [submissionId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the chair sees the reviewer's score/remarks and the meta-reviewer's unpublished decision immediately, marked Pending Publication", async () => {
  const res = await get(`/chair/dashboard/view-submissions/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  const modalHtml = extractReviewModalHtml(html, submissionId);

  assert.match(modalHtml, />Peer Review</, "the peer review table must be shown before publication");
  assert.match(modalHtml, /URV_SECRET_REVIEWER_REMARKS/, "the reviewer's remarks must be visible to the chair pre-publish");
  assert.match(modalHtml, />\s*Meta-Reviewer Decision/);
  assert.match(modalHtml, /URV_SECRET_META_REMARKS/, "the meta-reviewer's remarks must be visible to the chair pre-publish");
  assert.match(modalHtml, /Pending Publication/, "an unpublished meta-reviewer decision must be flagged as such to the chair");
});

test("the submission's status has NOT changed yet - the meta-reviewer decision is advisory only until publish", async () => {
  const row = await pool.query("select submission_status, remarks from submissions where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].submission_status, "DESK ACCEPT", "status must be untouched by a mere meta-reviewer submission");
  assert.equal(row.rows[0].remarks, null, "submissions.remarks must stay null until /publish/review-results runs");
});

test("the author's own page never reveals the reviewer's or meta-reviewer's remarks, published or not", async () => {
  const html = await (await get(`/conference/${conferenceId}`, authorToken)).text();
  assert.doesNotMatch(html, /URV_SECRET_REVIEWER_REMARKS/);
  assert.doesNotMatch(html, /URV_SECRET_META_REMARKS/);
});

test("publishing applies the decision, clears the pending flag, and the chair's modal keeps showing it without the Pending badge", async () => {
  const res = await post("/publish/review-results", chairToken, { conference_id: conferenceId });
  // This submission is the only one in the conference and ends up at a
  // "pending acceptance notification" status (DESK ACCEPT is in that set),
  // so the route renders the pending-acceptance confirmation page rather
  // than redirecting - either way the write already happened.
  assert.ok(res.status === 200 || res.status === 302);

  const row = await pool.query("select submission_status, remarks from submissions where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].submission_status, "Accepted for Oral Presentation");
  assert.equal(row.rows[0].remarks, "URV_SECRET_META_REMARKS");

  const pending = await pool.query("select 1 from meta_reviewer_decision where submission_id = $1", [submissionId]);
  assert.equal(pending.rows.length, 0, "the advisory row must be cleared once applied");

  const html = await (await get(`/chair/dashboard/view-submissions/${conferenceId}`, chairToken)).text();
  const modalHtml = extractReviewModalHtml(html, submissionId);
  assert.match(modalHtml, /URV_SECRET_META_REMARKS/);
  assert.doesNotMatch(modalHtml, /Pending Publication/, "a published decision must no longer show the pending badge");
});
