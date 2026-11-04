// Regression tests for two related changes to the chair's "Manage Oral
// Presentation Sessions" page (GET /chair/dashboard/manage-sessions/:id):
// 1. Subject areas are now grouped under a Track-level accordion ("Track:
//    Subject Area" labeling, matching the convention used elsewhere), with
//    an inner accordion per subject area - instead of one flat list.
// 2. A Track whose chair-set Allowed Decisions (conference_groups) only
//    permit "Accepted for Poster Presentation" (allow_oral_decision =
//    false) is excluded from this page entirely - it can never have a
//    submission reach an oral decision, so there is nothing to schedule.
//    An ungrouped subject area (no Track) always stays, since nothing
//    restricts it.

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
const chairEmail = "osg-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

let conferenceId, oralGroupId, posterOnlyGroupId, oralTrackId, posterOnlyTrackId, ungroupedTrackId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["OSG_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const oralGroup = await pool.query(
    "insert into conference_groups (conference_id, group_name) values ($1,'OSG Oral Track') returning group_id",
    [conferenceId]
  );
  oralGroupId = oralGroup.rows[0].group_id;

  const posterOnlyGroup = await pool.query(
    "insert into conference_groups (conference_id, group_name, allow_oral_decision, allow_poster_decision) values ($1,'OSG Poster-Only Track',false,true) returning group_id",
    [conferenceId]
  );
  posterOnlyGroupId = posterOnlyGroup.rows[0].group_id;

  const oralTrack = await pool.query(
    "insert into conference_tracks (conference_id, group_id, track_name) values ($1,$2,'OSG Oral Subject Area') returning track_id",
    [conferenceId, oralGroupId]
  );
  oralTrackId = oralTrack.rows[0].track_id;

  const posterOnlyTrack = await pool.query(
    "insert into conference_tracks (conference_id, group_id, track_name) values ($1,$2,'OSG Poster-Only Subject Area') returning track_id",
    [conferenceId, posterOnlyGroupId]
  );
  posterOnlyTrackId = posterOnlyTrack.rows[0].track_id;

  const ungroupedTrack = await pool.query(
    "insert into conference_tracks (conference_id, track_name) values ($1,'OSG Ungrouped Subject Area') returning track_id",
    [conferenceId]
  );
  ungroupedTrackId = ungroupedTrack.rows[0].track_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_groups where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("manage-sessions shows the Track name and nests each subject area's accordion under it", async () => {
  const res = await get(`/chair/dashboard/manage-sessions/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Track: OSG Oral Track/, "the Track's own accordion header must show its name");
  assert.match(html, /OSG Oral Subject Area/);
});

test("manage-sessions excludes a Track whose Allowed Decisions are poster-only", async () => {
  const res = await get(`/chair/dashboard/manage-sessions/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /OSG Poster-Only Track/, "a poster-only Track must not appear on the oral sessions page");
  assert.doesNotMatch(html, /OSG Poster-Only Subject Area/, "its subject area must not appear either");
});

test("manage-sessions still shows an ungrouped subject area (no Track restricts it)", async () => {
  const res = await get(`/chair/dashboard/manage-sessions/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Subject Areas \(No Track\)/);
  assert.match(html, /OSG Ungrouped Subject Area/);
});

test("manage-sessions export excludes the poster-only Track's subject area and labels the oral one as 'Track: Subject Area'", async () => {
  // Seed a presentation-completed submission on the oral track so the
  // leaderboard sheet actually has a row to check the label on.
  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["OSG Author", "osg-author@example.com"]);
  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'OSG Paper','OSGPAPER1',901,'Presentation Completed',$3) returning submission_id",
    [conferenceId, "osg-author@example.com", oralTrackId]
  );
  await pool.query(
    "insert into peer_review (conference_id, submission_id, reviewer, mean_score, review_status, acceptance_status) values ($1,$2,$3,4,'Reviewed','Accepted')",
    [conferenceId, sub.rows[0].submission_id, "osg-reviewer@example.com"]
  );

  const res = await get(`/chair/dashboard/manage-sessions/${conferenceId}/export`, chairToken);
  assert.equal(res.status, 200);
  const buffer = Buffer.from(await res.arrayBuffer());

  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const leaderboardSheet = workbook.getWorksheet("Leaderboard");
  const rows = [];
  leaderboardSheet.eachRow({ includeEmpty: false }, (row) => rows.push(row.values));
  const trackNames = rows.map((r) => r[1]);
  assert.ok(trackNames.includes("OSG Oral Track: OSG Oral Subject Area"), "the exported row must use the Track: Subject Area label");
  assert.ok(!trackNames.some((n) => String(n).includes("Poster-Only")), "no poster-only Track data should appear in the oral export");

  await pool.query("delete from peer_review where submission_id = $1", [sub.rows[0].submission_id]);
  await pool.query("delete from submissions where submission_id = $1", [sub.rows[0].submission_id]);
  await pool.query("delete from users where email = $1", ["osg-author@example.com"]);
});
