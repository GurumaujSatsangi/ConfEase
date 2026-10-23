// Regression test: POST /update-profile was registered as app.update(...),
// which isn't a real Express method (app has no .update) - calling it
// threw a TypeError the moment api/index.js was loaded, crashing the
// entire server (every route, not just this one) on startup. Fixed to
// app.post(...), which also cleans up its success check (the old
// `if (data)` was always true - a pg query result object is truthy
// regardless of whether any row was actually affected) and redirects back
// to /my-profile (previously /dashboard) so the chair/author sees the
// change reflected immediately on the same page. GET /my-profile now also
// passes `message` through from req.query, which it never did before, so
// that redirect's confirmation actually renders.
// Uses the real route and the real local Postgres database.

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
const userEmail = "update-profile-test@example.com";
const userToken = jwt.sign({ typ: "access", email: userEmail, name: "Update Profile Test", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

before(async () => {
  await pool.query(
    "insert into users (name, email, password) values ($1,$2,$3) on conflict (email) do nothing",
    ["Update Profile Test", userEmail, "irrelevant"]
  );
});

after(async () => {
  await pool.query("delete from users where email = $1", [userEmail]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("an unauthenticated request is blocked", async () => {
  const res = await fetch(base + "/update-profile", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ affiliation: "Should not be saved" }),
  });
  assert.notEqual(res.status, 200);

  const row = await pool.query("select affiliation from users where email = $1", [userEmail]);
  assert.equal(row.rows[0].affiliation, null, "an unauthenticated request must never write the affiliation");
});

test("POST /update-profile saves the affiliation and redirects back to /my-profile with a confirmation message", async () => {
  const res = await post("/update-profile", userToken, { affiliation: "DEI Multimedia Laboratory" });
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /^\/my-profile\?message=/, "must redirect back to /my-profile, not /dashboard");
  assert.match(location, /Profile updated successfully/);

  const row = await pool.query("select affiliation from users where email = $1", [userEmail]);
  assert.equal(row.rows[0].affiliation, "DEI Multimedia Laboratory");
});

test("GET /my-profile actually renders the message passed via ?message=", async () => {
  const res = await get("/my-profile?message=" + encodeURIComponent("Profile updated successfully!"), userToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Profile updated successfully!/, "the confirmation message must actually render, not be silently dropped");
});

test("GET /my-profile shows the saved affiliation pre-filled in the editable field", async () => {
  const res = await get("/my-profile", userToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /name="affiliation"/);
  assert.match(html, /value="DEI Multimedia Laboratory"/);
});
