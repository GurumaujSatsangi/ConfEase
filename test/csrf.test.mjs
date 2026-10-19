// SEC-005: CSRF defense-in-depth on top of the existing SameSite=Strict
// cookies (csrf.js). Unit tests cover the module's pure logic directly;
// the integration test at the bottom exercises the real, wired-up
// middleware end to end against a running instance of the app - this file
// deliberately does NOT set SKIP_AUTOLISTEN (which bypasses CSRF
// enforcement, the same way it already bypasses rate limiting - see
// verifyCsrfToken in csrf.js), since that's exactly the behavior being
// tested here.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  isValidCsrfToken,
  verifyCsrfToken,
  csrfRejectUnlessSkipped,
  CSRF_FIELD_NAME,
  CSRF_EXEMPT_PATHS,
} from "../csrf.js";

// --- Unit tests: pure logic, no app/server needed -------------------------

function fakeReq({ method = "POST", path = "/some-route", session = {}, body = {}, cookies = {}, isMultipart = false } = {}) {
  return {
    method,
    path,
    session,
    body,
    cookies,
    is: (type) => (isMultipart ? type === "multipart/form-data" : false),
  };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    redirect(to) { this.redirectedTo = to; return this; },
  };
  return res;
}

test("isValidCsrfToken: true only when the submitted field matches the session secret", () => {
  const req = fakeReq({ session: { csrfSecret: "abc123" }, body: { [CSRF_FIELD_NAME]: "abc123" } });
  assert.equal(isValidCsrfToken(req), true);
});

test("isValidCsrfToken: false when the field is missing", () => {
  const req = fakeReq({ session: { csrfSecret: "abc123" }, body: {} });
  assert.equal(isValidCsrfToken(req), false);
});

test("isValidCsrfToken: false when the field doesn't match", () => {
  const req = fakeReq({ session: { csrfSecret: "abc123" }, body: { [CSRF_FIELD_NAME]: "wrong" } });
  assert.equal(isValidCsrfToken(req), false);
});

test("isValidCsrfToken: false when there is no session secret yet", () => {
  const req = fakeReq({ session: {}, body: { [CSRF_FIELD_NAME]: "anything" } });
  assert.equal(isValidCsrfToken(req), false);
});

test("verifyCsrfToken: GET/HEAD requests are never checked", () => {
  const req = fakeReq({ method: "GET", session: { csrfSecret: "abc" }, body: {} });
  const res = fakeRes();
  let nextCalled = false;
  verifyCsrfToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("verifyCsrfToken: requests with no auth cookie at all pass through (the route's own auth check handles them)", () => {
  const req = fakeReq({ method: "POST", cookies: {}, session: { csrfSecret: "abc" }, body: {} });
  const res = fakeRes();
  let nextCalled = false;
  verifyCsrfToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, "an anonymous POST must not be blocked by CSRF - the route's checkAuth/checkChairAuth already redirects it");
});

test("verifyCsrfToken: an authenticated POST with a missing/invalid token is rejected with 403", () => {
  const req = fakeReq({ method: "POST", cookies: { access_token: "x" }, session: { csrfSecret: "abc" }, body: {} });
  const res = fakeRes();
  let nextCalled = false;
  verifyCsrfToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("verifyCsrfToken: an authenticated POST with the correct token passes", () => {
  const req = fakeReq({ method: "POST", cookies: { access_token: "x" }, session: { csrfSecret: "abc" }, body: { [CSRF_FIELD_NAME]: "abc" } });
  const res = fakeRes();
  let nextCalled = false;
  verifyCsrfToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("verifyCsrfToken: multipart requests are skipped (checked manually, post-multer, by the route itself)", () => {
  const req = fakeReq({ method: "POST", cookies: { access_token: "x" }, session: { csrfSecret: "abc" }, body: {}, isMultipart: true });
  const res = fakeRes();
  let nextCalled = false;
  verifyCsrfToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("verifyCsrfToken: the explicitly excluded path is never checked", () => {
  assert.ok(CSRF_EXEMPT_PATHS.has("/create-chair-credentials"));
  const req = fakeReq({ method: "POST", path: "/create-chair-credentials", cookies: { access_token: "x" }, session: { csrfSecret: "abc" }, body: {} });
  const res = fakeRes();
  let nextCalled = false;
  verifyCsrfToken(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("csrfRejectUnlessSkipped: redirects with a message when the token is wrong, and doesn't when it's right", () => {
  const badReq = fakeReq({ session: { csrfSecret: "abc" }, body: {} });
  const badRes = fakeRes();
  const blocked = csrfRejectUnlessSkipped(badReq, badRes, "/dashboard");
  assert.equal(blocked, true);
  assert.match(badRes.redirectedTo, /^\/dashboard\?message=/);

  const goodReq = fakeReq({ session: { csrfSecret: "abc" }, body: { [CSRF_FIELD_NAME]: "abc" } });
  const goodRes = fakeRes();
  const notBlocked = csrfRejectUnlessSkipped(goodReq, goodRes, "/dashboard");
  assert.equal(notBlocked, false);
});

// --- Integration test: the real middleware, wired into the real app ------

process.env.JWT_ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_TOKEN_SECRET || "test-access-secret";
process.env.JWT_REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_TOKEN_SECRET || "test-refresh-secret";
process.env.VERCEL = "1"; // skip the Redis connection and app.listen() - no SKIP_AUTOLISTEN, so CSRF stays enforced

const { default: app } = await import("../api/index.js");
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

function extractCookie(res, name) {
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

test("end to end: a real page's rendered form carries a working CSRF token, and logout is rejected without one", async () => {
  // 1. GET a page that renders a POST form (the login page) to get a real
  // session cookie and a real, server-generated token embedded in it.
  const pageRes = await fetch(`${base}/login/user`, { redirect: "manual" });
  const html = await pageRes.text();
  const sessionCookie = extractCookie(pageRes, "connect.sid");
  const tokenMatch = html.match(/name="_csrf" value="([^"]+)"/);

  assert.ok(sessionCookie, "a session cookie must be set on first visit");
  assert.ok(tokenMatch, "at least one rendered POST form must carry the injected CSRF field");
  const token = tokenMatch[1];

  // 2. POST to /logout (a real, simple state-changing route) with a
  // same-session auth cookie present but NO csrf field - must be rejected.
  const noTokenRes = await fetch(`${base}/logout`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: `connect.sid=${sessionCookie}; refresh_token=not-a-real-token`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "",
  });
  assert.equal(noTokenRes.status, 403, "an authenticated-looking POST with no CSRF token must be rejected");

  // 3. Same request, this time with the real token from step 1 - must be
  // let through to the route's own logic (which, with a bogus refresh
  // token, redirects rather than erroring - the point here is that it is
  // no longer blocked by CSRF).
  const withTokenRes = await fetch(`${base}/logout`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: `connect.sid=${sessionCookie}; refresh_token=not-a-real-token`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `${CSRF_FIELD_NAME}=${encodeURIComponent(token)}`,
  });
  assert.notEqual(withTokenRes.status, 403, "the same request with a valid CSRF token must not be blocked");
});
