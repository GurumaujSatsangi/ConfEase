// Regression tests for the new per-paper reviewer assignment feature:
// - GET/POST /chair/dashboard/assign-papers/:id lets a chair assign each
//   submission in a subject area to one specific reviewer
//   (reviewers_assigned_papers), editable later on the same page (an
//   upsert keyed on submission_id, backed by the unique index added in
//   migration 026).
// - GET /reviewer/dashboard then shows a reviewer only the submissions
//   assigned to them specifically, once a track has ANY assignment rows
//   at all - a track that has never used this page keeps the old
//   "every reviewer sees every submission on the track" behavior.
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
const chairEmail = "assign-papers-chair@example.com";
const otherChairEmail = "assign-papers-other@example.com";
const reviewerAEmail = "ap-reviewer-a@example.com";
const reviewerBEmail = "ap-reviewer-b@example.com";
const reviewerCEmail = "ap-reviewer-c@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Assign Papers Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const otherChairToken = jwt.sign({ typ: "chair", email: otherChairEmail, name: "Other Chair", user_id: 2, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

let conferenceId;
let trackId; // reviewers: A, B - assignments will be used here
let sub1, sub2, sub3;
let trackId2; // reviewers: C - never assigned, must keep the old "sees everything" behavior
let sub4, sub5;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["AP_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, track_reviewers) values ($1,$2,$3) returning track_id",
    [conferenceId, "AP Track " + crypto.randomBytes(2).toString("hex"), [reviewerAEmail, reviewerBEmail]]
  );
  trackId = track.rows[0].track_id;

  const track2 = await pool.query(
    "insert into conference_tracks (conference_id, track_name, track_reviewers) values ($1,$2,$3) returning track_id",
    [conferenceId, "AP Track2 " + crypto.randomBytes(2).toString("hex"), [reviewerCEmail]]
  );
  trackId2 = track2.rows[0].track_id;

  const makeSubmission = async (track, paperNumber, author) => {
    const sub = await pool.query(
      "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'AP Test Paper',$3,$4,'Submitted for Review',$5) returning submission_id",
      [conferenceId, author, "AP" + crypto.randomBytes(3).toString("hex"), paperNumber, track]
    );
    return sub.rows[0].submission_id;
  };

  sub1 = await makeSubmission(trackId, 1, "ap-author-1@example.com");
  sub2 = await makeSubmission(trackId, 2, "ap-author-2@example.com");
  sub3 = await makeSubmission(trackId, 3, "ap-author-3@example.com");
  sub4 = await makeSubmission(trackId2, 4, "ap-author-4@example.com");
  sub5 = await makeSubmission(trackId2, 5, "ap-author-5@example.com");
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from reviewers_assigned_papers where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("GET assign-papers renders every paper on the track and both reviewers as dropdown options", async () => {
  const res = await get(`/chair/dashboard/assign-papers/${trackId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /0001/);
  assert.match(html, /0002/);
  assert.match(html, /0003/);
  assert.match(html, new RegExp(reviewerAEmail));
  assert.match(html, new RegExp(reviewerBEmail));
});

test("a chair who does not own this conference is blocked", async () => {
  const res = await get(`/chair/dashboard/assign-papers/${trackId}`, otherChairToken);
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location"));
  assert.match(location, /not authorized/);
});

test("POST saves each paper's assignment, ignores a reviewer not on this track, and re-saving updates rather than duplicating", async () => {
  const firstSave = await post(`/chair/dashboard/assign-papers/${trackId}`, chairToken, {
    [`reviewer_${sub1}`]: reviewerAEmail,
    [`reviewer_${sub2}`]: reviewerBEmail,
    [`reviewer_${sub3}`]: "someone-not-on-this-track@example.com", // must be ignored
  });
  assert.equal(firstSave.status, 302);

  let rows = await pool.query("select submission_id, reviewer from reviewers_assigned_papers where track = $1 order by submission_id", [trackId]);
  assert.equal(rows.rows.length, 2, "only the two valid assignments must be saved; the untrusted reviewer value must be ignored");
  const bySubmission = Object.fromEntries(rows.rows.map((r) => [r.submission_id, r.reviewer]));
  assert.equal(bySubmission[sub1], reviewerAEmail);
  assert.equal(bySubmission[sub2], reviewerBEmail);
  assert.ok(!(sub3 in bySubmission));

  // Re-save with sub1 reassigned to reviewer B - must update the existing
  // row (unique index on submission_id), not insert a duplicate.
  const secondSave = await post(`/chair/dashboard/assign-papers/${trackId}`, chairToken, {
    [`reviewer_${sub1}`]: reviewerBEmail,
    [`reviewer_${sub2}`]: reviewerBEmail,
  });
  assert.equal(secondSave.status, 302);

  rows = await pool.query("select submission_id, reviewer from reviewers_assigned_papers where track = $1", [trackId]);
  assert.equal(rows.rows.length, 2, "re-saving must update existing rows, not create duplicates");
  const updated = Object.fromEntries(rows.rows.map((r) => [r.submission_id, r.reviewer]));
  assert.equal(updated[sub1], reviewerBEmail, "sub1's assignment must have been updated to reviewer B");
});

test("POST with a paper left unassigned clears any existing assignment for it", async () => {
  await post(`/chair/dashboard/assign-papers/${trackId}`, chairToken, {
    [`reviewer_${sub1}`]: reviewerAEmail,
    [`reviewer_${sub2}`]: "", // explicitly cleared back to Unassigned
  });

  const row = await pool.query("select 1 from reviewers_assigned_papers where submission_id = $1", [sub2]);
  assert.equal(row.rows.length, 0, "clearing a paper's reviewer must delete its assignment row");
});

test("reviewer dashboard: once a track has any assignment, each reviewer sees only their own assigned papers on it", async () => {
  // From the prior test: sub1 -> reviewer A, sub2 -> unassigned (cleared).
  const reviewerAToken = jwt.sign(
    { typ: "access", email: reviewerAEmail, name: "Reviewer A", user_id: 10, role: "user", roles: { [conferenceId]: ["reviewer"] } },
    secret,
    { expiresIn: "5m" }
  );
  const reviewerBToken = jwt.sign(
    { typ: "access", email: reviewerBEmail, name: "Reviewer B", user_id: 11, role: "user", roles: { [conferenceId]: ["reviewer"] } },
    secret,
    { expiresIn: "5m" }
  );

  const htmlA = await (await get("/reviewer/dashboard", reviewerAToken)).text();
  assert.match(htmlA, /0001/, "reviewer A must see their assigned paper 0001");
  assert.doesNotMatch(htmlA, /0003/, "reviewer A must not see paper 0003, which was never assigned to them");

  const htmlB = await (await get("/reviewer/dashboard", reviewerBToken)).text();
  assert.doesNotMatch(htmlB, /0001/, "reviewer B must not see paper 0001, which is assigned to reviewer A");
});

test("reviewer dashboard: a track with no assignment rows at all still shows every submission to every reviewer (unchanged fallback)", async () => {
  const reviewerCToken = jwt.sign(
    { typ: "access", email: reviewerCEmail, name: "Reviewer C", user_id: 12, role: "user", roles: { [conferenceId]: ["reviewer"] } },
    secret,
    { expiresIn: "5m" }
  );

  const html = await (await get("/reviewer/dashboard", reviewerCToken)).text();
  assert.match(html, /0004/, "with no assignments configured for this track, every submission must stay visible");
  assert.match(html, /0005/, "with no assignments configured for this track, every submission must stay visible");
});
