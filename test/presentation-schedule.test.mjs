// Regression tests for the presentation-schedule display on the author's
// "My Submissions" table (GET /conference/:id): once a final camera-ready
// paper is submitted, the status cell shows the poster/oral schedule (or a
// "not released yet" placeholder), and the action cell swaps to a
// Registration/Register link. Uses the real route and the real local
// Postgres database.

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
const authorEmail = "schedule-test-author@example.com";
const token = jwt.sign({ typ: "access", email: authorEmail, name: "Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

let conferenceId;
after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from poster_session where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("conference page shows the poster/oral schedule under the status, and a Register link once in it", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["SCHEDULE_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  const scheduledTrack = await pool.query(
    "insert into conference_tracks (track_name, conference_id, presentation_date, presentation_start_time, presentation_end_time) values ('T1',$1,'2027-03-05','09:30','10:15') returning track_id",
    [conferenceId]
  );
  const unscheduledTrack = await pool.query(
    "insert into conference_tracks (track_name, conference_id) values ('T2',$1) returning track_id",
    [conferenceId]
  );
  await pool.query(
    "insert into poster_session (conference_id, date, start_time, end_time, coodinators) values ($1,'2027-03-06','14:00','16:00',ARRAY[]::text[])",
    [conferenceId]
  );

  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, track_id) values ($1,$2,'Oral scheduled','SCHA','Submitted Final Camera Ready Paper for Oral Presentation',$3)",
    [conferenceId, authorEmail, scheduledTrack.rows[0].track_id]
  );
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, track_id) values ($1,$2,'Oral unscheduled','SCHB','Submitted Final Camera Ready Paper for Oral Presentation',$3)",
    [conferenceId, authorEmail, unscheduledTrack.rows[0].track_id]
  );
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Poster scheduled','SCHC','Submitted Final Camera Ready Paper for Poster Presentation')",
    [conferenceId, authorEmail]
  );
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Not yet decided','SCHD','DESK ACCEPT')",
    [conferenceId, authorEmail]
  );

  const res = await get(`/conference/${conferenceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes("Oral Presentation Schedule: 05-03-2027 from 09:30 to 10:15"), "scheduled oral submission should show its track's date/time");
  assert.ok(html.includes("Poster Presentation Schedule: 06-03-2027 from 14:00 to 16:00"), "scheduled poster submission should show the poster session's date/time");
  assert.equal((html.match(/\(Schedule Not Released Yet\)/g) || []).length, 1, "only the unscheduled oral submission should show the placeholder");
  assert.equal((html.match(/>Register<\/a>/g) || []).length, 3, "all three final-camera-ready submissions get a Register link, the DESK ACCEPT one doesn't");
  assert.equal((html.match(/<strong>Registration<\/strong>/g) || []).length, 3);
  assert.ok(html.includes("Edit Submission"), "the still-pending submission keeps the normal action links");
});
