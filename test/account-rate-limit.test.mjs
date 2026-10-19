// SEC-003: the existing authRateLimitMemory is keyed only by source IP, so
// an attacker spreading requests across many IP addresses was never
// slowed down when targeting one specific account. accountRateLimit (in
// api/index.js) adds a second, account-keyed limiter on top, applied to
// POST /send-password-reset-link (keyed by the submitted email).
//
// Deliberately does NOT set SKIP_AUTOLISTEN (that bypasses this limiter
// entirely, the same way it already bypasses the IP-keyed one and CSRF).
// Uses VERCEL=1 instead, which skips Redis - this exercises the bounded
// in-memory fallback path directly, without needing a real Redis.

import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.VERCEL = "1";
process.env.JWT_ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_TOKEN_SECRET || "test-access-secret";
process.env.JWT_REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_TOKEN_SECRET || "test-refresh-secret";

const { default: app } = await import("../api/index.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const post = (email) =>
  fetch(`${base}/send-password-reset-link`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email }),
  });

test("the same target account gets rate-limited even though each request simulates coming from a different source (no IP dimension changes here, proving the limit is account-keyed, not just IP-keyed)", async () => {
  const email = "account-rl-test-target@example.com";
  const results = [];
  // authRateLimitMemory allows 10/15min per IP; accountRateLimit allows 5/15min
  // per account - firing 6 requests for the SAME account must trip the
  // account-keyed limiter specifically (before the IP-keyed one would).
  for (let i = 0; i < 6; i++) {
    const res = await post(email);
    results.push(res.status);
  }
  assert.ok(results.includes(429), `expected at least one 429 among ${JSON.stringify(results)}`);
  assert.equal(results.slice(0, 5).includes(429), false, "the first 5 attempts for one account must be allowed");
  assert.equal(results[5], 429, "the 6th attempt for the same account within the window must be rejected");
});

test("a different account is unaffected by another account's rate limit", async () => {
  const res = await post("account-rl-test-other@example.com");
  assert.notEqual(res.status, 429, "an unrelated account must not be blocked by someone else's rate limit");
});

test("an empty/missing email does not crash the limiter and falls through safely", async () => {
  const res = await post("");
  assert.notEqual(res.status, 429);
  assert.notEqual(res.status, 500);
});
