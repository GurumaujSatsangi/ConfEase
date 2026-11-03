// Regression test: the "My Submissions" modal on GET /conference/:id
// (views/conference.ejs, #MySubmissions) listed a submission's Paper ID,
// title, status etc., but never which subject area it was submitted
// under - the only place to see that was the original submission form,
// which an author isn't looking at afterward. Added a "Subject Area"
// column using the same "Track Name: Subject Area Name" label format as
// the submission-form dropdown (test/submission-track-labels.test.mjs),
// built from the conference_tracks query GET /conference/:id already runs
// for other reasons - no new query added.

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
const authorEmail = "mysubs-label-test-author@example.com";
const token = jwt.sign({ typ: "access", email: authorEmail, name: "Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

let conferenceId;
after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_groups where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the My Submissions modal shows each submission's subject area, labeled with its Track", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["MYSUBS_LABEL_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  const g1 = await pool.query("insert into conference_groups (conference_id, group_name) values ($1,'Track 1') returning group_id", [conferenceId]);
  const grouped = await pool.query(
    "insert into conference_tracks (conference_id, group_id, track_name) values ($1,$2,'Machine Learning') returning track_id",
    [conferenceId, g1.rows[0].group_id]
  );
  const ungrouped = await pool.query(
    "insert into conference_tracks (conference_id, group_id, track_name) values ($1,NULL,'General') returning track_id",
    [conferenceId]
  );

  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Grouped Paper','MSL1',1,'DESK ACCEPT',$3)",
    [conferenceId, authorEmail, grouped.rows[0].track_id]
  );
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Ungrouped Paper','MSL2',2,'DESK ACCEPT',$3)",
    [conferenceId, authorEmail, ungrouped.rows[0].track_id]
  );

  const res = await get(`/conference/${conferenceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<th>Subject Area<\/th>/, "the My Submissions table needs a Subject Area column header");
  assert.match(html, /Track 1: Machine Learning/, "a grouped subject area must show as Track Name: Subject Area Name");
  assert.match(html, /<td>\s*General\s*<\/td>/, "an ungrouped subject area must show with no Track prefix");
  assert.doesNotMatch(html, /null: General/, "an ungrouped subject area must never show a literal \"null:\" prefix");
});
