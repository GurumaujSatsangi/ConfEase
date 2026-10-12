// Regression tests for AUTHZ-01 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// POST /create-chair-credentials previously had no auth middleware at all,
// letting anyone create a fully-activated Chair account. Fixed by adding the
// same `checkAuth, requireAdmin` guard used by every sibling admin route.
//
// Anonymous/non-admin rejection is already covered generically (as part of
// the ADMIN_ROUTES table) by test/authz.test.mjs; this file adds the
// concrete side-effect assertion that AUTHZ-01 specifically called for:
// rejected requests must not create a database row. The "valid admin still
// works" path is verified by confirming the chairs row is created - this
// route calls sendMail() unconditionally (not wrapped in try/catch, matching
// its pre-existing behavior, which this fix deliberately does not change),
// so a real outbound email attempt is made; with no real SMTP credentials
// configured for tests, that call is expected to fail after the row is
// already written, which is exactly why the test only asserts on the
// database side effect rather than the HTTP response for the success case.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || "chair-cred-test-admin@example.com";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const adminEmail = "chair-cred-test-admin@example.com";
const strangerEmail = "chair-cred-test-stranger@example.com";
const newChairEmail = "cc-test-" + crypto.randomBytes(3).toString("hex") + "@example.com";

const accessFor = (email) =>
  jwt.sign({ typ: "access", email, name: "Test", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const post = (path, body, token) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: new URLSearchParams(body),
  });

after(async () => {
  await pool.query("delete from chairs where email = $1", [newChairEmail]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("an anonymous request creates no chair row", async () => {
  const res = await post("/create-chair-credentials", {
    name: "Anon Attempt",
    email: newChairEmail,
    contact_number: "0000000000",
    faculty: "x",
    department: "x",
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /^\/login\/user/);

  const row = await pool.query("select 1 from chairs where email = $1", [newChairEmail]);
  assert.equal(row.rows.length, 0, "no chair row should be created for an unauthenticated request");
});

test("an authenticated non-admin request creates no chair row", async () => {
  const res = await post(
    "/create-chair-credentials",
    { name: "Non-Admin Attempt", email: newChairEmail, contact_number: "0000000000", faculty: "x", department: "x" },
    accessFor(strangerEmail)
  );
  assert.equal(res.status, 403);

  const row = await pool.query("select 1 from chairs where email = $1", [newChairEmail]);
  assert.equal(row.rows.length, 0, "no chair row should be created for a non-admin request");
});

test("a valid admin request still creates the chair row", async () => {
  await post(
    "/create-chair-credentials",
    { name: "Real New Chair", email: newChairEmail, contact_number: "1111111111", faculty: "Engineering", department: "CS" },
    accessFor(adminEmail)
  );
  // Not asserting on the HTTP response here: this route calls sendMail()
  // unconditionally after the insert, with no real SMTP credentials
  // configured for the test environment - that call may fail and surface
  // as a 500, which is pre-existing behavior this fix does not change. The
  // row write happens first and is what this test is actually verifying.
  const row = await pool.query("select name, status from chairs where email = $1", [newChairEmail]);
  assert.equal(row.rows.length, 1, "a valid admin must still be able to create a chair row");
  assert.equal(row.rows[0].status, "ACCOUNT ACTIVATED");
});
