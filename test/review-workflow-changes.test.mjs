// Regression tests for a set of related review-workflow changes:
// 1. The Chair's direct decision-making routes (resolve-conflicts,
//    resolve-re-review-conflicts, and their POST handlers) have been removed
//    entirely - a submission's final decision now only ever comes from a
//    Meta-Reviewer recommendation, applied at /publish/review-results.
// 2. The Meta-Reviewer dashboard now also lists "Submitted Revised Paper"
//    submissions that have been re-reviewed, not just first-round
//    "DESK ACCEPT" submissions, since the Chair no longer resolves revised
//    papers directly either.
// 3. The peer-review deadline (conferences.deadline_peer_review) is now
//    enforced: once it has passed, a reviewer can no longer open the review
//    form or submit a review (first round or re-review).
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
const chairEmail = "review-workflow-test-chair@example.com";
const metaReviewerEmail = "review-workflow-test-meta@example.com";
const reviewerEmail = "review-workflow-test-reviewer@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "RW Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const conferenceIds = [];
const trackIds = [];
const submissionIds = [];

async function makeConference() {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["RW_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceIds.push(conf.rows[0].conference_id);
  return conf.rows[0].conference_id;
}

async function makeTrack(conferenceId, overrides = {}) {
  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, meta_reviewer, track_reviewers) values ($1,$2,$3,$4) returning track_id",
    [conferenceId, "RW Track " + crypto.randomBytes(2).toString("hex"), overrides.meta_reviewer ?? metaReviewerEmail, overrides.track_reviewers ?? [reviewerEmail]]
  );
  trackIds.push(track.rows[0].track_id);
  return track.rows[0].track_id;
}

async function makeSubmission(conferenceId, trackId, status) {
  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, track_id) values ($1,$2,$3,$4,$5,$6) returning submission_id",
    [conferenceId, "rw-test-author@example.com", "RW Test Submission", "RW" + crypto.randomBytes(3).toString("hex"), status, trackId]
  );
  submissionIds.push(sub.rows[0].submission_id);
  return sub.rows[0].submission_id;
}

