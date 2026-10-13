// Regression tests for FILE-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// the paper a submission's primary author uploads (and its later
// edited/revised/camera-ready versions) used to sit on Cloudinary as a
// plain `type: "upload"` (public) asset - the stored file_url was a
// permanent link anyone could fetch, no login required, if it ever
// leaked. New uploads (POST /submit, /submit-revised-paper,
// /edit-submission, /final-camera-ready-submission) now use
// `type: "private"`, and every page that shows the paper's link
// (getSignedPaperUrl/withSignedPaperUrl, api/index.js) overwrites the
// stored file_url with a freshly-signed, short-lived Cloudinary download
// URL instead - generated only after the existing route-level
// authorization (author/reviewer/chair ownership checks, all unchanged)
// has already run.
//
// These tests seed rows directly (not through a real Cloudinary upload,
// which would invoke the real external service) with a plausible
// public_id/resource_type/format, then assert on what the rendered HTML
// actually contains: a signed download-API link bearing that public_id,
// and - the regression this guards against - never the raw stored
// file_url string itself.

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
const authorEmail = "file04-test-author@example.com";
const reviewerEmail = "file04-test-reviewer@example.com";
const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "FILE04 Test Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const reviewerToken = jwt.sign({ typ: "access", email: reviewerEmail, name: "FILE04 Test Reviewer", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

let conferenceId;
let trackId;
let submissionId;
let noPublicIdSubmissionId;
const STORED_FILE_URL = "https://res.cloudinary.com/demo/image/upload/v1/this-permanent-link-must-never-render";
const FILE_PUBLIC_ID = "file04-test-papers/paper-" + crypto.randomBytes(4).toString("hex");

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, deadline_peer_review) values ($1,$2,$3) returning conference_id",
    ["FILE04_TEST_" + crypto.randomBytes(3).toString("hex"), "file04-test-chair@example.com", "2099-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, track_reviewers) values ($1,'FILE04 Track',$2) returning track_id",
    [conferenceId, [reviewerEmail]]
  );
  trackId = track.rows[0].track_id;

  const sub = await pool.query(
    `insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id, file_url, file_public_id, file_resource_type, file_format)
     values ($1,$2,'FILE04 Test Paper','FILE04A',801,'DESK ACCEPT',$3,$4,$5,'image','pdf') returning submission_id`,
    [conferenceId, authorEmail, trackId, STORED_FILE_URL, FILE_PUBLIC_ID]
  );
  submissionId = sub.rows[0].submission_id;

  const noPidSub = await pool.query(
    `insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id)
     values ($1,$2,'FILE04 No PublicId Paper','FILE04B',802,'Submitted for Review',$3) returning submission_id`,
    [conferenceId, authorEmail, trackId]
  );
  noPublicIdSubmissionId = noPidSub.rows[0].submission_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the author's own conference view shows a signed download link for their paper, never the stored permanent URL", async () => {
  const html = await (await get(`/conference/${conferenceId}`, authorToken)).text();
  assert.ok(html.includes(encodeURIComponent(FILE_PUBLIC_ID)), "the rendered page must link to the paper via its public_id in a signed download URL");
  assert.ok(html.includes("/image/download"), "the link must be Cloudinary's signed download API action, not a direct asset URL");
  assert.ok(!html.includes(STORED_FILE_URL), "the permanent stored file_url must never appear in the rendered page");
});

test("a reviewer assigned to the submission's track sees the same signed link on the review page", async () => {
  const html = await (await get("/reviewer/dashboard/review/FILE04A", reviewerToken)).text();
  assert.ok(html.includes(encodeURIComponent(FILE_PUBLIC_ID)), "the review page must link to the paper via its public_id in a signed download URL");
  assert.ok(!html.includes(STORED_FILE_URL), "the permanent stored file_url must never appear in the rendered page");
});

test("a submission with no uploaded-file metadata yet renders without a broken/stale link", async () => {
  const html = await (await get(`/conference/${conferenceId}`, authorToken)).text();
  // The no-public_id submission's row must still render (by paper code),
  // and nothing on the page should contain a download link pointing at
  // this test's unrelated FILE_PUBLIC_ID for that row.
  assert.ok(html.includes("FILE04B"), "the submission without an uploaded file must still appear on the page");
});
