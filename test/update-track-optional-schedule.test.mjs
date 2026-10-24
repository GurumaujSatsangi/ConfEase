// Regression test: views/chair/manage-tracks.ejs made session_date/
// start_time/end_time optional on the "update subject area" form (a chair
// can save reviewers/panelists before the presentation slot is scheduled),
// but POST /chair/dashboard/update-track/:trackId passed those straight
// through to date/time-typed Postgres columns (conference_tracks.
// presentation_date/presentation_start_time/presentation_end_time), which
// reject an empty string outright ("invalid input syntax for type date:
// \"\"") instead of treating it as absent - so leaving them blank still
// failed, just with a generic "Failed to update Track!" instead of the
// browser blocking submission. Fixed by coercing blank strings to null,
// matching the existing vc_link pattern on the same route.

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
const chairEmail = "uts-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${chairToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId;
let trackId;

after(async () => {
  if (conferenceId) {
    await pool.query("delete from conference_roles where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("update-track: leaving session_date/start_time/end_time blank succeeds and clears them, instead of a Postgres type error", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["UPDATE_TRACK_SCHED_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    `insert into conference_tracks
       (track_name, conference_id, presentation_date, presentation_start_time, presentation_end_time)
     values ($1,$2,'2027-01-01','10:00','11:00') returning track_id`,
    ["Schedule_Test_" + crypto.randomBytes(3).toString("hex"), conferenceId]
  );
  trackId = track.rows[0].track_id;

  const res = await post(`/chair/dashboard/update-track/${trackId}`, {
    track_title: "Updated Subject Area",
    reviewers: "",
    session_date: "",
    start_time: "",
    end_time: "",
    panelists: "",
  });

  assert.equal(res.status, 302);
  assert.match(loc(res), /Track updated successfully/, "a blank schedule must not fail the save");

  const row = await pool.query(
    "select presentation_date, presentation_start_time, presentation_end_time from conference_tracks where track_id = $1",
    [trackId]
  );
  assert.equal(row.rows[0].presentation_date, null);
  assert.equal(row.rows[0].presentation_start_time, null);
  assert.equal(row.rows[0].presentation_end_time, null);
});

test("update-track: a real schedule is still saved correctly (no regression)", async () => {
  const res = await post(`/chair/dashboard/update-track/${trackId}`, {
    track_title: "Updated Subject Area",
    reviewers: "",
    session_date: "2027-03-15",
    start_time: "09:30",
    end_time: "10:30",
    panelists: "",
  });

  assert.equal(res.status, 302);
  assert.match(loc(res), /Track updated successfully/);

  const row = await pool.query(
    "select presentation_date, presentation_start_time, presentation_end_time from conference_tracks where track_id = $1",
    [trackId]
  );
  assert.ok(String(row.rows[0].presentation_date).startsWith("2027-03-15"));
  assert.equal(String(row.rows[0].presentation_start_time).slice(0, 5), "09:30");
  assert.equal(String(row.rows[0].presentation_end_time).slice(0, 5), "10:30");
});