after(async () => {
  if (submissionIds.length) {
    await pool.query("delete from peer_review where submission_id = ANY($1)", [submissionIds]);
    await pool.query("delete from revised_submissions where submission_id = ANY($1)", [submissionIds]);
    await pool.query("delete from meta_reviewer_decision where submission_id = ANY($1)", [submissionIds]);
    await pool.query("delete from submissions where submission_id = ANY($1)", [submissionIds]);
  }
  if (trackIds.length) await pool.query("delete from conference_tracks where track_id = ANY($1)", [trackIds]);
  if (conferenceIds.length) await pool.query("delete from conferences where conference_id = ANY($1)", [conferenceIds]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the Chair's old direct-decision routes no longer exist", async () => {
  const conferenceId = await makeConference();
  const trackId = await makeTrack(conferenceId);
  const submissionId = await makeSubmission(conferenceId, trackId, "DESK ACCEPT");

  const getResolve = await get(`/chair/dashboard/resolve-conflicts/${submissionId}`, chairToken);
  assert.equal(getResolve.status, 404, "GET resolve-conflicts must no longer be a route");

  const postResolve = await post(`/resolve-conflict/${submissionId}/${conferenceId}`, chairToken, { final_remarks: "x", status: "Rejected" });
  assert.equal(postResolve.status, 404, "POST resolve-conflict must no longer be a route");

  const getReReview = await get(`/chair/dashboard/resolve-re-review-conflicts/${submissionId}`, chairToken);
  assert.equal(getReReview.status, 404, "GET resolve-re-review-conflicts must no longer be a route");

  const postReReview = await post(`/resolve-re-review-conflicts/${submissionId}/${conferenceId}`, chairToken, { final_remarks: "x", status: "Rejected" });
  assert.equal(postReReview.status, 404, "POST resolve-re-review-conflicts must no longer be a route");

  // Sanity: the submission's status is untouched by any of the above.
  const row = await pool.query("select submission_status from submissions where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].submission_status, "DESK ACCEPT");
});

test("Meta-Reviewer dashboard lists both a first-round DESK ACCEPT submission and a re-reviewed Submitted Revised Paper submission", async () => {
  const conferenceId = await makeConference();
  const trackId = await makeTrack(conferenceId);
  const metaToken = jwt.sign({ typ: "access", email: metaReviewerEmail, name: "RW Meta", user_id: 2, role: "user", roles: { [conferenceId]: ["meta_reviewer"] } }, secret, { expiresIn: "5m" });

  const firstRoundId = await makeSubmission(conferenceId, trackId, "DESK ACCEPT");
  await pool.query(
    "insert into peer_review (conference_id, submission_id, originality_score, relevance_score, technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status, remarks, reviewer, review_status) values ($1,$2,3,3,3,3,3,3,'Accepted for Oral Presentation','ok',$3,'Reviewed')",
    [conferenceId, firstRoundId, reviewerEmail]
  );

  const revisedId = await makeSubmission(conferenceId, trackId, "Submitted Revised Paper");
  await pool.query(
    "insert into revised_submissions (submission_id, originality_score, relevance_score, technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status, review_status, reviewer, remarks) values ($1,3,3,3,3,3,3,'Accepted for Oral Presentation','Re-Reviewed',$2,'ok')",
    [revisedId, reviewerEmail]
  );

  const html = await (await get(`/meta-reviewer/dashboard/${conferenceId}`, metaToken)).text();
  assert.ok(html.includes(`/meta-reviewer/dashboard/recommendation-submission/${firstRoundId}`), "the first-round submission must be listed");
  assert.ok(html.includes(`/meta-reviewer/dashboard/recommendation-submission/${revisedId}`), "the re-reviewed submission must also be listed");
  assert.match(html, /First Review/);
  assert.match(html, /Re-Review/);

  // The recommendation form for the revised submission must show the
  // re-review data (from revised_submissions), not the first-round table.
  const formHtml = await (await get(`/meta-reviewer/dashboard/recommendation-submission/${revisedId}`, metaToken)).text();
  assert.ok(formHtml.includes(reviewerEmail), "the re-reviewer's identity must appear on the recommendation form");
  assert.match(formHtml, /re-review/i);
});

test("peer-review deadline: once it has passed, a reviewer cannot open or submit a review", async () => {
  const conferenceId = await makeConference();
  await pool.query("update conferences set deadline_peer_review = $1 where conference_id = $2", ["2000-01-01", conferenceId]);
  const trackId = await makeTrack(conferenceId);
  const submissionId = await makeSubmission(conferenceId, trackId, "DESK ACCEPT");
  const paperCode = (await pool.query("select paper_code from submissions where submission_id = $1", [submissionId])).rows[0].paper_code;

  const reviewerToken = jwt.sign({ typ: "access", email: reviewerEmail, name: "RW Reviewer", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

  const formHtml = await (await get(`/reviewer/dashboard/review/${paperCode}`, reviewerToken)).text();
  assert.match(formHtml, /deadline.*passed/i, "the review form must refuse to render once the deadline has passed");

  const postRes = await post("/mark-as-reviewed", reviewerToken, {
    submission_id: submissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: 3,
    relevance_score: 3,
    technical_quality_score: 3,
    clarity_score: 3,
    impact_score: 3,
    remarks: "test",
  });
  assert.equal(postRes.status, 302);
  const location = postRes.headers.get("location") || "";
  assert.match(location, /deadline.*passed/i, "the POST must also refuse once the deadline has passed");

  const stored = await pool.query("select 1 from peer_review where submission_id = $1", [submissionId]);
  assert.equal(stored.rows.length, 0, "no review row should have been written after the deadline");
});

test("peer-review deadline also blocks re-review of a revised paper", async () => {
  const conferenceId = await makeConference();
  await pool.query("update conferences set deadline_peer_review = $1 where conference_id = $2", ["2000-01-01", conferenceId]);
  const trackId = await makeTrack(conferenceId);
  const submissionId = await makeSubmission(conferenceId, trackId, "Submitted Revised Paper");
  const paperCode = (await pool.query("select paper_code from submissions where submission_id = $1", [submissionId])).rows[0].paper_code;

  const reviewerToken = jwt.sign({ typ: "access", email: reviewerEmail, name: "RW Reviewer", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

  const formHtml = await (await get(`/reviewer/dashboard/re-review/${paperCode}`, reviewerToken)).text();
  assert.match(formHtml, /deadline.*passed/i);

  const postRes = await post("/mark-as-re-reviewed", reviewerToken, {
    submission_id: submissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: 3,
    relevance_score: 3,
    technical_quality_score: 3,
    clarity_score: 3,
    impact_score: 3,
    remarks: "test",
  });
  assert.equal(postRes.status, 302);
  assert.match(postRes.headers.get("location") || "", /deadline.*passed/i);

  const stored = await pool.query("select 1 from revised_submissions where submission_id = $1", [submissionId]);
  assert.equal(stored.rows.length, 0, "no re-review row should have been written after the deadline");
});

test("AI detection columns are gone from the schema", async () => {
  const cols = await pool.query(
    "select table_name, column_name from information_schema.columns where column_name in ('ai_score','is_ai') and table_name in ('submissions','revised_submissions')"
  );
  assert.equal(cols.rows.length, 0, "ai_score/is_ai must not exist on submissions or revised_submissions anymore");
});
