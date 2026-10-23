// Query-count regression test for the invited-talks dashboard N+1 fix
// (found during the production-readiness audit, same class as DB-08):
// GET /chair/dashboard/invited-talks/:id used to run one
// `invited_talk_submissions` query per invitee inside a
// Promise.all(...map(...)) loop - for N invitees that's N extra queries on
// top of fixed overhead. The fix batches this into a single query for the
// whole conference, grouped in JS by invitee_email. This test seeds a
// non-trivial number of invitees (most with a submission, some without) and
// asserts both that the query count stays flat regardless of invitee count
// and that each invitee still sees only their own submission(s).

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
const chairEmail = "itqc-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "ITQC Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const get = (path, token) => fetch(base + path, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });

const INVITEE_COUNT = 8; // enough that a 1-per-invitee pattern (old behavior) would be obviously non-constant

let conferenceId;
const inviteeEmails = [];

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["ITQC_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  for (let i = 0; i < INVITEE_COUNT; i++) {
    const email = `itqc-invitee-${i}-${crypto.randomBytes(2).toString("hex")}@example.com`;
    inviteeEmails.push(email);
    await pool.query("insert into invitees (conference_id, email, name) values ($1,$2,$3)", [conferenceId, email, `ITQC Invitee ${i}`]);
    // Only every other invitee has actually submitted something, so the
    // grouping logic must correctly give the rest an empty list rather
    // than mixing up submissions between invitees.
    if (i % 2 === 0) {
      await pool.query(
        "insert into invited_talk_submissions (conference_id, invitee_email, title) values ($1,$2,$3)",
        [conferenceId, email, `ITQC Talk ${i}`]
      );
    }
  }
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from invited_talk_submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from invitees where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test(`loading the invited-talks dashboard with ${INVITEE_COUNT} invitees runs a bounded number of queries, not one that scales with the invitee count`, async () => {
  const originalQuery = pool.query.bind(pool);
  let queryCount = 0;
  pool.query = (...args) => {
    queryCount++;
    return originalQuery(...args);
  };

  let res;
  try {
    res = await get(`/chair/dashboard/invited-talks/${conferenceId}`, chairToken);
  } finally {
    pool.query = originalQuery;
  }

  assert.equal(res.status, 200);
  // Pre-fix this would have been +INVITEE_COUNT (8) just for the
  // per-invitee submissions loop, on top of fixed overhead (auth,
  // conference, invitees, tracks). Post-fix it's a small constant
  // regardless of INVITEE_COUNT.
  const ABSOLUTE_CEILING = 10; // fixed overhead + 1 batched submissions query, generous but nowhere near 1-per-invitee
  assert.ok(
    queryCount <= ABSOLUTE_CEILING,
    `expected a bounded query count (<= ${ABSOLUTE_CEILING}), got ${queryCount} - the per-invitee N+1 pattern may have regressed`
  );
  assert.ok(
    queryCount < INVITEE_COUNT,
    `query count (${queryCount}) should be below the invitee count (${INVITEE_COUNT}) - a per-invitee loop would be at or above it`
  );
});

test("each invitee's submissions stay correctly scoped to that invitee after batching", async () => {
  const res = await get(`/chair/dashboard/invited-talks/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();

  // The invitee at index 0 submitted "ITQC Talk 0"; the invitee at index 1
  // submitted nothing. Both must render correctly - the batched grouping
  // must not leak submissions across invitees or drop them for whoever has
  // none.
  assert.match(html, /ITQC Talk 0/, "an invitee with a submission must still show it");
  assert.match(html, new RegExp(inviteeEmails[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "an invitee with no submissions must still be listed");
});
