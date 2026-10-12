// Regression tests for the cross-conference IDOR findings fixed in this
// remediation pass (security-audit/COMPLETE_FINDINGS_REGISTER.md):
//   AUTHZ-03  POST /chair/dashboard/manage-sessions/:id
//   AUTHZ-04  POST /submit-desk-decision/:id, POST /submit-desk-rejection-remarks/:id
//   AUTHZ-05  POST /add-invitee
// Each previously allowed any activated chair to mutate a conference they
// don't own, as long as they could reach/guess the right ID. Every test
// here uses two separate chair accounts and two separate conferences, and
// asserts the non-owning chair's request is rejected AND that the target
// conference's data is actually unchanged.

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
const ownerChairEmail = "idor-owner-chair@example.com";
const attackerChairEmail = "idor-attacker-chair@example.com";
const authorEmail = "idor-author@example.com";

const chairToken = (email) => jwt.sign({ typ: "chair", email, name: "Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const ownerToken = chairToken(ownerChairEmail);
const attackerToken = chairToken(attackerChairEmail);

const post = (path, body, token) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` },
    body: new URLSearchParams(body),
  });

let ownerConferenceId;
let trackId;
let fcrpSubmissionId;
let deskReviewSubmissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["IDOR_TEST_" + crypto.randomBytes(3).toString("hex"), ownerChairEmail]
  );
  ownerConferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, presentation_date, presentation_start_time, presentation_end_time, panelists) values ($1,'Original Track','2026-01-01','09:00','10:00', ARRAY[]::text[]) returning track_id",
    [ownerConferenceId]
  );
  trackId = track.rows[0].track_id;

  const fcrp = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'FCRP Oral Paper','IDA1',901,'Submitted Final Camera Ready Paper for Oral Presentation',$3) returning submission_id",
    [ownerConferenceId, authorEmail, trackId]
  );
  fcrpSubmissionId = fcrp.rows[0].submission_id;

  const deskSub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Desk Review Paper','IDA2',902,'Submitted for Review') returning submission_id",
    [ownerConferenceId, authorEmail]
  );
  deskReviewSubmissionId = deskSub.rows[0].submission_id;
});

after(async () => {
  if (ownerConferenceId) {
    await pool.query("delete from desk_review where paper_id in (select submission_id::text from submissions where conference_id = $1)", [ownerConferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [ownerConferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [ownerConferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [ownerConferenceId]);
  }
  await pool.query("delete from invitees where email = 'idor-invitee@example.com'");
  await pool.query("delete from conference_roles where email_id = 'idor-invitee@example.com'");
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("AUTHZ-03: a non-owning chair cannot modify another conference's session schedule", async () => {
  const res = await post(
    `/chair/dashboard/manage-sessions/${ownerConferenceId}`,
    {
      [`track_id_${trackId}`]: trackId,
      [`track_name_${trackId}`]: "Hijacked Track",
      [`session_date_${trackId}`]: "2026-02-02",
      [`start_time_${trackId}`]: "11:00",
      [`end_time_${trackId}`]: "12:00",
      [`panelists_${trackId}`]: "attacker@example.com",
    },
    attackerToken
  );
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);

  const track = await pool.query("select track_name from conference_tracks where track_id = $1", [trackId]);
  assert.equal(track.rows[0].track_name, "Original Track", "the track must be unchanged");
});

test("AUTHZ-04: a non-owning chair cannot desk-accept another conference's submission", async () => {
  const res = await post(`/submit-desk-decision/${deskReviewSubmissionId}`, { decision: "DESK ACCEPT" }, attackerToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);

  const sub = await pool.query("select submission_status from submissions where submission_id = $1", [deskReviewSubmissionId]);
  assert.equal(sub.rows[0].submission_status, "Submitted for Review", "the submission status must be unchanged");
});

test("AUTHZ-04: a non-owning chair cannot desk-reject-with-remarks another conference's submission", async () => {
  const res = await post(`/submit-desk-rejection-remarks/${deskReviewSubmissionId}`, { remarks: "hijacked remarks" }, attackerToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);

  const review = await pool.query("select 1 from desk_review where paper_id = $1", [deskReviewSubmissionId]);
  assert.equal(review.rows.length, 0, "no desk_review row should have been written");
});

test("AUTHZ-04: the owning chair can still desk-accept their own submission", async () => {
  const res = await post(`/submit-desk-decision/${deskReviewSubmissionId}`, { decision: "DESK ACCEPT" }, ownerToken);
  assert.equal(res.status, 302);
  assert.doesNotMatch(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);

  const sub = await pool.query("select submission_status from submissions where submission_id = $1", [deskReviewSubmissionId]);
  assert.equal(sub.rows[0].submission_status, "DESK ACCEPT");
});

test("AUTHZ-05: a non-owning chair cannot add an invitee to another conference", async () => {
  const res = await post(
    "/add-invitee",
    { email: "idor-invitee@example.com", conference_id: ownerConferenceId, name: "Unwanted Invitee" },
    attackerToken
  );
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);

  const invitee = await pool.query("select 1 from invitees where conference_id = $1 and email = 'idor-invitee@example.com'", [ownerConferenceId]);
  assert.equal(invitee.rows.length, 0, "no invitee row should have been written");
});
