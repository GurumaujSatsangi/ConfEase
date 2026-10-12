// Regression tests for CACHE-03 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// poster upvotes previously lived only in Redis (a Set for dedup, plus an
// INCR counter) - genuinely ephemeral primary data with no database
// backing. Postgres (poster_votes, migration 015) is now the durable
// source of truth; Redis is touched afterward only as a non-authoritative
// fast-path cache.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

let conferenceId;
let submissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["POSTER_VOTE_TEST_" + crypto.randomBytes(3).toString("hex"), "poster-vote-test-chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Poster Vote Test Paper','PV01',701,'Poster Scored') returning submission_id",
    [conferenceId, "poster-vote-test-author@example.com"]
  );
  submissionId = sub.rows[0].submission_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from poster_votes where submission_id = $1", [submissionId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a vote is durably recorded in Postgres, not just Redis", async () => {
  const res = await fetch(base + `/upvote-poster/${submissionId}`, { method: "POST", redirect: "manual" });
  assert.equal(res.status, 302);

  const rows = await pool.query("select voter_ip from poster_votes where submission_id = $1", [submissionId]);
  assert.equal(rows.rows.length, 1, "the vote must be recorded in the database, not only in Redis");
});

test("a second vote from the same IP for the same submission is not recorded twice", async () => {
  // Two real HTTP requests from this same test process/connection share the
  // same source IP as seen by the server (127.0.0.1/::1) - no header
  // spoofing needed to exercise the real one-vote-per-IP path.
  await fetch(base + `/upvote-poster/${submissionId}`, { method: "POST", redirect: "manual" });
  await fetch(base + `/upvote-poster/${submissionId}`, { method: "POST", redirect: "manual" });

  const rows = await pool.query("select count(*)::int as n from poster_votes where submission_id = $1", [submissionId]);
  assert.equal(rows.rows[0].n, 1, "only one vote per IP per submission must ever be recorded, regardless of how many times the route is hit");
});

test("voting for a nonexistent submission does not write a vote row", async () => {
  const fakeId = crypto.randomUUID();
  const res = await fetch(base + `/upvote-poster/${fakeId}`, { method: "POST", redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not found/i);

  const rows = await pool.query("select 1 from poster_votes where submission_id = $1", [fakeId]);
  assert.equal(rows.rows.length, 0);
});
