// Regression tests for REL-04 (security-audit/PRODUCTION_RELIABILITY.md,
// "R4" - DB/Redis/email transient-failure handling): a shared bounded
// retry-with-backoff helper (retry.js), applied to read-only DB queries
// (config/db.js) and Resend email sends (mailer.js). None of these touch a
// real network - retry.js is pure, the DB test uses a disposable fake pool
// object (not the real exported singleton), and the mailer classifier is
// tested as a plain function against fabricated error shapes. Importing
// mailer.js here (even indirectly, via this test) never constructs a real
// Resend client or needs RESEND_API_KEY set - mailer.js builds that client
// lazily, only inside sendMail(), specifically so importing the module
// can't crash a test file that never calls sendMail() at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { retryWithBackoff } from "../retry.js";
import { isRetryableConnectionError, isSelectOnly, wrapPoolQueryWithRetry } from "../config/db.js";
import { isRetryableResendError } from "../mailer.js";

test("retryWithBackoff: succeeds without retrying when the first attempt works", async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("retryWithBackoff: retries a retryable failure and eventually succeeds", async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
    { retries: 3, baseDelayMs: 1, isRetryable: () => true }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3, "must have retried exactly twice before succeeding on the third attempt");
});

test("retryWithBackoff: gives up after exhausting the retry budget and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error("always fails");
        },
        { retries: 2, baseDelayMs: 1, isRetryable: () => true }
      ),
    /always fails/
  );
  assert.equal(calls, 3, "the original attempt plus exactly 2 retries, then give up");
});

test("retryWithBackoff: never retries an error isRetryable rejects", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error("permanent");
        },
        { retries: 5, baseDelayMs: 1, isRetryable: () => false }
      ),
    /permanent/
  );
  assert.equal(calls, 1, "a non-retryable error must fail immediately, using none of the retry budget");
});

// --- config/db.js: query classification and the pool.query wrapper -----

test("isSelectOnly: true only for SELECT text, false for writes and non-strings", () => {
  assert.equal(isSelectOnly("select * from submissions"), true);
  assert.equal(isSelectOnly("  SELECT 1"), true, "must be case/whitespace tolerant");
  assert.equal(isSelectOnly("insert into submissions (x) values (1)"), false);
  assert.equal(isSelectOnly("update submissions set x = 1"), false);
  assert.equal(isSelectOnly("delete from submissions"), false);
  assert.equal(isSelectOnly({ text: "select 1" }), false, "a QueryConfig object, not a string, must not be treated as a SELECT");
});

test("isRetryableConnectionError: true for connection-class failures, false for real query errors", () => {
  assert.equal(isRetryableConnectionError({ code: "ECONNREFUSED" }), true);
  assert.equal(isRetryableConnectionError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableConnectionError({ code: "57P03" }), true, "Postgres 'cannot connect now'");
  assert.equal(isRetryableConnectionError({ message: "Connection terminated unexpectedly" }), true);
  assert.equal(isRetryableConnectionError({ code: "23505", message: "duplicate key value violates unique constraint" }), false, "a real constraint-violation error must never be retried");
  assert.equal(isRetryableConnectionError({ code: "42601", message: "syntax error" }), false);
});

test("wrapPoolQueryWithRetry: retries a failing SELECT on a connection error and succeeds once the fake pool recovers", async () => {
  let calls = 0;
  const fakePool = {
    query: async (text) => {
      calls++;
      if (calls < 2) throw new Error("Connection terminated unexpectedly");
      return { rows: [{ ok: true }], text };
    },
  };
  wrapPoolQueryWithRetry(fakePool);

  const result = await fakePool.query("select 1");
  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.equal(calls, 2, "must have retried once after the simulated connection failure");
});

test("wrapPoolQueryWithRetry: never retries a write, even on a connection error, and fails immediately", async () => {
  let calls = 0;
  const fakePool = {
    query: async () => {
      calls++;
      throw new Error("Connection terminated unexpectedly");
    },
  };
  wrapPoolQueryWithRetry(fakePool);

  await assert.rejects(() => fakePool.query("insert into submissions (x) values (1)"), /Connection terminated unexpectedly/);
  assert.equal(calls, 1, "an INSERT must never be retried, even for a connection-class error - it might have already executed");
});

test("wrapPoolQueryWithRetry: never retries a SELECT that fails with a real (non-connection) query error", async () => {
  let calls = 0;
  const fakePool = {
    query: async () => {
      calls++;
      const err = new Error("syntax error at or near \"selct\"");
      err.code = "42601";
      throw err;
    },
  };
  wrapPoolQueryWithRetry(fakePool);

  await assert.rejects(() => fakePool.query("selct 1"), /syntax error/);
  assert.equal(calls, 1, "a genuine query error must surface immediately, not be mistaken for a transient connection failure");
});

// --- mailer.js: Resend failure classification ---------------------------

test("isRetryableResendError: rate limits, 5xx, and network-level errors are retryable; everything else is not", () => {
  assert.equal(isRetryableResendError({ name: "rate_limit_exceeded" }), true);
  assert.equal(isRetryableResendError({ name: "internal_server_error", statusCode: 500 }), true);
  assert.equal(isRetryableResendError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableResendError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableResendError({ name: "invalid_api_key", statusCode: 401 }), false, "a config problem must never be retried - it will fail identically every time");
  assert.equal(isRetryableResendError({ name: "invalid_from_address", statusCode: 422 }), false);
  assert.equal(isRetryableResendError({ name: "daily_quota_exceeded", statusCode: 429 }), false, "a quota (not a rate limit) exhaustion won't clear by retrying moments later");
  assert.equal(isRetryableResendError({ message: "some unrelated error" }), false);
});
