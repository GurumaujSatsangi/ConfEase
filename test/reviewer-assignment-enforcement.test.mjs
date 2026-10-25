// Regression tests: per-paper reviewer assignment (reviewers_assigned_papers,
// set via /chair/dashboard/assign-papers/:id) correctly hid an unassigned
// paper from GET /reviewer/dashboard's listing, but the actual
// access-control routes underneath never checked the assignment at all -
// only track membership (isTrackReviewer). A reviewer on the track who
// knew (or guessed) another paper's paper_code - not secret, shared with
// authors - could still open and submit a review/re-review for a paper
// that was never assigned to them.
//
// Fixed with isAuthorizedReviewerForSubmission(), which adds the same
// "track has any assignment rows at all -> per-paper assignment is now
// required; otherwise track membership is enough" rule to all four
// routes: GET .../review/:id, GET .../re-review/:id, POST
// /mark-as-reviewed, POST /mark-as-re-reviewed.
//
// Uses the real routes and the real local Postgres database.

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
const assignedReviewerEmail = "rae-assigned@example.com";
const unassignedReviewerEmail = "rae-unassigned@example.com";

function reviewerToken(email, conferenceId) {
  return jwt.sign(
    { typ: "access", email, name: "RAE Test Reviewer", user_id: 1, role: "user", roles: { [conferenceId]: ["reviewer"] } },
    secret,
    { expiresIn: "5m" }
  );
}

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

let conferenceId;
let trackId; // has assignment rows - opted into per-paper assignment
let unassignedTrackId; // never used the assign-papers page - track membership alone must still work
let firstRoundSubmissionId, firstRoundPaperCode;
let revisedSubmissionId, revisedPaperCode;
let noAssignmentSubmissionId, noAssignmentPaperCode;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, deadline_peer_review) values ($1,$2,$3) returning conference_id",
    ["RAE_TEST_" + crypto.randomBytes(3).toString("hex"), "rae-test-chair@example.com", "2099-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, track_reviewers) values ($1,'RAE Track',$2) returning track_id",
    [conferenceId, [assignedReviewerEmail, unassignedReviewerEmail]]
  );
  trackId = track.rows[0].track_id;

  const unassignedTrack = await pool.query(
    "insert into conference_tracks (conference_id, track_name, track_reviewers) values ($1,'RAE No-Assignment Track',$2) returning track_id",
    [conferenceId, [unassignedReviewerEmail]]
  );
  unassignedTrackId = unassignedTrack.rows[0].track_id;

  const firstRound = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'RAE First Round','RAE01',501,'DESK ACCEPT',$3) returning submission_id, paper_code",
    [conferenceId, "rae-author-1@example.com", trackId]
  );
  firstRoundSubmissionId = firstRound.rows[0].submission_id;
  firstRoundPaperCode = firstRound.rows[0].paper_code;

  const revised = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'RAE Revised','RAE02',502,'Submitted Revised Paper',$3) returning submission_id, paper_code",
    [conferenceId, "rae-author-2@example.com", trackId]
  );
  revisedSubmissionId = revised.rows[0].submission_id;
  revisedPaperCode = revised.rows[0].paper_code;

  const noAssignment = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'RAE No Assignment','RAE03',503,'DESK ACCEPT',$3) returning submission_id, paper_code",
    [conferenceId, "rae-author-3@example.com", unassignedTrackId]
  );
  noAssignmentSubmissionId = noAssignment.rows[0].submission_id;
  noAssignmentPaperCode = noAssignment.rows[0].paper_code;

  // Only assignedReviewerEmail is assigned to either paper on `trackId` -
  // unassignedTrackId never gets any reviewers_assigned_papers rows at all.
  await pool.query(
    "insert into reviewers_assigned_papers (conference_id, submission_id, reviewer, track) values ($1,$2,$3,$4)",
    [conferenceId, firstRoundSubmissionId, assignedReviewerEmail, trackId]
  );
  await pool.query(
    "insert into reviewers_assigned_papers (conference_id, submission_id, reviewer, track) values ($1,$2,$3,$4)",
    [conferenceId, revisedSubmissionId, assignedReviewerEmail, trackId]
  );
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from peer_review where submission_id = ANY($1)", [[firstRoundSubmissionId, noAssignmentSubmissionId]]);
    await pool.query("delete from revised_submissions where submission_id = $1", [revisedSubmissionId]);
    await pool.query("delete from reviewers_assigned_papers where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("GET review form: an on-track but unassigned reviewer is blocked once the track has per-paper assignments", async () => {
  const token = reviewerToken(unassignedReviewerEmail, conferenceId);
  const res = await get(`/reviewer/dashboard/review/${firstRoundPaperCode}`, token);
  assert.equal(res.status, 302, "redirects to the reviewer dashboard with a SweetAlert message, instead of rendering a bare error page");
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /\/reviewer\/dashboard/);
  assert.match(location, /not assigned as a reviewer/i);
});

test("GET review form: the actually-assigned reviewer can open it normally", async () => {
  const token = reviewerToken(assignedReviewerEmail, conferenceId);
  const res = await get(`/reviewer/dashboard/review/${firstRoundPaperCode}`, token);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /not assigned as a reviewer/i);
});

test("POST /mark-as-reviewed: an unassigned reviewer cannot actually submit a review, even by calling the route directly", async () => {
  const token = reviewerToken(unassignedReviewerEmail, conferenceId);
  const res = await post("/mark-as-reviewed", token, {
    submission_id: firstRoundSubmissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: "4",
    relevance_score: "4",
    technical_quality_score: "4",
    clarity_score: "4",
    impact_score: "4",
    remarks: "should never be saved",
  });
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /not assigned as a reviewer/);

  const row = await pool.query("select 1 from peer_review where submission_id = $1 and reviewer = $2", [firstRoundSubmissionId, unassignedReviewerEmail]);
  assert.equal(row.rows.length, 0, "no review row must have been written for the unassigned reviewer");
});

test("GET re-review form: an on-track but unassigned reviewer is blocked for a revised paper too", async () => {
  const token = reviewerToken(unassignedReviewerEmail, conferenceId);
  const res = await get(`/reviewer/dashboard/re-review/${revisedPaperCode}`, token);
  assert.equal(res.status, 302, "redirects to the reviewer dashboard with a SweetAlert message, instead of rendering a bare error page");
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /\/reviewer\/dashboard/);
  assert.match(location, /not assigned as a reviewer/i);
});

test("POST /mark-as-re-reviewed: an unassigned reviewer cannot submit a re-review for a paper assigned to someone else", async () => {
  const token = reviewerToken(unassignedReviewerEmail, conferenceId);
  const res = await post("/mark-as-re-reviewed", token, {
    submission_id: revisedSubmissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: "4",
    relevance_score: "4",
    technical_quality_score: "4",
    clarity_score: "4",
    impact_score: "4",
    remarks: "should never be saved",
  });
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /not assigned as a reviewer/);

  const row = await pool.query("select 1 from revised_submissions where submission_id = $1 and reviewer = $2", [revisedSubmissionId, unassignedReviewerEmail]);
  assert.equal(row.rows.length, 0, "no re-review row must have been written for the unassigned reviewer");
});

test("a track that has never used per-paper assignment still lets any track reviewer through (unchanged backward-compatible behavior)", async () => {
  const token = reviewerToken(unassignedReviewerEmail, conferenceId);
  const res = await get(`/reviewer/dashboard/review/${noAssignmentPaperCode}`, token);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /not assigned as a reviewer/i);
});
