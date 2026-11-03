// Regression tests for per-Track "Allowed Decisions": a chair can restrict
// which final decisions (Accepted for Oral Presentation / Accepted for
// Poster Presentation) are available to reviewers and meta-reviewers for
// every subject area under a Track - at least one must always stay
// enabled, and Revision Required/Rejected are never restricted.
//
// Covers: the chair-side update route (including the minimum-one rule),
// the reviewer/re-review/meta-reviewer dropdowns actually hiding the
// disallowed option, the same rule enforced server-side (not just hidden
// in the UI) on all three decision-submitting POST routes, and that a
// subject area with no Track at all is never restricted.

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
const chairEmail = "tad-test-chair@example.com";
const reviewerEmail = "tad-test-reviewer@example.com";
const metaReviewerEmail = "tad-test-meta@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const reviewerToken = jwt.sign({ typ: "access", email: reviewerEmail, name: "Reviewer", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const metaToken = jwt.sign({ typ: "access", email: metaReviewerEmail, name: "Meta", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId, groupId;
let firstRoundSubmissionId, firstRoundPaperCode;
let revisedSubmissionId, revisedPaperCode;
let metaSubmissionId;
let ungroupedTrackSubmissionId, ungroupedTrackPaperCode;

async function makeSubmission(trackId, paperCode, status) {
  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,$3,$4,$5,$6,$7) returning submission_id, paper_code",
    [conferenceId, "tad-author@example.com", "TAD Paper " + paperCode, paperCode, Math.floor(Math.random() * 9000) + 1000, status, trackId]
  );
  return sub.rows[0];
}

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, deadline_peer_review) values ($1,$2,$3) returning conference_id",
    ["TAD_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "2099-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from meta_reviewer_decision where submission_id in (select submission_id from submissions where conference_id = $1)", [conferenceId]);
    await pool.query("delete from peer_review where submission_id in (select submission_id from submissions where conference_id = $1)", [conferenceId]);
    await pool.query("delete from revised_submissions where submission_id in (select submission_id from submissions where conference_id = $1)", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_groups where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a new Track defaults to both decisions allowed, and GET manage-tracks shows both checked", async () => {
  const group = await pool.query("insert into conference_groups (conference_id, group_name) values ($1,'TAD Track') returning group_id", [conferenceId]);
  groupId = group.rows[0].group_id;

  const row = await pool.query("select allow_oral_decision, allow_poster_decision from conference_groups where group_id = $1", [groupId]);
  assert.equal(row.rows[0].allow_oral_decision, true);
  assert.equal(row.rows[0].allow_poster_decision, true);

  const track = await pool.query(
    "insert into conference_tracks (conference_id, group_id, track_name, track_reviewers, meta_reviewer) values ($1,$2,'TAD Subject Area',$3,$4) returning track_id",
    [conferenceId, groupId, [reviewerEmail], metaReviewerEmail]
  );
  const trackId = track.rows[0].track_id;

  const sub1 = await makeSubmission(trackId, "TAD01", "DESK ACCEPT");
  firstRoundSubmissionId = sub1.submission_id;
  firstRoundPaperCode = sub1.paper_code;

  const sub2 = await makeSubmission(trackId, "TAD02", "Submitted Revised Paper");
  revisedSubmissionId = sub2.submission_id;
  revisedPaperCode = sub2.paper_code;

  const sub3 = await makeSubmission(trackId, "TAD03", "DESK ACCEPT");
  metaSubmissionId = sub3.submission_id;

  const res = await get(`/chair/dashboard/manage-tracks/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  const checkedOral = new RegExp(`id="allowOral-${groupId}"[^>]*checked`).test(html);
  const checkedPoster = new RegExp(`id="allowPoster-${groupId}"[^>]*checked`).test(html);
  assert.ok(checkedOral, "Oral checkbox must start checked");
  assert.ok(checkedPoster, "Poster checkbox must start checked");
});

test("the chair cannot uncheck both - at least one must stay enabled", async () => {
  const res = await post(`/chair/dashboard/update-group-decisions/${groupId}`, chairToken, {});
  assert.equal(res.status, 302);
  assert.match(loc(res), /At least one decision option must stay enabled/);

  const row = await pool.query("select allow_oral_decision, allow_poster_decision from conference_groups where group_id = $1", [groupId]);
  assert.equal(row.rows[0].allow_oral_decision, true, "must be unchanged after a rejected update");
  assert.equal(row.rows[0].allow_poster_decision, true);
});

test("the chair disables Accepted for Oral Presentation for this Track", async () => {
  const res = await post(`/chair/dashboard/update-group-decisions/${groupId}`, chairToken, { allow_poster_decision: "on" });
  assert.equal(res.status, 302);
  assert.match(loc(res), /Allowed decisions updated/);

  const row = await pool.query("select allow_oral_decision, allow_poster_decision from conference_groups where group_id = $1", [groupId]);
  assert.equal(row.rows[0].allow_oral_decision, false);
  assert.equal(row.rows[0].allow_poster_decision, true);
});

test("GET review form no longer shows the Oral option, but Poster/Revision Required/Rejected remain", async () => {
  const res = await get(`/reviewer/dashboard/review/${firstRoundPaperCode}`, reviewerToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /Accepted for Oral Presentation/);
  assert.match(html, /Accepted for Poster Presentation/);
  assert.match(html, /Revision Required/);
  assert.match(html, /Rejected/);
});

test("GET re-review form also hides the Oral option", async () => {
  const res = await get(`/reviewer/dashboard/re-review/${revisedPaperCode}`, reviewerToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /Accepted for Oral Presentation/);
  assert.match(html, /Accepted for Poster Presentation/);
});

test("POST /mark-as-reviewed rejects the disallowed Oral decision even when posted directly, and writes no row", async () => {
  const res = await post("/mark-as-reviewed", reviewerToken, {
    submission_id: firstRoundSubmissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: "4", relevance_score: "4", technical_quality_score: "4", clarity_score: "4", impact_score: "4",
    remarks: "should never be saved",
  });
  assert.equal(res.status, 302);
  assert.match(loc(res), /That decision is not available for this subject area's Track/);

  const row = await pool.query("select 1 from peer_review where submission_id = $1", [firstRoundSubmissionId]);
  assert.equal(row.rows.length, 0, "no review row must have been written for a disallowed decision");
});

test("POST /mark-as-reviewed accepts the still-allowed Poster decision", async () => {
  const res = await post("/mark-as-reviewed", reviewerToken, {
    submission_id: firstRoundSubmissionId,
    conference_id: conferenceId,
    status: "Accepted for Poster Presentation",
    originality_score: "4", relevance_score: "4", technical_quality_score: "4", clarity_score: "4", impact_score: "4",
    remarks: "fine",
  });
  assert.equal(res.status, 302);
  assert.doesNotMatch(loc(res), /not available/);

  const row = await pool.query("select acceptance_status from peer_review where submission_id = $1", [firstRoundSubmissionId]);
  assert.equal(row.rows[0].acceptance_status, "Accepted for Poster Presentation");
});

test("POST /mark-as-re-reviewed also rejects the disallowed Oral decision, and writes no row", async () => {
  const res = await post("/mark-as-re-reviewed", reviewerToken, {
    submission_id: revisedSubmissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: "4", relevance_score: "4", technical_quality_score: "4", clarity_score: "4", impact_score: "4",
    remarks: "should never be saved",
  });
  assert.equal(res.status, 302);
  assert.match(loc(res), /That decision is not available for this subject area's Track/);

  const row = await pool.query("select 1 from revised_submissions where submission_id = $1", [revisedSubmissionId]);
  assert.equal(row.rows.length, 0);
});

test("GET and POST the meta-reviewer form also respect the Track's allowed decisions", async () => {
  const getRes = await get(`/meta-reviewer/dashboard/recommendation-submission/${metaSubmissionId}`, metaToken);
  // The completeness gate (every reviewer must have submitted) blocks this
  // page until a review exists - seed one directly so this test reaches
  // the actual code path being tested, not the unrelated gate.
  await pool.query(
    "insert into peer_review (conference_id, submission_id, reviewer, mean_score, review_status, acceptance_status) values ($1,$2,$3,4,'Reviewed','Accepted for Poster Presentation')",
    [conferenceId, metaSubmissionId, reviewerEmail]
  );

  const html = (await (await get(`/meta-reviewer/dashboard/recommendation-submission/${metaSubmissionId}`, metaToken)).text());
  assert.doesNotMatch(html, /Accepted for Oral Presentation/);
  assert.match(html, /Accepted for Poster Presentation/);

  const postRes = await post(`/submit-meta-reviewer-decision/${metaSubmissionId}`, metaToken, {
    status: "Accepted for Oral Presentation",
    remarks: "should never be saved",
  });
  assert.equal(postRes.status, 302);
  assert.match(loc(postRes), /That decision is not available for this subject area's Track/);

  const row = await pool.query("select 1 from meta_reviewer_decision where submission_id = $1", [metaSubmissionId]);
  assert.equal(row.rows.length, 0);
});

test("a subject area with no Track at all is never restricted", async () => {
  const track = await pool.query(
    "insert into conference_tracks (conference_id, group_id, track_name, track_reviewers) values ($1,NULL,'TAD Ungrouped',$2) returning track_id",
    [conferenceId, [reviewerEmail]]
  );
  const sub = await makeSubmission(track.rows[0].track_id, "TAD04", "DESK ACCEPT");
  ungroupedTrackSubmissionId = sub.submission_id;
  ungroupedTrackPaperCode = sub.paper_code;

  const res = await get(`/reviewer/dashboard/review/${ungroupedTrackPaperCode}`, reviewerToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Accepted for Oral Presentation/);
  assert.match(html, /Accepted for Poster Presentation/);
});
