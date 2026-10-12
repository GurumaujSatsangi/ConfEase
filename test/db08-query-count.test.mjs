// Query-count regression test for DB-08
// (security-audit/COMPLETE_FINDINGS_REGISTER.md): the session-leaderboard
// dashboards used to run 3 separate queries per leaderboard submission
// inside a loop - for N submissions that's roughly 3N+ queries for a
// single page load. buildLeaderboardAndFcrpByTrack (api/index.js) batches
// those into 3 queries total regardless of N. This test seeds a
// non-trivial number of scored submissions and asserts the query count for
// loading the dashboard stays flat (bounded by a small constant) rather
// than growing with the submission count - the actual regression this
// fix is guarding against.

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
const chairEmail = "db08-test-chair@example.com";
const authorEmail = "db08-test-author@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "DB08 Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const get = (path, token) => fetch(base + path, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });

const SUBMISSION_COUNT = 8; // enough that a 3-per-submission pattern (old behavior) would be obviously non-constant

let conferenceId;
let trackId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["DB08_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["DB08 Author", authorEmail]);

  const track = await pool.query("insert into conference_tracks (conference_id, track_name) values ($1,'DB08 Track') returning track_id", [conferenceId]);
  trackId = track.rows[0].track_id;

  for (let i = 0; i < SUBMISSION_COUNT; i++) {
    // paper_code is globally unique across the whole submissions table, so
    // every test file that seeds one needs a collision-proof value, not
    // just one that looks distinct within this file - a short predictable
    // scheme here previously collided with an unrelated test file's own
    // literal code when both ran concurrently (node --test runs each file
    // in its own process, but they share the same database).
    const paperCode = "D8" + crypto.randomBytes(2).toString("hex").toUpperCase();
    const sub = await pool.query(
      "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, track_id) values ($1,$2,$3,$4,$5,'Presentation Completed',$6) returning submission_id",
      [conferenceId, authorEmail, `DB08 Paper ${i}`, paperCode, 600 + i, trackId]
    );
    await pool.query("insert into peer_review (conference_id, submission_id, reviewer, mean_score, review_status, acceptance_status) values ($1,$2,$3,$4,'Reviewed','Accepted')", [
      conferenceId,
      sub.rows[0].submission_id,
      `db08-reviewer-${i}@example.com`,
      4.0,
    ]);
    await pool.query("insert into final_camera_ready_submissions (submission_id, panelist_score) values ($1, $2)", [sub.rows[0].submission_id, 4.0]);
  }
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from final_camera_ready_submissions where submission_id in (select submission_id from submissions where conference_id = $1)", [conferenceId]);
    await pool.query("delete from peer_review where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  await pool.query("delete from users where email = $1", [authorEmail]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test(`loading the oral-sessions dashboard with ${SUBMISSION_COUNT} leaderboard submissions runs a bounded number of queries, not one that scales with the submission count`, async () => {
  const originalQuery = pool.query.bind(pool);
  let queryCount = 0;
  pool.query = (...args) => {
    queryCount++;
    return originalQuery(...args);
  };

  let res;
  try {
    res = await get(`/chair/dashboard/manage-sessions/${conferenceId}`, chairToken);
  } finally {
    pool.query = originalQuery;
  }

  assert.equal(res.status, 200);
  // Pre-fix this would have been roughly 3*SUBMISSION_COUNT (24) just for
  // the leaderboard loop, on top of fixed overhead (auth, conference,
  // tracks). Post-fix it's a small constant regardless of
  // SUBMISSION_COUNT: an absolute ceiling here (not a comparison to N,
  // which could coincidentally match the fixed-overhead count) is what
  // actually proves the per-submission loop is gone.
  const PRE_FIX_EXPECTED_COUNT = 3 * SUBMISSION_COUNT; // what the old N+1 pattern alone would have added
  const ABSOLUTE_CEILING = 12; // fixed overhead + 3 batched queries, generous but nowhere near 3N
  assert.ok(
    queryCount <= ABSOLUTE_CEILING,
    `expected a bounded query count (<= ${ABSOLUTE_CEILING}), got ${queryCount} - the N+1 pattern may have regressed`
  );
  assert.ok(
    queryCount < PRE_FIX_EXPECTED_COUNT,
    `query count (${queryCount}) should be far below what the old per-submission loop alone would have added (${PRE_FIX_EXPECTED_COUNT})`
  );
});
