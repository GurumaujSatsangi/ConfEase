// Regression tests for the chair's "Change Track/Subject Area" action on
// the Manage Submissions page: a chair can move a submission to a
// different subject area of the same conference by posting a new
// track_id, with ownership checks on both the submission's conference and
// the target track, and a cache invalidation so the change shows up on
// the author's dashboard immediately.

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
const chairEmail = "cst-test-chair@example.com";
const otherChairEmail = "cst-test-other-chair@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const otherChairToken = jwt.sign({ typ: "chair", email: otherChairEmail, name: "Other Chair", user_id: 2, role: "chair" }, secret, { expiresIn: "5m" });

const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId, trackAId, trackBId, otherConferenceId, otherTrackId, submissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, acceptance_notification) values ($1,$2,$3) returning conference_id",
    ["CST_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "01-01-2099"]
  );
  conferenceId = conf.rows[0].conference_id;

  const group = await pool.query("insert into conference_groups (conference_id, group_name) values ($1,'CST Track') returning group_id", [conferenceId]);

  const trackA = await pool.query(
    "insert into conference_tracks (conference_id, group_id, track_name) values ($1,$2,'CST Subject Area A') returning track_id",
    [conferenceId, group.rows[0].group_id]
  );
  trackAId = trackA.rows[0].track_id;

  const trackB = await pool.query(
    "insert into conference_tracks (conference_id, track_name) values ($1,'CST Subject Area B') returning track_id",
    [conferenceId]
  );
  trackBId = trackB.rows[0].track_id;

  const otherConf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["CST_OTHER_" + crypto.randomBytes(3).toString("hex"), otherChairEmail]
  );
  otherConferenceId = otherConf.rows[0].conference_id;
  const otherTrack = await pool.query(
    "insert into conference_tracks (conference_id, track_name) values ($1,'CST Other Conference Track') returning track_id",
    [otherConferenceId]
  );
  otherTrackId = otherTrack.rows[0].track_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,$3,$4,$5,$6,$7) returning submission_id",
    [conferenceId, "cst-author@example.com", "CST Paper", "CST01", Math.floor(Math.random() * 9000) + 1000, "Submitted for Review", trackAId]
  );
  submissionId = sub.rows[0].submission_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_groups where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  if (otherConferenceId) {
    await pool.query("delete from conference_tracks where conference_id = $1", [otherConferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [otherConferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the view-submissions page labels subject areas as 'Track: Subject Area' in the Change Track modal", async () => {
  const res = await get(`/chair/dashboard/view-submissions/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /CST Track: CST Subject Area A/);
  assert.match(html, /CST Subject Area B/);
});

test("a chair moves a submission to a different subject area of the same conference", async () => {
  const res = await post(`/chair/dashboard/change-submission-track/${submissionId}`, chairToken, { track_id: trackBId });
  assert.equal(res.status, 302);
  assert.match(loc(res), /Subject Area updated successfully/);

  const row = await pool.query("select track_id from submissions where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].track_id, trackBId);
});

test("a chair cannot move a submission to a track belonging to a different conference", async () => {
  const res = await post(`/chair/dashboard/change-submission-track/${submissionId}`, chairToken, { track_id: otherTrackId });
  assert.equal(res.status, 302);
  assert.match(loc(res), /Invalid Subject Area selected/);

  const row = await pool.query("select track_id from submissions where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].track_id, trackBId, "must be unchanged after a rejected update");
});

test("a chair who does not own the conference cannot change the submission's track", async () => {
  const res = await post(`/chair/dashboard/change-submission-track/${submissionId}`, otherChairToken, { track_id: trackAId });
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized/);

  const row = await pool.query("select track_id from submissions where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].track_id, trackBId, "must be unchanged after a rejected update");
});
