// Minimal regression checks that need no database and no Redis.
// Routes exercised here either redirect before any query runs or render static pages.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// Test-only values (not real secrets). dotenv does not override variables that are already set.
process.env.VERCEL = "1"; // skips the Redis connection and app.listen()
process.env.JWT_ACCESS_TOKEN_SECRET = "test-access-secret";
process.env.JWT_REFRESH_TOKEN_SECRET = "test-refresh-secret";

const { default: app } = await import("../api/index.js");
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const noRedirect = (method, path, options = {}) => fetch(base + path, { method, redirect: "manual", ...options });

test("anonymous requests to protected routes are redirected to login", async () => {
  const protectedRoutes = [
    ["POST", "/chair/dashboard/update-conference/1"],
    ["POST", "/chair/dashboard/update-track/1"],
    ["POST", "/chair/dashboard/delete-conference/1"],
    ["POST", "/chair/dashboard/delete-submission/1?conference_id=1"],
    ["POST", "/submission/delete/primary-author/1"],
    ["POST", "/submission/delete/invitee/1"],
    ["POST", "/edit-submission"],
    ["POST", "/final-camera-ready-submission"],
    ["GET", "/chair/dashboard/edit-sessions/1"],
    ["POST", "/chair/dashboard/set-session/1"],
    ["POST", "/chair/dashboard/manage-sessions/1"],
  ];
  for (const [method, path] of protectedRoutes) {
    const res = await noRedirect(method, path);
    assert.equal(res.status, 302, `${method} ${path}`);
    assert.match(res.headers.get("location") || "", /^\/login\/user/, `${method} ${path}`);
  }
});

test("destructive actions are no longer available via GET", async () => {
  const res = await noRedirect("GET", "/chair/dashboard/delete-conference/1");
  assert.equal(res.status, 404);
  const logout = await noRedirect("GET", "/logout");
  assert.equal(logout.status, 404);
});

test("unknown routes return 404", async () => {
  const res = await noRedirect("GET", "/this-route-does-not-exist");
  assert.equal(res.status, 404);
});

test("tokens of the wrong type do not authenticate as a user", async () => {
  const wrongTypes = [
    jwt.sign({ typ: "vote", submission_id: "1", user_ip: "127.0.0.1" }, process.env.JWT_ACCESS_TOKEN_SECRET),
    jwt.sign({ typ: "refresh", user_id: 1 }, process.env.JWT_ACCESS_TOKEN_SECRET),
    jwt.sign({ typ: "chair", email: "chair@example.com", role: "chair" }, process.env.JWT_ACCESS_TOKEN_SECRET),
  ];
  for (const token of wrongTypes) {
    const res = await noRedirect("POST", "/submit", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") || "", /^\/login\/user/);
  }
});

test("logout clears session cookies without touching the database when no cookie is present", async () => {
  const res = await noRedirect("POST", "/logout");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login/user");
});
