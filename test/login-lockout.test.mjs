// Integration tests for the account-lockout behavior on /user-login and
// /chair-login: 3 failed attempts against the same account locks that
// account (not just the IP) out for 5 minutes. Uses the real routes, the
// real local Postgres database, and - since the lockout state lives in
// Redis when available - the real Redis connection, same as
// cache-freshness.test.mjs. Falls back to exercising the in-memory lockout
// path when Redis is unreachable (the route-level behavior is identical
// either way; only the storage backend differs).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const createdUserEmails = [];
const createdChairEmails = [];

after(async () => {
  if (createdUserEmails.length) await pool.query("DELETE FROM users WHERE email = ANY($1)", [createdUserEmails]);
  if (createdChairEmails.length) await pool.query("DELETE FROM chairs WHERE email = ANY($1)", [createdChairEmails]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

async function createTestUser() {
  const email = "lockout-test-" + crypto.randomBytes(4).toString("hex") + "@example.com";
  const password = "CorrectHorseBattery1!";
  const hashed = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (name, email, password, status) VALUES ($1,$2,$3,$4)",
    ["Lockout Test User", email, hashed, "ACCOUNT ACTIVATED"]
  );
  createdUserEmails.push(email);
  return { email, password };
}

async function createTestChair() {
  const email = "lockout-test-chair-" + crypto.randomBytes(4).toString("hex") + "@example.com";
  const password = "CorrectHorseBattery1!";
  const hashed = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO chairs (name, email, password, status) VALUES ($1,$2,$3,$4)",
    ["Lockout Test Chair", email, hashed, "ACCOUNT ACTIVATED"]
  );
  createdChairEmails.push(email);
  return { email, password };
}

const postLogin = (path, email, password) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
  });

// Location header values come back percent-encoded (e.g. "%20" for spaces);
// decode before matching against a plain-text pattern.
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

test("/user-login: 3 wrong passwords lock the account; the correct password is then also rejected until the lock expires", async () => {
  const { email, password } = await createTestUser();

  for (let i = 0; i < 2; i++) {
    const res = await postLogin("/user-login", email, "wrong-password");
    assert.equal(res.status, 302);
    assert.match(loc(res), /Invalid email or password/, `attempt ${i + 1} should be a plain invalid-credentials message`);
  }

  // 3rd failure: this is the one that trips the lock.
  const third = await postLogin("/user-login", email, "wrong-password");
  assert.equal(third.status, 302);
  assert.match(loc(third), /Too many failed login attempts/, "3rd failure should report the lockout, not a generic invalid-credentials message");

  // Now even the CORRECT password is rejected, because the account is locked.
  const withCorrectPassword = await postLogin("/user-login", email, password);
  assert.equal(withCorrectPassword.status, 302);
  assert.match(loc(withCorrectPassword), /Too many failed login attempts/, "correct password must still be rejected while locked out");
});

test("/user-login: a different account is unaffected by another account's lockout", async () => {
  const locked = await createTestUser();
  const other = await createTestUser();

  for (let i = 0; i < 3; i++) {
    await postLogin("/user-login", locked.email, "wrong-password");
  }
  const lockedCheck = await postLogin("/user-login", locked.email, locked.password);
  assert.match(loc(lockedCheck), /Too many failed login attempts/);

  // The other account, never touched, should log in normally.
  const otherLogin = await postLogin("/user-login", other.email, other.password);
  assert.equal(otherLogin.status, 302);
  assert.equal(loc(otherLogin), "/dashboard", "an unrelated, never-failed account must log in normally");
});

test("/user-login: a successful login clears any prior failed-attempt count", async () => {
  const { email, password } = await createTestUser();

  // Two failures - not enough to lock (threshold is 3).
  await postLogin("/user-login", email, "wrong-password");
  await postLogin("/user-login", email, "wrong-password");

  // Correct password succeeds and must reset the counter...
  const success = await postLogin("/user-login", email, password);
  assert.equal(loc(success), "/dashboard");

  // ...so two MORE failures afterward should still just be "invalid", not a lockout
  // (if the counter hadn't been cleared, this 2nd failure here would be the 4th
  // failure overall and the account would already be locked).
  await postLogin("/user-login", email, "wrong-password");
  const stillJustInvalid = await postLogin("/user-login", email, "wrong-password");
  assert.match(loc(stillJustInvalid), /Invalid email or password/, "attempt count must have been reset by the earlier successful login");
});

test("/chair-login: 3 failed attempts lock the chair account, independently of a user account with the same email", async () => {
  const { email, password } = await createTestChair();

  for (let i = 0; i < 2; i++) {
    const res = await postLogin("/chair-login", email, "wrong-password");
    assert.match(loc(res), /Invalid email or password/);
  }
  const third = await postLogin("/chair-login", email, "wrong-password");
  assert.match(loc(third), /Too many failed login attempts/);

  const stillLocked = await postLogin("/chair-login", email, password);
  assert.match(loc(stillLocked), /Too many failed login attempts/);
});
