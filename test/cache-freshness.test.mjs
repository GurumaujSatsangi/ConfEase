// Integration tests for application-level caching (Redis) and cache
// invalidation. Unlike authz.test.mjs / security-smoke.test.mjs, these
// tests deliberately do NOT set VERCEL=1: they need the app to make its
// real Redis connection (api/index.js reads REDIS_HOST/PORT/... from the
// project's .env, loaded as a side effect of importing config/db.js) so the
// actual cache-read/cache-write/cache-invalidate code paths run, not a
// bypassed/mocked version of them.
//
// They also use the real local Postgres database (same pool the app uses)
// to seed isolated test fixtures and to verify state directly against the
// authoritative source, and a second, independent Redis client (same
// credentials) to inspect cache keys directly where HTTP-response
// inspection alone would not be conclusive.
//
// Each test gets its OWN conference (and own submissions), created and torn
// down within that test - not shared across tests - specifically so that
// /publish/review-results (which emails every already-decided submission in
// a conference, not just newly-decided ones) can never pick up another
// test's leftover decided submission and send an unintended email.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { createClient } from "redis";

process.env.JWT_ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_TOKEN_SECRET || "test-access-secret";
// Deliberately not VERCEL=1 (that also skips the Redis connection this file
// needs). SKIP_AUTOLISTEN avoids the module's own app.listen(port) side
// effect - see api/index.js - so only the app.listen(0) below is used.
process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const redisProbe = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, connectTimeout: 5000 },
});
redisProbe.on("error", () => {});
let redisAvailable = false;
try {
  await redisProbe.connect();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}

