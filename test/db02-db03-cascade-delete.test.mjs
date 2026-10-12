// Regression tests for DB-02 and DB-03
// (security-audit/COMPLETE_FINDINGS_REGISTER.md):
//
// DB-02: POST /chair/dashboard/delete-conference/:id previously only
// cleaned up conference_tracks before deleting the conference row, leaving
// submissions, registration, certificates, peer_review,
// revised_submissions, co_author_requests, meta_reviewer_decision,
// final_camera_ready_submissions, poster_session,
// poster_presentation_scores, invitees, invited_talk_submissions,
// conference_roles, role_certificates, desk_review, and
// conference_paper_counters all permanently orphaned. It now cascades all
// of these inside the existing transaction, in dependency order, and also
// deletes conference_groups (which has an ON DELETE RESTRICT FK to
// conferences that previously made deletion fail outright - and
// inconsistently, since a conference with no groups deleted fine).
//
// DB-03: both submission-delete routes (chair's
// /chair/dashboard/delete-submission/:id and the primary author's own
// /submission/delete/primary-author/:id) previously missed several child
// tables - most reliably reproducible via a pending co-author request,
// which the primary-author route didn't clean up at all (and ran with no
// transaction). Both routes now share deleteSubmissionCascade()
// (api/index.js), verified here via a seeded co_author_requests row.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "db0203-test-chair@example.com";
const authorEmail = "db0203-test-author@example.com";
const coAuthorEmail = "db0203-test-coauthor@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "DB0203 Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "DB0203 Test Author", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` },
    body: new URLSearchParams(body),
  });

const cleanupConferenceIds = [];

after(async () => {
  for (const id of cleanupConferenceIds) {
    await pool.query("delete from submissions where conference_id = $1", [id]);
    await pool.query("delete from conferences where conference_id = $1", [id]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("DB-03: deleting a submission with a pending co-author request cleans it up, via the chair's delete route", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["DB03_TEST_CHAIR_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  const conferenceId = conf.rows[0].conference_id;
  cleanupConferenceIds.push(conferenceId);

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'DB03 Paper','DB03A',901,'Submitted for Review') returning submission_id",
    [conferenceId, authorEmail]
  );
  const submissionId = sub.rows[0].submission_id;

  await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Pending')",
    [conferenceId, submissionId, authorEmail, coAuthorEmail]
  );

  const res = await post(`/chair/dashboard/delete-submission/${submissionId}?conference_id=${conferenceId}`, chairToken);
  assert.equal(res.status, 302);

  const remainingSubmission = await pool.query("select 1 from submissions where submission_id = $1", [submissionId]);
  assert.equal(remainingSubmission.rows.length, 0, "the submission itself must be deleted");

  const remainingRequest = await pool.query("select 1 from co_author_requests where submission_id = $1", [submissionId]);
  assert.equal(remainingRequest.rows.length, 0, "the pending co-author request must not be left orphaned");
});

test("DB-03: a primary author deleting their own submission cleans up a pending co-author request too", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["DB03_TEST_SELF_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  const conferenceId = conf.rows[0].conference_id;
  cleanupConferenceIds.push(conferenceId);

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'DB03 Self Paper','DB03B',902,'Submitted for Review') returning submission_id",
    [conferenceId, authorEmail]
  );
  const submissionId = sub.rows[0].submission_id;

  await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Pending')",
    [conferenceId, submissionId, authorEmail, coAuthorEmail]
  );

  const res = await post(`/submission/delete/primary-author/${submissionId}`, authorToken);
  assert.equal(res.status, 302);

  const remainingSubmission = await pool.query("select 1 from submissions where submission_id = $1", [submissionId]);
  assert.equal(remainingSubmission.rows.length, 0, "the submission itself must be deleted");

  const remainingRequest = await pool.query("select 1 from co_author_requests where submission_id = $1", [submissionId]);
  assert.equal(remainingRequest.rows.length, 0, "the self-delete route must clean up the pending co-author request too, not just the chair's route");
});

test("DB-02: deleting a conference cascades every child table, including one with an ON DELETE RESTRICT FK that previously blocked deletion", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["DB02_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  const conferenceId = conf.rows[0].conference_id;

  const group = await pool.query(
    "insert into conference_groups (conference_id, group_name) values ($1,'DB02 Group') returning group_id",
    [conferenceId]
  );
  const groupId = group.rows[0].group_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, group_id) values ($1,'DB02 Track',$2) returning track_id",
    [conferenceId, groupId]
  );
  const trackId = track.rows[0].track_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'DB02 Paper','DB02A',903,'Submitted for Review',$3) returning submission_id",
    [conferenceId, authorEmail, trackId]
  );
  const submissionId = sub.rows[0].submission_id;

  await pool.query("insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Pending')", [
    conferenceId,
    submissionId,
    authorEmail,
    coAuthorEmail,
  ]);
  await pool.query("insert into registration (conference_id, submission_id, mode_of_presentation) values ($1,$2,'Online')", [conferenceId, submissionId]);
  await pool.query("insert into invitees (name, email, conference_id) values ($1,$2,$3)", ["DB02 Invitee", "db02-invitee@example.com", conferenceId]);
  await pool.query("insert into conference_roles (conference_id, email_id, role) values ($1,$2,'reviewer')", [conferenceId, "db02-reviewer@example.com"]);

  const res = await post(`/chair/dashboard/delete-conference/${conferenceId}`, chairToken);
  assert.equal(res.status, 302, "deleting a conference that has a track group must succeed, not fail on the conference_groups RESTRICT FK");

  const remainingByTable = await Promise.all([
    pool.query("select 1 from conferences where conference_id = $1", [conferenceId]),
    pool.query("select 1 from conference_groups where conference_id = $1", [conferenceId]),
    pool.query("select 1 from conference_tracks where conference_id = $1", [conferenceId]),
    pool.query("select 1 from submissions where conference_id = $1", [conferenceId]),
    pool.query("select 1 from co_author_requests where conference_id = $1", [conferenceId]),
    pool.query("select 1 from registration where conference_id = $1", [conferenceId]),
    pool.query("select 1 from invitees where conference_id = $1", [conferenceId]),
    pool.query("select 1 from conference_roles where conference_id = $1", [conferenceId]),
  ]);
  const tableNames = ["conferences", "conference_groups", "conference_tracks", "submissions", "co_author_requests", "registration", "invitees", "conference_roles"];
  remainingByTable.forEach((result, i) => {
    assert.equal(result.rows.length, 0, `${tableNames[i]} must have no rows left for the deleted conference`);
  });
});
