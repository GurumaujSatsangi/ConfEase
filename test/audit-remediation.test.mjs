// Regression tests for fixes made from the November 2026 database/SQL
// audit (CONFEASE_DB_AUDIT_2026-11.md):
// - DBA-001: POST /chair/dashboard/set-session/:id now checks conference
//   ownership (derived from the track), not just "is any chair".
// - DBA-003: both cascade-delete paths (delete-conference,
//   deleteSubmissionCascade) now also clean up reviewers_assigned_papers.
// - DBA-004/DBA-026: poster score submission is now one transaction, with
//   the cache invalidated only after a successful commit.
// - DBA-012: reviewers_assigned_papers now has a real primary key on
//   submission_id (promoted from its existing unique index) - this test
//   confirms the ON CONFLICT (submission_id) upsert used elsewhere still
//   works against it.

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
const chairEmail = "ar-test-chair@example.com";
const otherChairEmail = "ar-test-other-chair@example.com";
const panelistEmail = "ar-test-panelist@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const otherChairToken = jwt.sign({ typ: "chair", email: otherChairEmail, name: "Other Chair", user_id: 2, role: "chair" }, secret, { expiresIn: "5m" });
const panelistToken = jwt.sign({ typ: "access", email: panelistEmail, name: "Panelist", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId, trackId, submissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["AR_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, panelists) values ($1,'AR Track',$2) returning track_id",
    [conferenceId, [panelistEmail]]
  );
  trackId = track.rows[0].track_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'AR Paper','AR01',301,'Submitted Final Camera Ready Paper for Poster Presentation',$3) returning submission_id",
    [conferenceId, "ar-test-author@example.com", trackId]
  );
  submissionId = sub.rows[0].submission_id;

  await pool.query(
    "insert into final_camera_ready_submissions (conference_id, submission_id, track_id, primary_author, status) values ($1,$2,$3,$4,'Pending')",
    [conferenceId, submissionId, trackId, "ar-test-author@example.com"]
  );

  await pool.query(
    "insert into reviewers_assigned_papers (conference_id, submission_id, reviewer, track) values ($1,$2,$3,$4)",
    [conferenceId, submissionId, panelistEmail, trackId]
  );
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from reviewers_assigned_papers where conference_id = $1", [conferenceId]);
    await pool.query("delete from final_camera_ready_submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("DBA-001: a chair who does not own the conference cannot set another chair's track session", async () => {
  const res = await post(`/chair/dashboard/set-session/${trackId}`, otherChairToken, {
    session_date: "2026-12-01",
    start_time: "10:00",
    end_time: "11:00",
    panelists: "intruder@example.com",
    conference_id: conferenceId,
  });
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized/);

  const row = await pool.query("select panelists, status from conference_tracks where track_id = $1", [trackId]);
  assert.deepEqual(row.rows[0].panelists, [panelistEmail], "panelists must be unchanged after a rejected update");
  assert.notEqual(row.rows[0].status, "Scheduled");
});

test("DBA-001: the owning chair can still set the session (functionality preserved)", async () => {
  const res = await post(`/chair/dashboard/set-session/${trackId}`, chairToken, {
    session_date: "2026-12-01",
    start_time: "10:00",
    end_time: "11:00",
    panelists: panelistEmail,
    conference_id: conferenceId,
  });
  assert.equal(res.status, 302);
  assert.match(loc(res), new RegExp(`/chair/dashboard/manage-sessions/${conferenceId}`));

  const row = await pool.query("select status, presentation_date from conference_tracks where track_id = $1", [trackId]);
  assert.equal(row.rows[0].status, "Scheduled");
});

test("DBA-004/DBA-026: poster score submission updates both tables atomically", async () => {
  const res = await post(`/submit-poster-score/${conferenceId}/${submissionId}`, panelistToken, { score: "4" });
  assert.equal(res.status, 302);
  assert.match(loc(res), /scored succesfully/);

  const sub = await pool.query("select submission_status from submissions where submission_id = $1", [submissionId]);
  assert.equal(sub.rows[0].submission_status, "Poster Scored");

  const fcrp = await pool.query("select panelist_score from final_camera_ready_submissions where submission_id = $1", [submissionId]);
  assert.equal(fcrp.rows[0].panelist_score, 4);
});

