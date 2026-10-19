// Regression tests for the chair-side session dashboards and their Excel
// exports:
//   GET /chair/dashboard/manage-poster-sessions/:id (+ /export)
//   GET /chair/dashboard/manage-sessions/:id (+ /export)
//   GET /score-posters/:id (+ /export)
// All three share the loadPosterSessionsDashboardData /
// loadOralSessionsDashboardData helpers in api/index.js - these tests cover
// the leaderboard, the Final Camera Ready Papers list, Paper ID, and the
// exported workbook's contents.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import ExcelJS from "exceljs";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

// Mirrors the IST wall-clock math in checkSessionTimeWindow (api/index.js):
// given a UTC instant, returns the date/time strings that, read as IST,
// name that instant - so a session window built from "now ± 1h" is always
// open regardless of when/where the test suite runs.
function istWallClockFields(utcMs) {
  const d = new Date(utcMs + 5.5 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}
// poster_session has a single `date` column (no separate start/end dates -
// the real feature can't represent a session spanning midnight either), so
// a naive "now ± 1h" window broke whenever the suite happened to run
// within an hour of midnight IST (start and end landed on different
// calendar days, silently producing an inverted, always-closed window).
// Clamped to the current IST calendar day instead: still brackets "now"
// the rest of the time, and near midnight just gives an asymmetric but
// always-valid window.
const nowIst = istWallClockFields(Date.now());
const dayStartMs = Date.parse(`${nowIst.date}T00:00:00+05:30`);
const dayEndMs = Date.parse(`${nowIst.date}T23:59:00+05:30`);
const posterWindowStart = istWallClockFields(Math.max(Date.now() - 60 * 60 * 1000, dayStartMs));
const posterWindowEnd = istWallClockFields(Math.min(Date.now() + 60 * 60 * 1000, dayEndMs));

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "sessions-dash-test-chair@example.com";
const authorEmail = "sessions-dash-test-author@example.com";
const coordEmail = "sessions-dash-test-coord@example.com";
const panelistEmail = "sessions-dash-test-panelist@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Sessions Dash Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const coordToken = jwt.sign({ typ: "access", email: coordEmail, name: "Coordinator", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const panelistToken = jwt.sign({ typ: "access", email: panelistEmail, name: "Panelist", user_id: 4, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });

let conferenceId;
let trackId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["SESSIONS_DASH_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["Dash Author", authorEmail]);

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, panelists) values ($1,'Dash Track',ARRAY[$2]) returning track_id",
    [conferenceId, panelistEmail]
  );
  trackId = track.rows[0].track_id;

  // A window centered on "now" so /score-posters' time-window enforcement
  // (checkSessionTimeWindow in api/index.js) never blocks these tests.
  await pool.query(
    "insert into poster_session (conference_id, date, start_time, end_time, coodinators) values ($1,$2,$3,$4, ARRAY[$5])",
    [conferenceId, posterWindowStart.date, posterWindowStart.time, posterWindowEnd.time, coordEmail]
  );

  const fcrpPoster = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Dash Poster FCRP','DP01',201,'Submitted Final Camera Ready Paper for Poster Presentation',$3) returning submission_id",
    [conferenceId, authorEmail, trackId]
  );
  // score-posters only offers registered submissions for scoring (see
  // filterToRegisteredSubmissions in api/index.js) - manage-poster-sessions
  // (chair view, same shared loader) still shows every accepted submission
  // regardless of registration, so it doesn't need this row.
  await pool.query(
    "insert into registration (conference_id, submission_id, mode_of_presentation, attending_offline) values ($1,$2,'Poster',1)",
    [conferenceId, fcrpPoster.rows[0].submission_id]
  );
  const unregisteredFcrpPoster = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Dash Poster Unregistered','DP03',205,'Submitted Final Camera Ready Paper for Poster Presentation',$3) returning submission_id",
    [conferenceId, authorEmail, trackId]
  );
  const scoredPoster = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Dash Poster Scored','DP02',202,'Poster Scored',$3) returning submission_id",
    [conferenceId, authorEmail, trackId]
  );
  await pool.query("insert into final_camera_ready_submissions (submission_id, panelist_score) values ($1, 4.2)", [scoredPoster.rows[0].submission_id]);

  const oralFcrp = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Dash Oral FCRP','DO01',203,'Submitted Final Camera Ready Paper for Oral Presentation',$3) returning submission_id",
    [conferenceId, authorEmail, trackId]
  );
  // /panelist/active-session only shows registered submissions (see
  // api/index.js) - manage-sessions (chair view) isn't affected by this.
  await pool.query(
    "insert into registration (conference_id, submission_id, mode_of_presentation, attending_offline) values ($1,$2,'Oral',1)",
    [conferenceId, oralFcrp.rows[0].submission_id]
  );
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Dash Oral Unregistered','DO03',206,'Submitted Final Camera Ready Paper for Oral Presentation',$3)",
    [conferenceId, authorEmail, trackId]
  );
  const completedOral = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Dash Oral Completed','DO02',204,'Presentation Completed',$3) returning submission_id",
    [conferenceId, authorEmail, trackId]
  );
  await pool.query("insert into final_camera_ready_submissions (submission_id, panelist_score) values ($1, 3.6)", [completedOral.rows[0].submission_id]);
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from final_camera_ready_submissions where submission_id in (select submission_id from submissions where conference_id = $1)", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from poster_session where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  await pool.query("delete from users where email = $1", [authorEmail]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

