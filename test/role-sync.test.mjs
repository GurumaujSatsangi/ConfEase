// Regression tests for conference_roles being kept in sync when a chair
// edits a subject area's reviewer/session-chair list, or deletes a subject
// area outright. Previously, updating conference_tracks.track_reviewers/
// panelists never touched conference_roles at all: a newly added reviewer
// got no role row (so their JWT never grants "reviewer" and
// /reviewer/dashboard rejected them), and a removed reviewer kept their
// stale role forever. Uses the real routes, the real local Postgres
// database, and the real Redis connection (role checks don't depend on
// Redis, but the app connects to it regardless when not in VERCEL=1 mode).

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
const chairEmail = "role-sync-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Role Sync Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${chairToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

// Location header values come back percent-encoded (e.g. "%20" for spaces);
// decode before matching against a plain-text pattern.
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

const roles = async (conferenceId) =>
  (await pool.query("select lower(email_id) as email_id, role from conference_roles where conference_id = $1", [conferenceId])).rows;

async function createConference() {
  const r = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["ROLE_SYNC_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  return r.rows[0].conference_id;
}

async function createTrack(conferenceId, { reviewers = [], panelists = [] } = {}) {
  const r = await pool.query(
    `insert into conference_tracks
       (track_name, conference_id, track_reviewers, panelists, presentation_date, presentation_start_time, presentation_end_time)
     values ($1,$2,$3,$4,'2027-01-01','10:00','11:00') returning track_id`,
    ["Subject_" + crypto.randomBytes(3).toString("hex"), conferenceId, reviewers, panelists]
  );
  const trackId = r.rows[0].track_id;
  // Idempotent insert: a test may seed the same email onto two tracks in one
  // conference, and conference_roles has no unique constraint to rely on -
  // avoid seeding duplicate rows ourselves, which would skew "exact role
  // set" assertions unrelated to what's actually being tested here.
  for (const email of reviewers) {
    const exists = await pool.query("select 1 from conference_roles where conference_id=$1 and lower(email_id)=lower($2) and role=$3", [conferenceId, email, "reviewer"]);
    if (exists.rows.length === 0) await pool.query("insert into conference_roles values($1,$2,$3)", [conferenceId, email, "reviewer"]);
  }
  for (const email of panelists) {
    const exists = await pool.query("select 1 from conference_roles where conference_id=$1 and lower(email_id)=lower($2) and role=$3", [conferenceId, email, "session_chair"]);
    if (exists.rows.length === 0) await pool.query("insert into conference_roles values($1,$2,$3)", [conferenceId, email, "session_chair"]);
  }
  return trackId;
}

const createdConferences = [];
async function cleanup(conferenceId) {
  await pool.query("delete from conference_roles where conference_id = $1", [conferenceId]);
  await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
  await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
}

after(async () => {
  for (const id of createdConferences) await cleanup(id);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("update-track: removing a reviewer revokes their role; adding one grants it", async () => {
  const conferenceId = await createConference();
  createdConferences.push(conferenceId);
  const trackId = await createTrack(conferenceId, { reviewers: ["a@example.com", "b@example.com"] });

  assert.deepEqual(
    (await roles(conferenceId)).map((r) => r.email_id).sort(),
    ["a@example.com", "b@example.com"],
    "sanity: both reviewers start with the role"
  );

  const res = await post(`/chair/dashboard/update-track/${trackId}`, {
    track_title: "Updated Subject Area",
    reviewers: "b@example.com, c@example.com",
    session_date: "2027-01-02",
    start_time: "09:00",
    end_time: "10:00",
    panelists: "",
  });
  assert.equal(res.status, 302);
  assert.match(loc(res), /Track updated successfully/);

  const after = (await roles(conferenceId)).filter((r) => r.role === "reviewer").map((r) => r.email_id).sort();
  assert.deepEqual(after, ["b@example.com", "c@example.com"], "a@ must be revoked, b@ kept, c@ newly granted");
});

test("update-track: a reviewer still assigned to another subject area in the same conference keeps their role", async () => {
  const conferenceId = await createConference();
  createdConferences.push(conferenceId);
  const trackToEdit = await createTrack(conferenceId, { reviewers: ["shared@example.com"] });
  await createTrack(conferenceId, { reviewers: ["shared@example.com"] }); // second subject area, same reviewer

  const res = await post(`/chair/dashboard/update-track/${trackToEdit}`, {
    track_title: "Updated Subject Area",
    reviewers: "", // remove shared@ from THIS subject area entirely
    session_date: "2027-01-02",
    start_time: "09:00",
    end_time: "10:00",
    panelists: "",
  });
  assert.equal(res.status, 302);

  const after = (await roles(conferenceId)).filter((r) => r.role === "reviewer").map((r) => r.email_id);
  assert.deepEqual(after, ["shared@example.com"], "role must survive because the other subject area still lists them");
});

test("update-track: session-chair (panelists) list is synced the same way", async () => {
  const conferenceId = await createConference();
  createdConferences.push(conferenceId);
  const trackId = await createTrack(conferenceId, { panelists: ["old-chair@example.com"] });

  await post(`/chair/dashboard/update-track/${trackId}`, {
    track_title: "Updated Subject Area",
    reviewers: "",
    session_date: "2027-01-02",
    start_time: "09:00",
    end_time: "10:00",
    panelists: "new-chair@example.com",
  });

  const after = (await roles(conferenceId)).filter((r) => r.role === "session_chair").map((r) => r.email_id);
  assert.deepEqual(after, ["new-chair@example.com"]);
});

test("delete-track: revokes roles for everyone who isn't also assigned to another subject area", async () => {
  const conferenceId = await createConference();
  createdConferences.push(conferenceId);
  const trackToDelete = await createTrack(conferenceId, { reviewers: ["solo@example.com", "shared@example.com"] });
  await createTrack(conferenceId, { reviewers: ["shared@example.com"] });

  const res = await post(`/chair/dashboard/delete-track/${trackToDelete}`, {});
  assert.equal(res.status, 302);
  assert.match(loc(res), /Track Deleted/);

  const after = (await roles(conferenceId)).filter((r) => r.role === "reviewer").map((r) => r.email_id);
  assert.deepEqual(after, ["shared@example.com"], "solo@ (only on the deleted subject area) must lose the role; shared@ (also on the other one) must keep it");
});

test("set-poster-session: removed coordinators lose the role, re-saving the same list doesn't duplicate rows", async () => {
  const conferenceId = await createConference();
  createdConferences.push(conferenceId);
  await pool.query(
    "insert into poster_session (conference_id, date, start_time, end_time, coodinators) values ($1,null,null,null,ARRAY[]::text[])",
    [conferenceId]
  );

  await post(`/chair/dashboard/set-poster-session/${conferenceId}`, {
    conference_id: conferenceId,
    session_date: "2027-01-01",
    start_time: "10:00",
    end_time: "11:00",
    coordinators: "x@example.com, y@example.com",
  });
  const firstPass = (await roles(conferenceId)).filter((r) => r.role === "poster_presentation_coordinator").map((r) => r.email_id).sort();
  assert.deepEqual(firstPass, ["x@example.com", "y@example.com"]);

  // Re-save with the SAME list - must not create duplicate rows.
  await post(`/chair/dashboard/set-poster-session/${conferenceId}`, {
    conference_id: conferenceId,
    session_date: "2027-01-01",
    start_time: "10:00",
    end_time: "11:00",
    coordinators: "x@example.com, y@example.com",
  });
  const afterResave = (await roles(conferenceId)).filter((r) => r.role === "poster_presentation_coordinator");
  assert.equal(afterResave.length, 2, "re-saving the identical list must not duplicate role rows");

  // Now drop y@, keep x@.
  await post(`/chair/dashboard/set-poster-session/${conferenceId}`, {
    conference_id: conferenceId,
    session_date: "2027-01-01",
    start_time: "10:00",
    end_time: "11:00",
    coordinators: "x@example.com",
  });
  const afterRemoval = (await roles(conferenceId)).filter((r) => r.role === "poster_presentation_coordinator").map((r) => r.email_id);
  assert.deepEqual(afterRemoval, ["x@example.com"], "y@ must be revoked once removed from the coordinator list");

  await pool.query("delete from poster_session where conference_id = $1", [conferenceId]);
});