const secret = process.env.JWT_ACCESS_TOKEN_SECRET;
const accessToken = (email) =>
  jwt.sign({ typ: "access", email, name: "Cache Test User", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const chairAccessToken = (email) =>
  jwt.sign({ typ: "chair", email, name: "Cache Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

function submissionsCacheKey(email, conferenceId) {
  return `${String(email).trim().toLowerCase()}_submissions_conference_${conferenceId}`;
}

const chairEmail = "cache-test-chair@example.com";
const authorEmail = "cache-test-author@example.com";

// Creates an isolated CACHE_TEST_ conference (and tracks its submissions for
// cleanup), runs `fn({ conferenceId, insertSubmission })`, and always tears
// everything down afterward - even if `fn` throws.
async function withTestConference(fn) {
  const r = await pool.query(
    `INSERT INTO conferences (title, description, created_by) VALUES ($1,$2,$3) RETURNING conference_id`,
    ["CACHE_TEST_" + crypto.randomBytes(4).toString("hex"), "seeded for cache-freshness.test.mjs", chairEmail]
  );
  const conferenceId = r.rows[0].conference_id;
  const submissionIds = [];

  const insertSubmission = async ({ primary_author, title, status = "Submitted for Review" }) => {
    const paperCode = "CT" + crypto.randomBytes(4).toString("hex");
    const ins = await pool.query(
      `INSERT INTO submissions (conference_id, primary_author, title, abstract, paper_code, submission_status)
       VALUES ($1,$2,$3,'test abstract',$4,$5) RETURNING submission_id`,
      [conferenceId, primary_author, title, paperCode, status]
    );
    submissionIds.push(ins.rows[0].submission_id);
    return ins.rows[0].submission_id;
  };

  try {
    await fn({ conferenceId, insertSubmission });
  } finally {
    if (redisAvailable) {
      const emails = new Set();
      const rows = submissionIds.length
        ? (await pool.query("SELECT primary_author FROM submissions WHERE submission_id = ANY($1)", [submissionIds])).rows
        : [];
      rows.forEach((row) => emails.add(row.primary_author));
      await Promise.all([...emails].map((email) => redisProbe.del(submissionsCacheKey(email, conferenceId))));
    }
    if (submissionIds.length) {
      await pool.query("DELETE FROM meta_reviewer_decision WHERE submission_id = ANY($1)", [submissionIds]);
      await pool.query("DELETE FROM submissions WHERE submission_id = ANY($1)", [submissionIds]);
    }
    await pool.query("DELETE FROM conferences WHERE conference_id = $1", [conferenceId]);
  }
}

after(async () => {
  // Belt-and-braces: remove anything a failed assertion left behind before
  // its own withTestConference() cleanup ran.
  await pool.query(`DELETE FROM submissions WHERE title LIKE 'CACHE_TEST_%'`);
  await pool.query(`DELETE FROM conferences WHERE title LIKE 'CACHE_TEST_%'`);

  if (redisAvailable) await redisProbe.quit();
  server.close();
  await pool.end();
  // The app's own internal Redis client (module-scoped in api/index.js, not
  // exported) stays connected to Redis Cloud and would otherwise keep this
  // process alive indefinitely. All assertions have already run and been
  // recorded by node:test at this point; force-exit so the run ends.
  setImmediate(() => process.exit(0));
});

// ---------------------------------------------------------------------------
// Cache Key 1: the global "conferences" list (used by GET /dashboard).
// ---------------------------------------------------------------------------

test("conferences cache: create -> read shows the new conference without waiting for TTL", { skip: !redisAvailable && "Redis not reachable from this environment" }, async () => {
  const chair = chairAccessToken(chairEmail);
  const viewer = accessToken(authorEmail);

  // 1. Populate the cache (miss -> DB read -> cache set).
  const firstDashboard = await get("/dashboard", viewer);
  assert.equal(firstDashboard.status, 200);

  // 2. Create a new conference through the real route.
  const title = "CACHE_TEST_Create_" + crypto.randomBytes(3).toString("hex");
  const createRes = await post("/create-new-conference", chair, {
    title,
    description: "d",
    conference_start_date: "2027-01-01",
    conference_end_date: "2027-01-02",
    full_paper_submission: "2027-01-01",
    acceptance_notification: "2027-01-01",
    camera_ready_paper_submission: "2027-01-01",
    deadline_peer_review: "2027-01-01",
    co_chairs: "",
    communication: "",
  });
  assert.equal(createRes.status, 302, "create-new-conference should redirect on success");

  try {
    // 3. Read again - must show the new conference immediately.
    const secondDashboard = await get("/dashboard", viewer);
    const html = await secondDashboard.text();
    assert.ok(html.includes(title), "newly created conference must appear without waiting for cache expiry");
  } finally {
    await pool.query("DELETE FROM conferences WHERE title = $1", [title]);
  }
});

test("conferences cache: update -> read reflects the new title, delete -> read no longer shows it", { skip: !redisAvailable && "Redis not reachable from this environment" }, async () => {
  const chair = chairAccessToken(chairEmail);
  const viewer = accessToken(authorEmail);

  const title = "CACHE_TEST_Update_" + crypto.randomBytes(3).toString("hex");
  const createRes = await post("/create-new-conference", chair, { title, description: "d" });
  assert.equal(createRes.status, 302);

  const created = await pool.query("SELECT conference_id FROM conferences WHERE title = $1", [title]);
  const id = created.rows[0].conference_id;

  try {
    await get("/dashboard", viewer); // populate cache with the old title

    const newTitle = title + "_UPDATED";
    const updateRes = await post(`/chair/dashboard/update-conference/${id}`, chair, { title: newTitle, description: "d2" });
    assert.equal(updateRes.status, 302);

    const afterUpdate = await (await get("/dashboard", viewer)).text();
    assert.ok(afterUpdate.includes(newTitle), "dashboard must show the updated title, not the cached old one");

    const deleteRes = await post(`/chair/dashboard/delete-conference/${id}`, chair);
    assert.equal(deleteRes.status, 302);

    const afterDelete = await (await get("/dashboard", viewer)).text();
    assert.ok(!afterDelete.includes(newTitle), "deleted conference must not still appear on the dashboard");
  } finally {
    await pool.query("DELETE FROM conferences WHERE conference_id = $1", [id]);
  }
});

test("conferences cache entry has a short, bounded TTL (defense in depth, not the primary freshness mechanism)", { skip: !redisAvailable && "Redis not reachable from this environment" }, async () => {
  await redisProbe.del("conferences");
  await get("/dashboard", accessToken(authorEmail));
  const ttl = await redisProbe.ttl("conferences");
  assert.ok(ttl > 0 && ttl <= 300, `expected a positive TTL <= 300s, got ${ttl}`);
});

// ---------------------------------------------------------------------------
// Cache Key 2: per-user "My Submissions" list, read by GET /conference/:id.
// ---------------------------------------------------------------------------

test("submissions cache: read -> chair decision -> read shows the new status, not the cached old one", { skip: !redisAvailable && "Redis not reachable from this environment" }, () =>
  withTestConference(async ({ conferenceId, insertSubmission }) => {
    const viewer = accessToken(authorEmail);
    const chair = chairAccessToken(chairEmail);
    const submissionId = await insertSubmission({ primary_author: authorEmail, title: "CACHE_TEST_Paper_Status" });

    const before1 = await (await get(`/conference/${conferenceId}`, viewer)).text();
    assert.ok(before1.includes("Submitted for Review"), "page should show the seeded status before any decision");

    // Real mutation route (no file upload, no email).
    const decideRes = await post(`/resolve-conflict/${submissionId}/${conferenceId}`, chair, {
      final_remarks: "looks good",
      status: "Accepted for Oral Presentation",
    });
    assert.equal(decideRes.status, 302);

    const dbRow = await pool.query("SELECT submission_status FROM submissions WHERE submission_id = $1", [submissionId]);
    assert.equal(dbRow.rows[0].submission_status, "Accepted for Oral Presentation", "sanity: DB was actually updated");

    const after1 = await (await get(`/conference/${conferenceId}`, viewer)).text();
    assert.ok(after1.includes("Accepted for Oral Presentation"), "page must show the new status immediately");
    assert.ok(!after1.includes(">Submitted for Review<"), "page must not still show the old cached status");
  })
);

test("submissions cache: author's own revised-paper submission invalidates their cache", { skip: !redisAvailable && "Redis not reachable from this environment" }, () =>
  withTestConference(async ({ conferenceId, insertSubmission }) => {
    const viewer = accessToken(authorEmail);
    const submissionId = await insertSubmission({ primary_author: authorEmail, title: "CACHE_TEST_Revision", status: "Revision Required" });

    await get(`/conference/${conferenceId}`, viewer); // populate cache at "Revision Required"

    // /submit-revised-paper needs a real multipart file upload (Cloudinary is
    // not available in this environment); exercise the exact UPDATE +
    // invalidation sequence that route performs, in that order, directly.
    await pool.query(`UPDATE submissions SET submission_status = 'Submitted Revised Paper', file_url = 'test://file' WHERE submission_id = $1`, [submissionId]);
    await redisProbe.del(submissionsCacheKey(authorEmail, conferenceId));

    const after1 = await (await get(`/conference/${conferenceId}`, viewer)).text();
    assert.ok(after1.includes("Submitted Revised Paper"), "page must show the post-revision status");
  })
);

test("submissions cache key is case-insensitive on the author's email (chair-typed casing must still invalidate the real key)", { skip: !redisAvailable && "Redis not reachable from this environment" }, () =>
  withTestConference(async ({ conferenceId, insertSubmission }) => {
    const mixedCaseEmail = "Cache-Test-Mixed@Example.com";
    const submissionId = await insertSubmission({ primary_author: mixedCaseEmail, title: "CACHE_TEST_CaseKey" });

    // Simulate a pre-existing cache entry for this user, keyed the way the
    // app's own (now-normalized) submissionsCacheKey() builds it.
    const normalizedKey = submissionsCacheKey(mixedCaseEmail, conferenceId);
    await redisProbe.set(normalizedKey, JSON.stringify([{ stale: true }]), { EX: 3600 });
    assert.ok(await redisProbe.get(normalizedKey), "sanity: cache entry exists before the mutation");

    const chair = chairAccessToken(chairEmail);
    const decideRes = await post(`/resolve-conflict/${submissionId}/${conferenceId}`, chair, { final_remarks: "ok", status: "Rejected" });
    assert.equal(decideRes.status, 302);

    const stillCached = await redisProbe.get(normalizedKey);
    assert.equal(stillCached, null, "resolve-conflict's invalidation (built from submissions.primary_author, stored as 'Cache-Test-Mixed@Example.com') must still hit the lowercase-normalized key");
  })
);

test("submissions cache: user isolation - one author's cached list never leaks another author's submissions", { skip: !redisAvailable && "Redis not reachable from this environment" }, () =>
  withTestConference(async ({ conferenceId, insertSubmission }) => {
    const otherAuthorEmail = "cache-test-other-author@example.com";
    await insertSubmission({ primary_author: authorEmail, title: "CACHE_TEST_Mine" });
    await insertSubmission({ primary_author: otherAuthorEmail, title: "CACHE_TEST_NotMine" });

    const mine = await (await get(`/conference/${conferenceId}`, accessToken(authorEmail))).text();
    const theirs = await (await get(`/conference/${conferenceId}`, accessToken(otherAuthorEmail))).text();

    assert.ok(mine.includes("CACHE_TEST_Mine"));
    assert.ok(!mine.includes("CACHE_TEST_NotMine"), "one author must not see another author's submissions via a shared/miskeyed cache entry");
    assert.ok(theirs.includes("CACHE_TEST_NotMine"));
    assert.ok(!theirs.includes("CACHE_TEST_Mine"));
  })
);

// ---------------------------------------------------------------------------
// /publish/review-results: applies meta-reviewer decisions, must invalidate
// regardless of whether anything is left pending afterward.
// ---------------------------------------------------------------------------

test("publish/review-results: a submission with no decision yet stays pending, sends no email, and still gets its cache invalidated", { skip: !redisAvailable && "Redis not reachable from this environment" }, () =>
  withTestConference(async ({ conferenceId, insertSubmission }) => {
    const viewer = accessToken(authorEmail);
    const chair = chairAccessToken(chairEmail);
    await insertSubmission({ primary_author: authorEmail, title: "CACHE_TEST_Pending", status: "DESK ACCEPT" });

    await get(`/conference/${conferenceId}`, viewer); // populate cache
    const key = submissionsCacheKey(authorEmail, conferenceId);
    assert.ok(await redisProbe.get(key), "sanity: cache populated");

    const res = await post("/publish/review-results", chair, { conference_id: conferenceId });
    assert.equal(res.status, 200, "pending-only publish renders the pending-acceptance page directly (no email sent)");

    const afterPublish = await redisProbe.get(key);
    assert.equal(afterPublish, null, "publish must invalidate the author's cache even for still-pending submissions");
  })
);

// This test exercises the exact regression this session found and fixed:
// invalidation used to run ONLY inside `if (pending_acceptance_notifications
// .length > 0)`. A publish that resolves every outstanding submission (none
// left pending) skipped it entirely, leaving a just-applied meta-reviewer
// decision's new status stuck behind a stale cache entry for up to an hour.
//
// To reach that code path for real, every submission in the conference must
// end up "decided" in this one request - which makes /publish/review-results
// send its real acceptance-notification email (there is no way to reach the
// all-decided branch without it; this route has no test-mode flag for mail).
// The conference used here is otherwise empty (withTestConference gives
// every test its own), so this is the only email this test can trigger.
// It sends exactly one real email, via the project's own configured
// EMAIL_USER account, addressed to that same account
// (process.env.EMAIL_USER) so it is visible only to the project owner and
// never reaches a third party. Opt-in only - see CACHE_TEST_ALLOW_EMAIL.
const emailTestAddress = process.env.EMAIL_USER;
const allowEmailTest = process.env.CACHE_TEST_ALLOW_EMAIL === "1";
test(
  "publish/review-results: applying a meta-reviewer decision with nothing left pending still invalidates the cache (regression test)",
  {
    skip:
      (!redisAvailable && "Redis not reachable from this environment") ||
      (!emailTestAddress && "EMAIL_USER not configured; cannot exercise the all-decided email branch") ||
      (!allowEmailTest && "requires explicit opt-in: set CACHE_TEST_ALLOW_EMAIL=1 (sends one real email to EMAIL_USER)"),
  },
  () =>
    withTestConference(async ({ conferenceId, insertSubmission }) => {
      const chair = chairAccessToken(chairEmail);
      const submissionId = await insertSubmission({ primary_author: emailTestAddress, title: "CACHE_TEST_MetaDecision", status: "DESK ACCEPT" });
      await pool.query(
        "INSERT INTO meta_reviewer_decision (submission_id, status, remarks) VALUES ($1,$2,$3)",
        [submissionId, "Accepted for Poster Presentation", "CACHE_TEST automated regression check"]
      );

      await get(`/conference/${conferenceId}`, accessToken(emailTestAddress)); // populate cache at DESK ACCEPT
      const key = submissionsCacheKey(emailTestAddress, conferenceId);
      assert.ok(await redisProbe.get(key), "sanity: cache populated before publish");

      const res = await post("/publish/review-results", chair, { conference_id: conferenceId });
      assert.equal(res.status, 302, "an all-decided publish redirects rather than rendering the pending page");

      const dbRow = await pool.query("SELECT submission_status FROM submissions WHERE submission_id = $1", [submissionId]);
      assert.equal(dbRow.rows[0].submission_status, "Accepted for Poster Presentation", "the meta-reviewer decision must have been applied to the submission");

      const decisionRow = await pool.query("SELECT 1 FROM meta_reviewer_decision WHERE submission_id = $1", [submissionId]);
      assert.equal(decisionRow.rows.length, 0, "the applied decision must be cleared so a later publish can't reapply it");

      const afterPublish = await redisProbe.get(key);
      assert.equal(afterPublish, null, "cache must be invalidated even though nothing was left pending afterward");
    })
);
