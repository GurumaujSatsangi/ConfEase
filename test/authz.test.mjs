// Authorization regression checks that need no database and no Redis.
// Every request below is answered before any query runs (redirect, 403, 404, or a validation redirect).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// Test-only values (not real secrets). dotenv does not override variables that are already set.
process.env.VERCEL = "1";
process.env.JWT_ACCESS_TOKEN_SECRET = "test-access-secret";
process.env.JWT_REFRESH_TOKEN_SECRET = "test-refresh-secret";
process.env.ADMIN_EMAILS = "boss@example.com";

const { default: app } = await import("../api/index.js");
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const accessFor = (email) =>
  jwt.sign({ typ: "access", email, name: "Test", user_id: 1, role: "user", roles: {} }, process.env.JWT_ACCESS_TOKEN_SECRET, { expiresIn: "5m" });

const send = (method, path, headers = {}) => fetch(base + path, { method, redirect: "manual", headers });

const ADMIN_ROUTES = [
  ["GET", "/admin"],
  ["POST", "/create-chair-credentials"],
  ["POST", "/reset-chair-password/chair%40example.com"],
  ["POST", "/grant-access/chair%40example.com"],
  ["POST", "/revoke-access/chair%40example.com"],
  ["POST", "/delete-account/chair%40example.com"],
];

test("admin routes: anonymous users are sent to login", async () => {
  for (const [method, path] of ADMIN_ROUTES) {
    const res = await send(method, path);
    assert.equal(res.status, 302, `${method} ${path}`);
    assert.match(res.headers.get("location") || "", /^\/login\/user/, `${method} ${path}`);
  }
});

test("admin routes: authenticated non-admins get 403 (ADMIN_EMAILS is the only grant)", async () => {
  const token = accessFor("student@example.com");
  for (const [method, path] of ADMIN_ROUTES) {
    const res = await send(method, path, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test("admin routes: a chair-looking or reviewer-looking address is not an admin", async () => {
  const token = accessFor("reviewer@example.com");
  const res = await send("GET", "/admin", { Authorization: `Bearer ${token}` });
  assert.equal(res.status, 403);
});

test("admin routes fail closed when ADMIN_EMAILS is unset", async () => {
  const saved = process.env.ADMIN_EMAILS;
  try {
    delete process.env.ADMIN_EMAILS;
    const res = await send("GET", "/admin", { Authorization: `Bearer ${accessFor("boss@example.com")}` });
    assert.equal(res.status, 403);
  } finally {
    process.env.ADMIN_EMAILS = saved;
  }
});

test("state-changing admin actions are not reachable via GET", async () => {
  for (const path of ["/grant-access/x", "/revoke-access/x", "/delete-account/x", "/reset-chair-password/x"]) {
    const res = await send("GET", path);
    assert.equal(res.status, 404, `GET ${path}`);
  }
});

test("score-posters and co-author request views require authentication", async () => {
  for (const path of ["/score-posters/1", "/submission/view-co-author-requests/1"]) {
    const res = await send("GET", path);
    assert.equal(res.status, 302, path);
    assert.match(res.headers.get("location") || "", /^\/login\/user/, path);
  }
});

test("chair password setup rejects weak passwords before touching the database", async () => {
  const body = new URLSearchParams({ token: "abc", password: "weak" });
  const res = await fetch(base + "/chair-password-setup", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /^\/chair-password-setup\?token=abc&message=/);
});

test("security headers are set", async () => {
  const res = await send("GET", "/error");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
});
