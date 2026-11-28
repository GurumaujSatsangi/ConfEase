// Regression tests for the admin "Manage Users" section (views/admin.ejs):
// create/update/delete a `users` row, send a password reset link, and send
// a "Profile Update Required" email with admin-supplied remarks. Generic
// anonymous/non-admin rejection for these same routes is covered by
// test/authz.test.mjs's ADMIN_ROUTES table; this file adds the concrete
// side-effect assertions and the admin-authorized "happy path" for each.
// sendMail is intercepted via mailer.js's test-only recorder
// (SKIP_AUTOLISTEN=1), so no real email is sent by this test.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || "admin-users-test-admin@example.com";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");
const { testSentEmails, resetTestSentEmails } = await import("../mailer.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const adminEmail = "admin-users-test-admin@example.com";
const strangerEmail = "admin-users-test-stranger@example.com";
const targetEmail = "admin-users-test-target@example.com";
const newUserEmail = "admin-users-test-new-" + crypto.randomBytes(3).toString("hex") + "@example.com";

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
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

before(async () => {
  await pool.query(
    "insert into users (name, email, password, status, contact_number, affiliation) values ($1,$2,'x','ACCOUNT ACTIVATED',$3,$4) on conflict (email) do nothing",
    [targetEmail, targetEmail, "1111111111", "Old Affiliation"]
  );
});

beforeEach(() => {
  resetTestSentEmails();
});

after(async () => {
  await pool.query("delete from users where email = $1 or email = $2", [targetEmail, newUserEmail]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a valid admin request creates a new user row and emails a setup link", async () => {
  const res = await post(
    "/admin/users/create",
    { name: "Admin Users Test New", email: newUserEmail, contact_number: "2222222222", affiliation: "New Affiliation" },
    accessFor(adminEmail)
  );
  assert.equal(res.status, 302);
  assert.match(loc(res), /password setup link has been sent/);

  const row = await pool.query("select name, status, affiliation from users where email = $1", [newUserEmail]);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].status, "ACCOUNT ACTIVATED");
  assert.equal(row.rows[0].affiliation, "New Affiliation");

  assert.equal(testSentEmails.length, 1);
  assert.equal(testSentEmails[0].to, newUserEmail);
});

test("creating a user with an email that already exists is rejected, with no duplicate row", async () => {
  const res = await post(
    "/admin/users/create",
    { name: "Duplicate Attempt", email: targetEmail, contact_number: "0", affiliation: "x" },
    accessFor(adminEmail)
  );
  assert.equal(res.status, 302);
  assert.match(loc(res), /already exists/);
  assert.equal(testSentEmails.length, 0);
});

test("an admin can update a user's name, contact number, and affiliation", async () => {
  const res = await post(
    "/admin/users/update/" + encodeURIComponent(targetEmail),
    { name: "Renamed By Admin", contact_number: "3333333333", affiliation: "Updated Affiliation" },
    accessFor(adminEmail)
  );
  assert.equal(res.status, 302);
  assert.match(loc(res), /Profile updated/);

  const row = await pool.query("select name, contact_number, affiliation from users where email = $1", [targetEmail]);
  assert.equal(row.rows[0].name, "Renamed By Admin");
  assert.equal(row.rows[0].contact_number, "3333333333");
  assert.equal(row.rows[0].affiliation, "Updated Affiliation");
});

test("updating a user with an empty name is rejected", async () => {
  const res = await post(
    "/admin/users/update/" + encodeURIComponent(targetEmail),
    { name: "   ", contact_number: "x", affiliation: "x" },
    accessFor(adminEmail)
  );
  assert.equal(res.status, 302);
  assert.match(loc(res), /Name cannot be empty/);

  const row = await pool.query("select name from users where email = $1", [targetEmail]);
  assert.equal(row.rows[0].name, "Renamed By Admin", "the previous name must be left untouched");
});

test("an admin can send a password reset link to a user", async () => {
  const res = await post("/admin/users/reset-password/" + encodeURIComponent(targetEmail), {}, accessFor(adminEmail));
  assert.equal(res.status, 302);
  assert.match(loc(res), /password reset link has been sent/);

  assert.equal(testSentEmails.length, 1);
  assert.equal(testSentEmails[0].to, targetEmail);

  const tokenRow = await pool.query("select 1 from password_resets where email = $1", [targetEmail]);
  assert.equal(tokenRow.rows.length, 1, "a password_resets row must be created for the self-service reset flow to pick up");
});

test("an admin can send a Profile Update Required email with their own remarks", async () => {
  const res = await post(
    "/admin/users/request-profile-update/" + encodeURIComponent(targetEmail),
    { remarks: "Please update your affiliation to your current institution." },
    accessFor(adminEmail)
  );
  assert.equal(res.status, 302);
  assert.match(loc(res), /emailed/);

  assert.equal(testSentEmails.length, 1);
  assert.equal(testSentEmails[0].to, targetEmail);
});

test("Profile Update Required is rejected with no remarks, and sends no email", async () => {
  const res = await post("/admin/users/request-profile-update/" + encodeURIComponent(targetEmail), { remarks: "   " }, accessFor(adminEmail));
  assert.equal(res.status, 302);
  assert.match(loc(res), /enter remarks/);
  assert.equal(testSentEmails.length, 0);
});

test("a non-admin cannot update, delete, reset the password of, or request a profile update for a user", async () => {
  const token = accessFor(strangerEmail);
  for (const res of await Promise.all([
    post("/admin/users/update/" + encodeURIComponent(targetEmail), { name: "Hacked", contact_number: "", affiliation: "" }, token),
    post("/admin/users/delete/" + encodeURIComponent(targetEmail), {}, token),
    post("/admin/users/reset-password/" + encodeURIComponent(targetEmail), {}, token),
    post("/admin/users/request-profile-update/" + encodeURIComponent(targetEmail), { remarks: "x" }, token),
  ])) {
    assert.equal(res.status, 403);
  }

  const row = await pool.query("select name from users where email = $1", [targetEmail]);
  assert.equal(row.rows[0].name, "Renamed By Admin", "a non-admin must not be able to change the name");
  assert.equal(testSentEmails.length, 0);
});

test("an admin can delete a user", async () => {
  const res = await post("/admin/users/delete/" + encodeURIComponent(targetEmail), {}, accessFor(adminEmail));
  assert.equal(res.status, 302);
  assert.match(loc(res), /Deleted/);

  const row = await pool.query("select 1 from users where email = $1", [targetEmail]);
  assert.equal(row.rows.length, 0);
});
