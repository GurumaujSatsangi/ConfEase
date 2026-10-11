// Tests for the whole Canva integration: canva.js's own logic (PKCE, token
// exchange/refresh, the autofill -> export pipeline) against a stubbed
// global fetch, AND the /admin/canva/* routes against the real running app
// and real local Postgres database.
//
// These live in one file, deliberately: canva_connection is a true
// singleton (id always 1, one shared connection for the whole app - Canva
// has no per-user server-to-server login), so any two tests that touch it
// concurrently will race. node --test runs separate test FILES in
// parallel by default, but tests WITHIN one file run sequentially - so
// every test that reads or writes canva_connection lives in this single
// file to avoid that race, rather than being split across files.
//
// There is no live Canva connection in this environment (that requires a
// real person completing a one-time browser OAuth consent - see
// /admin/canva/connect), so Canva's real API is never contacted here.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

process.env.SKIP_AUTOLISTEN = "1";
process.env.CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID || "test-client-id";
process.env.CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || "test-client-secret";
process.env.BRAND_TEMPLATE_ID = process.env.BRAND_TEMPLATE_ID || "TEST_TEMPLATE_ID";
process.env.ADMIN_EMAILS = "canva-admin-test@example.com";

const canva = await import("../canva.js");
const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const adminEmail = "canva-admin-test@example.com";
const nonAdminEmail = "canva-nonadmin-test@example.com";
const adminToken = jwt.sign({ typ: "access", email: adminEmail, name: "Canva Admin Test", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const nonAdminToken = jwt.sign({ typ: "access", email: nonAdminEmail, name: "Canva Non Admin", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });

beforeEach(async () => {
  await pool.query("delete from canva_connection where id = 1");
});

after(async () => {
  await pool.query("delete from canva_connection where id = 1");
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

// Stubs global fetch for the duration of `fn`, feeding it `responses` in
// order (one per call), and returns the list of calls made so the caller
// can assert on request shape. Scoped manually per test (not a shared
// beforeEach/afterEach) so it never interferes with the real-HTTP tests
// below that hit this file's own local test server.
async function withStubbedFetch(responses, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const next = queue.shift();
    if (!next) throw new Error("No stubbed response queued for call to " + url);
    return { ok: next.ok !== false, status: next.status || (next.ok === false ? 400 : 200), json: async () => next.body };
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- canva.js logic (stubbed network) ---------------------------------

test("generatePkce: code_verifier is 43-128 chars, code_challenge is its base64url(SHA-256), state is present", () => {
  const { codeVerifier, codeChallenge, state } = canva.generatePkce();
  assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128);
  assert.ok(/^[A-Za-z0-9\-_]+$/.test(codeVerifier), "must use only PKCE-allowed characters (base64url alphabet)");
  assert.equal(codeChallenge, crypto.createHash("sha256").update(codeVerifier).digest("base64url"));
  assert.ok(state.length > 0);
});

test("buildAuthorizeUrl: includes every required OAuth/PKCE query parameter", () => {
  const url = new URL(canva.buildAuthorizeUrl({ codeChallenge: "chal123", state: "state456", redirectUri: "https://example.com/admin/canva/callback" }));
  assert.equal(url.origin + url.pathname, "https://www.canva.com/api/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/admin/canva/callback");
  assert.equal(url.searchParams.get("code_challenge"), "chal123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state456");
  assert.ok(url.searchParams.get("scope").includes("brandtemplate:content:read"));
});

test("exchangeCodeForTokens: POSTs to the token endpoint with Basic auth and the authorization_code grant body", async () => {
  const { result: tokens, calls } = await withStubbedFetch(
    [{ body: { access_token: "AT1", refresh_token: "RT1", token_type: "Bearer", expires_in: 14400 } }],
    () => canva.exchangeCodeForTokens("auth-code-1", "verifier-1", "https://example.com/cb")
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.canva.com/rest/v1/oauth/token");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers.Authorization, "Basic " + Buffer.from("test-client-id:test-client-secret").toString("base64"));
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "auth-code-1");
  assert.equal(body.get("code_verifier"), "verifier-1");
  assert.equal(body.get("redirect_uri"), "https://example.com/cb");
  assert.equal(tokens.access_token, "AT1");
});

test("exchangeCodeForTokens: a non-ok response throws with Canva's error details", async () => {
  await assert.rejects(
    () => withStubbedFetch([{ ok: false, status: 400, body: { error: "invalid_grant", error_description: "code expired" } }], () => canva.exchangeCodeForTokens("bad-code", "v", "https://example.com/cb")).then((r) => r.result),
    /invalid_grant/
  );
});

test("getValidAccessToken: throws a clear error when Canva has never been connected", async () => {
  const { calls } = await withStubbedFetch([], async () => {
    await assert.rejects(() => canva.getValidAccessToken(), /not connected/);
  });
  assert.equal(calls.length, 0, "must not make any network call when there's nothing to refresh");
});

test("getValidAccessToken: returns the stored token without a network call when it's not near expiry", async () => {
  await canva.saveConnection({ access_token: "AT-valid", refresh_token: "RT-valid", expires_in: 14400 }, adminEmail);

  const { result: token, calls } = await withStubbedFetch([], () => canva.getValidAccessToken());

  assert.equal(token, "AT-valid");
  assert.equal(calls.length, 0, "a token with plenty of time left must not trigger a refresh call");
});

test("getValidAccessToken: refreshes and persists the rotated (single-use) refresh token when the stored one is expired", async () => {
  await pool.query(
    "insert into canva_connection (id, access_token, refresh_token, expires_at, connected_by) values (1,$1,$2,$3,$4)",
    ["AT-old", "RT-old", new Date(Date.now() - 1000), adminEmail]
  );

  const { result: token, calls } = await withStubbedFetch(
    [{ body: { access_token: "AT-new", refresh_token: "RT-new", token_type: "Bearer", expires_in: 14400 } }],
    () => canva.getValidAccessToken()
  );

  assert.equal(token, "AT-new");
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "RT-old");

  const row = await pool.query("select access_token, refresh_token from canva_connection where id = 1");
  assert.equal(row.rows[0].access_token, "AT-new");
  assert.equal(row.rows[0].refresh_token, "RT-new", "the OLD refresh token must be replaced, since Canva refresh tokens are single-use");
});

test("generateCertificatePdfUrl: drives autofill -> poll -> export -> poll and returns the final PDF URL", async () => {
  await canva.saveConnection({ access_token: "AT1", refresh_token: "RT1", expires_in: 14400 }, adminEmail);

  const { result: resultUrl, calls } = await withStubbedFetch(
    [
      { body: { job: { id: "autofill-job-1", status: "in_progress" } } }, // POST /autofills
      { body: { job: { id: "autofill-job-1", status: "in_progress" } } }, // GET poll #1
      { body: { job: { id: "autofill-job-1", status: "success", result: { type: "create_design", design: { id: "DESIGN123" } } } } }, // GET poll #2
      { body: { job: { id: "export-job-1", status: "in_progress" } } }, // POST /exports
      { body: { job: { id: "export-job-1", status: "success", urls: ["https://export-download.canva.com/final.pdf"] } } }, // GET poll
    ],
    () => canva.generateCertificatePdfUrl({ Name: "Jane Doe", "Conference Title": "DEI CMT 2026" })
  );

  assert.equal(resultUrl, "https://export-download.canva.com/final.pdf");

  const autofillCreate = calls.find((c) => c.url.endsWith("/autofills") && c.opts.method === "POST");
  assert.ok(autofillCreate, "must create an autofill job");
  const autofillBody = JSON.parse(autofillCreate.opts.body);
  assert.equal(autofillBody.brand_template_id, "TEST_TEMPLATE_ID");
  assert.deepEqual(autofillBody.data, {
    Name: { type: "text", text: "Jane Doe" },
    "Conference Title": { type: "text", text: "DEI CMT 2026" },
  });

  const exportCreate = calls.find((c) => c.url.endsWith("/exports") && c.opts.method === "POST");
  assert.ok(exportCreate, "must create an export job once the design exists");
  const exportBody = JSON.parse(exportCreate.opts.body);
  assert.equal(exportBody.design_id, "DESIGN123");
  assert.equal(exportBody.format.type, "pdf");
});

test("generateCertificatePdfUrl: a failed autofill job throws with Canva's error code/message", async () => {
  await canva.saveConnection({ access_token: "AT1", refresh_token: "RT1", expires_in: 14400 }, adminEmail);

  await assert.rejects(
    () =>
      withStubbedFetch(
        [
          { body: { job: { id: "autofill-job-2", status: "in_progress" } } },
          { body: { job: { id: "autofill-job-2", status: "failed", error: { code: "autofill_error", message: "field mismatch" } } } },
        ],
        () => canva.generateCertificatePdfUrl({ Name: "Jane" })
      ).then((r) => r.result),
    /autofill_error/
  );
});

// --- /admin/canva/* routes (real app, real DB, real session, no Canva network) ---

// /admin/canva/callback is deliberately NOT in this list: Canva's redirect
// back to it is a cross-site navigation, so the browser does not send the
// SameSite=strict login cookie on it - checkAuth would reject a legitimate
// callback, which is exactly the bug this was built to avoid (see the test
// further below). Its own security gate is the session-stashed `state`
// match instead, covered separately.
const ADMIN_GATED_CANVA_ROUTES = [
  ["GET", "/admin/canva/connect"],
  ["GET", "/admin/canva/dataset"],
  ["POST", "/admin/canva/disconnect"],
];

test("every admin-gated /admin/canva/* route is blocked for a non-admin", async () => {
  for (const [method, path] of ADMIN_GATED_CANVA_ROUTES) {
    const res = await fetch(base + path, { method, redirect: "manual", headers: { Authorization: `Bearer ${nonAdminToken}` } });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test("GET /admin/canva/connect redirects an Admin to Canva's real authorize URL with a fresh PKCE/state pair", async () => {
  const res = await fetch(base + "/admin/canva/connect", { redirect: "manual", headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.origin + location.pathname, "https://www.canva.com/api/oauth/authorize");
  assert.ok(location.searchParams.get("state"), "must include a state value");
  assert.ok(location.searchParams.get("code_challenge"), "must include a PKCE code_challenge");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(res.headers.get("set-cookie"), "must start a session to stash the PKCE verifier/state for the callback");
});

test("GET /admin/canva/callback rejects a state that doesn't match what /connect stashed, and never creates a connection row", async () => {
  const connectRes = await fetch(base + "/admin/canva/connect", { redirect: "manual", headers: { Authorization: `Bearer ${adminToken}` } });
  const sessionCookie = (connectRes.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(sessionCookie, "sanity: /connect must have started a session");

  const callbackRes = await fetch(base + "/admin/canva/callback?code=some-code&state=this-does-not-match", {
    redirect: "manual",
    headers: { Authorization: `Bearer ${adminToken}`, Cookie: sessionCookie },
  });

  assert.equal(callbackRes.status, 302);
  assert.match(decodeURIComponent(callbackRes.headers.get("location") || ""), /could not be verified/i);

  const row = await pool.query("select 1 from canva_connection where id = 1");
  assert.equal(row.rows.length, 0, "a state mismatch must not result in a stored connection");
});

test("GET /admin/canva/callback succeeds with ONLY the session cookie, no login cookie at all (the real cross-site-redirect scenario)", async () => {
  // This reproduces a real bug: the login cookie is SameSite=strict, so the
  // browser does NOT send it on Canva's cross-site redirect back to this
  // route. Earlier, this route required checkAuth and so always bounced a
  // real user to /login/user right after they clicked "Allow" on Canva's
  // own consent screen - this test sends no Authorization header and no
  // access_token cookie at all, only the session cookie /connect started,
  // exactly like the real browser request.
  const connectRes = await fetch(base + "/admin/canva/connect", { redirect: "manual", headers: { Authorization: `Bearer ${adminToken}` } });
  const sessionCookie = (connectRes.headers.get("set-cookie") || "").split(";")[0];
  const state = new URL(connectRes.headers.get("location")).searchParams.get("state");

  // Stubbing global fetch would also intercept the request this test makes
  // to its OWN local server below (both go through the same global
  // fetch) - not just canva.js's internal call to Canva's token endpoint.
  // So the stub here passes through anything that isn't the Canva token
  // endpoint to the real fetch, instead of queuing a response for it.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url) === "https://api.canva.com/rest/v1/oauth/token") {
      return { ok: true, status: 200, json: async () => ({ access_token: "AT-real", refresh_token: "RT-real", token_type: "Bearer", expires_in: 14400 }) };
    }
    return originalFetch(url, opts);
  };

  let callbackRes;
  try {
    callbackRes = await fetch(base + `/admin/canva/callback?code=real-code&state=${state}`, {
      redirect: "manual",
      headers: { Cookie: sessionCookie }, // no Authorization header, no access_token cookie
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(callbackRes.status, 302);
  assert.match(decodeURIComponent(callbackRes.headers.get("location") || ""), /connected successfully/i);

  const row = await pool.query("select connected_by from canva_connection where id = 1");
  assert.equal(row.rows[0].connected_by, adminEmail, "connected_by must come from the session-stashed admin, not req.user (unavailable on this route)");
});

test("GET /admin/canva/callback with no prior session (no pending PKCE/state) also rejects cleanly", async () => {
  const res = await fetch(base + "/admin/canva/callback?code=some-code&state=anything", {
    redirect: "manual",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /could not be verified/i);
});

test("GET /admin/canva/dataset returns a clear 'not connected' error when Canva hasn't been connected yet", async () => {
  const res = await fetch(base + "/admin/canva/dataset", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /not connected/i);
});

test("the Admin page reflects Canva's connection state, and POST disconnect clears it", async () => {
  const beforeHtml = await (await fetch(base + "/admin", { headers: { Authorization: `Bearer ${adminToken}` } })).text();
  assert.match(beforeHtml, /Not connected/);

  await pool.query(
    "insert into canva_connection (id, access_token, refresh_token, expires_at, connected_by) values (1,'at','rt',now() + interval '1 day',$1)",
    [adminEmail]
  );

  const afterHtml = await (await fetch(base + "/admin", { headers: { Authorization: `Bearer ${adminToken}` } })).text();
  assert.match(afterHtml, /Connected by/);
  assert.ok(afterHtml.includes(adminEmail));

  const disconnectRes = await fetch(base + "/admin/canva/disconnect", { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(disconnectRes.status, 302);

  const row = await pool.query("select 1 from canva_connection where id = 1");
  assert.equal(row.rows.length, 0);
});
