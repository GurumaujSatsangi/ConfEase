// SEC-008: activation_requests.activation_code previously never expired.
// Migration 024 adds expires_at (defaulting to now()+24h, non-destructive -
// existing pending rows got a fresh 24h window rather than being
// invalidated), and POST /activate-account now checks it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

const createdEmails = [];
after(async () => {
  for (const email of createdEmails) {
    await pool.query("delete from activation_requests where email = $1", [email]);
    await pool.query("delete from users where email = $1", [email]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

async function createPendingUser(email) {
  createdEmails.push(email);
  await pool.query("insert into users (name, email, password, status) values ($1,$2,'x','ACTIVATION PENDING')", ["Test", email]);
}

test("a valid, unexpired activation code activates the account and is then single-use", async () => {
  const email = "activation-expiry-test-valid@example.com";
  await createPendingUser(email);
  const code = crypto.randomUUID();
  await pool.query("insert into activation_requests (email, activation_code, expires_at) values ($1,$2, NOW() + INTERVAL '1 hour')", [email, code]);

  const res = await post("/activate-account", { activation_code: code });
  assert.equal(res.status, 302);
  assert.match(loc(res), /\/login\/user/);

  const userRow = await pool.query("select status from users where email = $1", [email]);
  assert.equal(userRow.rows[0].status, "ACCOUNT ACTIVATED");

  // Reusing the same code must now fail - the row was deleted on success.
  const reuse = await post("/activate-account", { activation_code: code });
  assert.match(loc(reuse), /Invalid or expired activation code/);
});

test("an expired activation code is rejected and does not activate the account", async () => {
  const email = "activation-expiry-test-expired@example.com";
  await createPendingUser(email);
  const code = crypto.randomUUID();
  await pool.query("insert into activation_requests (email, activation_code, expires_at) values ($1,$2, NOW() - INTERVAL '1 hour')", [email, code]);

  const res = await post("/activate-account", { activation_code: code });
  assert.match(loc(res), /Invalid or expired activation code/);

  const userRow = await pool.query("select status from users where email = $1", [email]);
  assert.equal(userRow.rows[0].status, "ACTIVATION PENDING", "an expired code must not activate the account");
});

test("an invalid/unknown activation code is rejected", async () => {
  const res = await post("/activate-account", { activation_code: crypto.randomUUID() });
  assert.match(loc(res), /Invalid or expired activation code/);
});

// activation_requests.activation_code is uuid-typed - a malformed, non-UUID
// string (e.g. a password-reset token's 64-char hex shape, pasted into the
// wrong field) previously fell into the route's generic catch block and
// showed "Server Error", with a raw Postgres uuid-cast error in the logs.
test("a malformed (non-UUID-shaped) activation code gets a clear, specific message instead of a generic server error", async () => {
  const res = await post("/activate-account", { activation_code: "not-a-valid-uuid-at-all" });
  assert.equal(res.status, 302);
  assert.match(loc(res), /Invalid activation code/);
  assert.doesNotMatch(loc(res), /Server Error/);
});
