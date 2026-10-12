// Concurrency regression tests for DB-04 and DB-05
// (security-audit/COMPLETE_FINDINGS_REGISTER.md): both were check-then-act
// races with no unique constraint backing them. Each test below fires two
// requests concurrently (Promise.all, not sequentially) against the same
// real local database and asserts only the correct number of rows/side
// effects results - these are the actual races winning or losing, not a
// simulation.

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
const reviewerEmail = "race-test-reviewer@example.com";
const primaryAuthorEmail = "race-test-primary-author@example.com";
const joinerEmail = "race-test-joiner@example.com";
const coAuthorAEmail = "race-test-coauthor-a@example.com";
const coAuthorBEmail = "race-test-coauthor-b@example.com";

const accessFor = (email) =>
  jwt.sign({ typ: "access", email, name: "Test", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const post = (path, body, token) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` },
    body: new URLSearchParams(body),
  });

let conferenceId;
let trackId;
let reviewSubmissionId;
let joinSubmissionId;
let acceptSubmissionId;
let requestAId;
let requestBId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, deadline_peer_review) values ($1,$2,$3) returning conference_id",
    ["RACE_TEST_" + crypto.randomBytes(3).toString("hex"), "race-test-chair@example.com", "2099-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, track_reviewers) values ($1,'Race Track', ARRAY[$2]) returning track_id",
    [conferenceId, reviewerEmail]
  );
  trackId = track.rows[0].track_id;

  const reviewSub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,'Race Review Paper','RC01',501,'DESK ACCEPT',$3) returning submission_id",
    [conferenceId, primaryAuthorEmail, trackId]
  );
  reviewSubmissionId = reviewSub.rows[0].submission_id;

  const joinSub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Race Join Paper','RC02',502,'Submitted for Review') returning submission_id",
    [conferenceId, primaryAuthorEmail]
  );
  joinSubmissionId = joinSub.rows[0].submission_id;

  const acceptSub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Race Accept Paper','RC03',503,'Submitted for Review') returning submission_id",
    [conferenceId, primaryAuthorEmail]
  );
  acceptSubmissionId = acceptSub.rows[0].submission_id;

  const reqA = await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Pending') returning request_id",
    [conferenceId, acceptSubmissionId, primaryAuthorEmail, coAuthorAEmail]
  );
  requestAId = reqA.rows[0].request_id;

  const reqB = await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Pending') returning request_id",
    [conferenceId, acceptSubmissionId, primaryAuthorEmail, coAuthorBEmail]
  );
  requestBId = reqB.rows[0].request_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from co_author_requests where conference_id = $1", [conferenceId]);
    await pool.query("delete from peer_review where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("DB-04: two concurrent review submissions for the same (submission, reviewer) produce only one peer_review row", async () => {
  const reviewBody = {
    submission_id: reviewSubmissionId,
    conference_id: conferenceId,
    status: "Accepted",
    originality_score: "4",
    relevance_score: "4",
    technical_quality_score: "4",
    clarity_score: "4",
    impact_score: "4",
    remarks: "concurrent submission test",
  };
  const token = accessFor(reviewerEmail);

  const [res1, res2] = await Promise.all([
    post("/mark-as-reviewed", reviewBody, token),
    post("/mark-as-reviewed", reviewBody, token),
  ]);

  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);

  const rows = await pool.query("select count(*)::int as n from peer_review where submission_id = $1 and reviewer = $2", [
    reviewSubmissionId,
    reviewerEmail,
  ]);
  assert.equal(rows.rows[0].n, 1, "exactly one review row must exist despite the concurrent double-submit");
});

test("DB-05: two concurrent co-author join requests from the same person produce only one pending request", async () => {
  const joinBody = { paper_code: "RC02", id: conferenceId };
  const token = accessFor(joinerEmail);

  const [res1, res2] = await Promise.all([
    post("/join", joinBody, token),
    post("/join", joinBody, token),
  ]);

  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);

  const rows = await pool.query(
    "select count(*)::int as n from co_author_requests where submission_id = $1 and co_author = $2 and status != 'Rejected'",
    [joinSubmissionId, joinerEmail]
  );
  assert.equal(rows.rows[0].n, 1, "exactly one pending join request must exist despite the concurrent double-submit");
});

test("DB-05: two co-author requests accepted concurrently both end up in co_authors (no lost update)", async () => {
  const token = accessFor(primaryAuthorEmail);

  const [res1, res2] = await Promise.all([
    post(`/co-author-request/accept/${requestAId}`, {}, token),
    post(`/co-author-request/accept/${requestBId}`, {}, token),
  ]);

  assert.equal(res1.status, 302);
  assert.equal(res2.status, 302);

  const submission = await pool.query("select co_authors from submissions where submission_id = $1", [acceptSubmissionId]);
  const coAuthors = submission.rows[0].co_authors || [];
  assert.ok(coAuthors.includes(coAuthorAEmail), "co-author A must be present (lost-update would drop one of the two)");
  assert.ok(coAuthors.includes(coAuthorBEmail), "co-author B must be present (lost-update would drop one of the two)");

  const requests = await pool.query("select status from co_author_requests where request_id = ANY($1)", [[requestAId, requestBId]]);
  assert.ok(requests.rows.every((r) => r.status === "Accepted"), "both requests must be marked Accepted");
});