async function readWorkbook(res) {
  const buffer = Buffer.from(await res.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test("manage-poster-sessions shows the leaderboard, the FCRP list, and Paper IDs for both", async () => {
  const res = await get(`/chair/dashboard/manage-poster-sessions/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Dash Poster FCRP/);
  assert.match(html, /Dash Poster Scored/);
  assert.match(html, /0201/);
  assert.match(html, /0202/);
  // Unlike score-posters, the chair view shows every accepted submission
  // regardless of registration, so a chair can follow up on it.
  assert.match(html, /Dash Poster Unregistered/);
  assert.match(html, /0205/);
});

test("manage-poster-sessions export has a Leaderboard sheet and an FCRP sheet with Paper IDs", async () => {
  const res = await get(`/chair/dashboard/manage-poster-sessions/${conferenceId}/export`, chairToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  const workbook = await readWorkbook(res);
  const leaderboardRows = [];
  workbook.getWorksheet("Leaderboard").eachRow((row, n) => { if (n > 1) leaderboardRows.push(row.values); });
  const fcrpRows = [];
  workbook.getWorksheet("Final Camera Ready Papers").eachRow((row, n) => { if (n > 1) fcrpRows.push(row.values); });

  assert.ok(leaderboardRows.some((r) => r[2] === "0202" && r[3] === "Dash Poster Scored"));
  assert.ok(fcrpRows.some((r) => r[1] === "0201" && r[2] === "Dash Poster FCRP"));
});

test("manage-sessions (oral) shows the per-track leaderboard, FCRP list, and Paper IDs", async () => {
  const res = await get(`/chair/dashboard/manage-sessions/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Dash Oral FCRP/);
  assert.match(html, /Dash Oral Completed/);
  assert.match(html, /0203/);
  assert.match(html, /0204/);
});

test("manage-sessions export has per-track Leaderboard and FCRP sheets with Paper IDs and resolved author names", async () => {
  const res = await get(`/chair/dashboard/manage-sessions/${conferenceId}/export`, chairToken);
  assert.equal(res.status, 200);

  const workbook = await readWorkbook(res);
  const leaderboardRows = [];
  workbook.getWorksheet("Leaderboard").eachRow((row, n) => { if (n > 1) leaderboardRows.push(row.values); });
  const fcrpRows = [];
  workbook.getWorksheet("Final Camera Ready Papers").eachRow((row, n) => { if (n > 1) fcrpRows.push(row.values); });

  const scoredRow = leaderboardRows.find((r) => r[3] === "0204");
  assert.ok(scoredRow, "the completed oral submission must appear in the leaderboard sheet");
  assert.equal(scoredRow[1], "Dash Track");

  const fcrpRow = fcrpRows.find((r) => r[2] === "0203");
  assert.ok(fcrpRow, "the FCRP oral submission must appear in the FCRP sheet");
  assert.match(fcrpRow[4], /Dash Author/, "author name must be resolved, not just the raw email");
});

test("a non-coordinator/non-panelist is blocked from score-posters", async () => {
  const strangerToken = jwt.sign({ typ: "access", email: "sessions-dash-test-stranger@example.com", name: "Stranger", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });
  const res = await get(`/score-posters/${conferenceId}`, strangerToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);
});

test("score-posters shows session details, leaderboard, and the FCRP scoring list with Paper IDs", async () => {
  const res = await get(`/score-posters/${conferenceId}`, coordToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Session Details/);
  assert.match(html, /View Leaderboard/);
  assert.match(html, /Dash Poster Scored/); // leaderboard
  assert.match(html, /Dash Poster FCRP/); // scoring list
  assert.match(html, /0201/);
  assert.match(html, /0202/);
  assert.ok(!html.includes("Dash Poster Unregistered"), "an accepted poster that was never registered must not be offered for scoring");
  assert.ok(!html.includes("0205"));
});

test("/panelist/active-session shows only registered final-camera-ready oral submissions", async () => {
  const res = await get(`/panelist/active-session/${conferenceId}`, panelistToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Dash Oral FCRP/);
  assert.match(html, /0203/);
  assert.ok(!html.includes("Dash Oral Unregistered"), "an accepted oral paper that was never registered must not appear in the active session");
  assert.ok(!html.includes("0206"));
});

// score-posters' session-time enforcement (checkSessionTimeWindow in
// api/index.js) - mirrors what /panelist/active-session already enforced
// for oral sessions, now applied to posters too. Each case gets its own
// conference/poster_session so it doesn't disturb the shared fixture above.
async function makeTimeWindowConference(date, startTime, endTime) {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["SESSIONS_DASH_TIME_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  const confId = conf.rows[0].conference_id;
  await pool.query(
    "insert into poster_session (conference_id, date, start_time, end_time, coodinators) values ($1,$2,$3,$4, ARRAY[$5])",
    [confId, date, startTime, endTime, coordEmail]
  );
  return confId;
}

test("score-posters redirects with 'Session not started yet' before the scheduled window", async () => {
  const future = istWallClockFields(Date.now() + 2 * 60 * 60 * 1000);
  const furtherFuture = istWallClockFields(Date.now() + 3 * 60 * 60 * 1000);
  const confId = await makeTimeWindowConference(future.date, future.time, furtherFuture.time);
  try {
    const res = await get(`/score-posters/${confId}`, coordToken);
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get("location") || ""), /Session not started yet/);
  } finally {
    await pool.query("delete from poster_session where conference_id = $1", [confId]);
    await pool.query("delete from conferences where conference_id = $1", [confId]);
  }
});

test("score-posters redirects with 'Session has ended' after the scheduled window", async () => {
  const past = istWallClockFields(Date.now() - 3 * 60 * 60 * 1000);
  const lessPast = istWallClockFields(Date.now() - 2 * 60 * 60 * 1000);
  const confId = await makeTimeWindowConference(past.date, past.time, lessPast.time);
  try {
    const res = await get(`/score-posters/${confId}`, coordToken);
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get("location") || ""), /Session has ended/);
  } finally {
    await pool.query("delete from poster_session where conference_id = $1", [confId]);
    await pool.query("delete from conferences where conference_id = $1", [confId]);
  }
});

test("score-posters loads normally when no poster session has been scheduled yet", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["SESSIONS_DASH_TIME_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  const confId = conf.rows[0].conference_id;
  await pool.query(
    "insert into poster_session (conference_id, coodinators) values ($1, ARRAY[$2])",
    [confId, coordEmail]
  );
  try {
    const res = await get(`/score-posters/${confId}`, coordToken);
    assert.equal(res.status, 200, "an unscheduled poster session must not block access");
  } finally {
    await pool.query("delete from poster_session where conference_id = $1", [confId]);
    await pool.query("delete from conferences where conference_id = $1", [confId]);
  }
});

test("score-posters export contains only the FCRP scoring list, with Paper IDs", async () => {
  const res = await get(`/score-posters/${conferenceId}/export`, coordToken);
  assert.equal(res.status, 200);

  const workbook = await readWorkbook(res);
  const rows = [];
  workbook.getWorksheet("Final Camera Ready Papers").eachRow((row, n) => { if (n > 1) rows.push(row.values); });

  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], "0201");
  assert.equal(rows[0][2], "Dash Poster FCRP");
});
