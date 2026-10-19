// SEC-002: a password reset previously never touched the sessions table -
// a refresh token issued before the reset kept working for the rest of its
// 7-day life, defeating the point of resetting a password because of
// suspected compromise. POST /update-password now revokes every existing
// session for that user in the same transaction as the password change and
// the reset-token consumption.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import bcrypt from "bcrypt";

process.env.JWT_ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_TOKEN_SECRET || "test-access-secret";
process.env.JWT_REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_TOKEN_SECRET || "test-refresh-secret";
process.env.SKIP_AUTOLISTEN = "1"; // bypasses authRateLimitMemory and CSRF, same as every other route test

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body),
  });
const get = (path, headers = {}) => fetch(base + path, { redirect: "manual", headers });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const email = "pwreset-revoke-test@example.com";
let userId;

after(async () => {
  if (userId) {
    await pool.query("delete from sessions where user_id = $1", [userId]);
    await pool.query("delete from password_resets where email = $1", [email]);
    await pool.query("delete from users where id = $1", [userId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a password reset revokes every existing session, and the old refresh token can no longer mint a new access token", async () => {
  const oldPasswordHash = await bcrypt.hash("OldPassw0rd1", 10);
  const userResult = await pool.query(
    "insert into users (name, email, password, status) values ($1,$2,$3,'ACCOUNT ACTIVATED') returning id",
    ["Reset Revocation Test", email, oldPasswordHash]
  );
  userId = userResult.rows[0].id;

  // A real, previously-issued refresh token for this user, with a matching
  // session row - exactly what a logged-in session (or a stolen token)
  // looks like right before the owner resets their password.
  const oldRefreshToken = jwt.sign({ typ: "refresh", user_id: userId }, process.env.JWT_REFRESH_TOKEN_SECRET, { expiresIn: "7d" });
  await pool.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'test-agent', NOW() + INTERVAL '7 days')`,
    [userId, hashToken(oldRefreshToken)]
  );

  // Confirm the old refresh token actually works before the reset (so the
  // test proves something, rather than it having been broken all along).
  // checkAuth's own silent-refresh fallback is the real mechanism this app
  // uses (no access_token cookie here, only the refresh_token) - a request
  // to any checkAuth-protected page with a valid refresh token succeeds
  // (200) instead of redirecting to login.
  const dashboardBefore = await get("/dashboard", { Cookie: `refresh_token=${oldRefreshToken}` });
  assert.equal(dashboardBefore.status, 200, "the refresh token must still work before the reset");

  // Set up a real, valid password-reset token the same way /send-password-reset-link does.
  const rawResetToken = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO password_resets (email, token, expires_at) VALUES ($1,$2, NOW() + INTERVAL '15 minutes')",
    [email, hashToken(rawResetToken)]
  );

  const resetRes = await post("/update-password", { token: rawResetToken, new_password: "NewPassw0rd2" });
  assert.equal(resetRes.status, 302);
  assert.match(loc(resetRes), /Password Updated/);

  // The reset token must be consumed (single-use).
  const tokenRow = await pool.query("select 1 from password_resets where token = $1", [hashToken(rawResetToken)]);
  assert.equal(tokenRow.rows.length, 0, "the reset token must be deleted after use");

  // The session row must now be revoked.
  const sessionRow = await pool.query("select is_revoked from sessions where user_id = $1", [userId]);
  assert.equal(sessionRow.rows[0].is_revoked, true, "the pre-reset session must be revoked");

  // The old refresh token must no longer be able to mint a new access
  // token - the same checkAuth path that succeeded above must now redirect
  // to login instead.
  const dashboardAfter = await get("/dashboard", { Cookie: `refresh_token=${oldRefreshToken}` });
  assert.equal(dashboardAfter.status, 302, "the old refresh token must be rejected after the password reset");
  assert.match(loc(dashboardAfter), /\/login\/user/);

  // The new password must actually be in effect.
  const userRow = await pool.query("select password from users where id = $1", [userId]);
  assert.equal(await bcrypt.compare("NewPassw0rd2", userRow.rows[0].password), true);
  assert.equal(await bcrypt.compare("OldPassw0rd1", userRow.rows[0].password), false);
});