test("DBA-012: reviewers_assigned_papers has a working primary key that still supports the existing ON CONFLICT upsert", async () => {
  await pool.query(
    "insert into reviewers_assigned_papers (conference_id, submission_id, reviewer, track) values ($1,$2,$3,$4) on conflict (submission_id) do update set reviewer = excluded.reviewer",
    [conferenceId, submissionId, "new-reviewer@example.com", trackId]
  );
  const row = await pool.query("select reviewer from reviewers_assigned_papers where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].reviewer, "new-reviewer@example.com", "upsert must have updated the existing row, not errored or duplicated it");

  const pk = await pool.query(
    "select constraint_name from information_schema.table_constraints where table_name = 'reviewers_assigned_papers' and constraint_type = 'PRIMARY KEY'"
  );
  assert.equal(pk.rows.length, 1, "reviewers_assigned_papers must have exactly one primary key constraint");
});

test("DBA-003: the chair's delete-submission route (deleteSubmissionCascade) removes the reviewers_assigned_papers row", async () => {
  // deleteSubmissionCascade is module-private - exercised here through
  // the real route that calls it, rather than hand-reproducing its SQL,
  // so this actually covers the code change. The route only allows
  // deleting a submission at "Submitted for Review", so this uses its
  // own disposable submission rather than the shared poster-status fixture.
  const sub3 = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'AR Cascade Paper','AR03',303,'Submitted for Review',$3) returning submission_id",
    [conferenceId, "ar-test-author3@example.com", trackId]
  );
  const sub3Id = sub3.rows[0].submission_id;
  await pool.query(
    "insert into reviewers_assigned_papers (conference_id, submission_id, reviewer, track) values ($1,$2,$3,$4)",
    [conferenceId, sub3Id, panelistEmail, trackId]
  );

  const res = await post(`/chair/dashboard/delete-submission/${sub3Id}?conference_id=${conferenceId}`, chairToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /deleted successfully/);

  const after = await pool.query("select 1 from reviewers_assigned_papers where submission_id = $1", [sub3Id]);
  assert.equal(after.rows.length, 0);
});

test("DBA-003: the chair's delete-conference route removes reviewers_assigned_papers rows for that conference", async () => {
  // A fresh, disposable conference+submission+assignment so this test
  // doesn't depend on (or disturb) the shared fixture used by the tests
  // above, since this one actually deletes the conference.
  const conf2 = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["AR_TEST_DEL_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  const conf2Id = conf2.rows[0].conference_id;
  const track2 = await pool.query(
    "insert into conference_tracks (conference_id, track_name) values ($1,'AR Del Track') returning track_id",
    [conf2Id]
  );
  const sub2 = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'AR Del Paper','AR02',302,'Submitted for Review',$3) returning submission_id",
    [conf2Id, "ar-test-author2@example.com", track2.rows[0].track_id]
  );
  await pool.query(
    "insert into reviewers_assigned_papers (conference_id, submission_id, reviewer, track) values ($1,$2,$3,$4)",
    [conf2Id, sub2.rows[0].submission_id, panelistEmail, track2.rows[0].track_id]
  );

  const res = await post(`/chair/dashboard/delete-conference/${conf2Id}`, chairToken);
  assert.equal(res.status, 302);

  const remaining = await pool.query("select 1 from reviewers_assigned_papers where conference_id = $1", [conf2Id]);
  assert.equal(remaining.rows.length, 0, "no reviewers_assigned_papers row must survive the conference delete");

  const confRow = await pool.query("select 1 from conferences where conference_id = $1", [conf2Id]);
  assert.equal(confRow.rows.length, 0, "the conference itself must actually have been deleted (sanity check)");
});
