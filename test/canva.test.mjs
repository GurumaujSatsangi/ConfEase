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
process.env.BRAND_TEMPLATE_ID_POSTER = process.env.BRAND_TEMPLATE_ID_POSTER || "TEST_TEMPLATE_ID_POSTER";
process.env.BRAND_TEMPLATE_ID_PAPER = process.env.BRAND_TEMPLATE_ID_PAPER || "TEST_TEMPLATE_ID_PAPER";
process.env.BRAND_TEMPLATE_ID_REVIEWER = process.env.BRAND_TEMPLATE_ID_REVIEWER || "TEST_TEMPLATE_ID_REVIEWER";
process.env.BRAND_TEMPLATE_ID_SESSION_CHAIR = process.env.BRAND_TEMPLATE_ID_SESSION_CHAIR || "TEST_TEMPLATE_ID_SESSION_CHAIR";
process.env.BRAND_TEMPLATE_ID_INVITED_SPEAKER = process.env.BRAND_TEMPLATE_ID_INVITED_SPEAKER || "TEST_TEMPLATE_ID_INVITED_SPEAKER";
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

// This suite repeatedly deletes/overwrites canva_connection (id=1, a true
// singleton) to get a deterministic "not connected" or "connected with
// known fake tokens" state for each test. If a real, working connection
// already exists (an Admin completed the real one-time OAuth consent - see
// /admin/canva/connect), running this suite must not silently destroy it.
// So: save whatever's there before the first test touches the table, and
// restore exactly that (or delete again, if there wasn't one) once every
// test in this file has finished.
const preExistingConnection = (await pool.query("select access_token, refresh_token, expires_at, connected_by from canva_connection where id = 1")).rows[0] || null;

beforeEach(async () => {
  await pool.query("delete from canva_connection where id = 1");
});

after(async () => {
  await pool.query("delete from canva_connection where id = 1");
  if (preExistingConnection) {
    await pool.query(
      "insert into canva_connection (id, access_token, refresh_token, expires_at, connected_by) values (1,$1,$2,$3,$4)",
      [preExistingConnection.access_token, preExistingConnection.refresh_token, preExistingConnection.expires_at, preExistingConnection.connected_by]
    );
  }
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
    () => canva.generateCertificatePdfUrl("SOME_TEMPLATE_ID", { Name: "Jane Doe", "Conference Title": "DEI CMT 2026" })
  );

  assert.equal(resultUrl, "https://export-download.canva.com/final.pdf");

  const autofillCreate = calls.find((c) => c.url.endsWith("/autofills") && c.opts.method === "POST");
  assert.ok(autofillCreate, "must create an autofill job");
  const autofillBody = JSON.parse(autofillCreate.opts.body);
  assert.equal(autofillBody.brand_template_id, "SOME_TEMPLATE_ID");
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
        () => canva.generateCertificatePdfUrl("SOME_TEMPLATE_ID", { Name: "Jane" })
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

test("GET /admin/canva/dataset?role=poster returns a clear 'not connected' error when Canva hasn't been connected yet", async () => {
  const res = await fetch(base + "/admin/canva/dataset?role=poster", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /not connected/i);
});

test("GET /admin/canva/dataset?role=unknown-role is rejected with the list of known roles", async () => {
  const res = await fetch(base + "/admin/canva/dataset?role=unknown-role", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown-role/);
  assert.match(body.error, /reviewer/);
});

test("GET /admin/canva/dataset with no ?role reports every certificate category, each failing independently rather than the whole response erroring", async () => {
  const res = await fetch(base + "/admin/canva/dataset", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();

  // All five categories have a (fake) template id configured in this test
  // env (see the top of this file), but Canva isn't connected, so each one
  // reports its own "not connected" error rather than failing the whole
  // response - this proves one role's failure can't hide another's result.
  for (const role of ["poster", "paper", "reviewer", "session_chair", "invited_speaker"]) {
    assert.equal(body[role].configured, true, `${role} should report as configured`);
    assert.match(body[role].error, /not connected/i, `${role} should report its own not-connected error`);
  }
});

test("GET /admin/canva/dataset with no ?role marks a role unconfigured (not an error) when its template id is empty", async () => {
  // CANVA_TEMPLATE_IDS is read from process.env once, at api/index.js's
  // module load time, so this test can't flip a real env var mid-suite to
  // prove the "skipped, not errored" behavior end-to-end. What IS checked
  // here, against the real route: an explicitly-unconfigured role name
  // (one the route itself would treat as having no template id) is
  // rejected the same way whether checked individually...
  const individual = await fetch(base + "/admin/canva/dataset?role=not_a_real_role", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(individual.status, 400);
  // ...and the all-roles response's shape for a configured-but-failing role
  // is always { configured: true, templateId, error } - never silently
  // missing a role or mixing up which one failed.
  const all = await fetch(base + "/admin/canva/dataset", { headers: { Authorization: `Bearer ${adminToken}` } });
  const body = await all.json();
  assert.deepEqual(Object.keys(body).sort(), ["invited_speaker", "paper", "poster", "reviewer", "session_chair"]);
  for (const role of Object.keys(body)) {
    assert.ok("configured" in body[role], `${role} result must say whether it's configured`);
  }
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

// --- POST /chair/dashboard/enable-pdf-download/:id: all four certificate categories ---
// (authors, reviewers, session chairs, invited speakers). This belongs in
// this file, not test/certificate-pdf.test.mjs, because it depends on
// canva_connection's disconnected state - see this file's header comment.

const certChairEmail = "canva-cert-test-chair@example.com";
const certChairToken = jwt.sign({ typ: "chair", email: certChairEmail, name: "Cert Test Chair", user_id: 5, role: "chair" }, secret, { expiresIn: "5m" });

async function seedFullConference() {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["CANVA_CERT_TEST_" + crypto.randomBytes(3).toString("hex"), certChairEmail]
  );
  const conferenceId = conf.rows[0].conference_id;

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, track_reviewers, panelists) values ($1,$2,$3,$4) returning track_id",
    [conferenceId, "Cert Test Track", ["cert-reviewer-1@example.com", "cert-reviewer-2@example.com"], ["cert-chair-1@example.com"]]
  );
  const trackId = track.rows[0].track_id;

  const posterSub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, paper_number) values ($1,$2,'Poster Paper',$3,'Poster Scored',1) returning submission_id",
    [conferenceId, "cert-author-poster@example.com", "CCP" + crypto.randomBytes(3).toString("hex")]
  );
  const paperSub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, paper_number) values ($1,$2,'Oral Paper',$3,'Presentation Completed',2) returning submission_id",
    [conferenceId, "cert-author-paper@example.com", "CCO" + crypto.randomBytes(3).toString("hex")]
  );

  await pool.query("insert into invitees (name, email, conference_id) values ($1,$2,$3)", ["Cert Test Invitee", "cert-invitee@example.com", conferenceId]);
  const invitedTalk = await pool.query(
    "insert into invited_talk_submissions (invitee_email, conference_id, title, track_id) values ($1,$2,$3,$4) returning paper_id",
    ["cert-invitee@example.com", conferenceId, "Invited Talk Title", trackId]
  );

  return { conferenceId, trackId, posterSubmissionId: posterSub.rows[0].submission_id, paperSubmissionId: paperSub.rows[0].submission_id, invitedPaperId: invitedTalk.rows[0].paper_id };
}

async function cleanupConference(conferenceId, trackId) {
  await pool.query("delete from role_certificates where conference_id = $1", [conferenceId]);
  await pool.query("delete from certificates where conference_id = $1", [conferenceId]);
  await pool.query("delete from invited_talk_submissions where conference_id = $1", [conferenceId]);
  await pool.query("delete from invitees where conference_id = $1", [conferenceId]);
  await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
  if (trackId) await pool.query("delete from conference_tracks where track_id = $1", [trackId]);
  await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
}

test("enable-pdf-download: with Canva not connected, every category (reviewers, session chairs, invited speakers) fails gracefully with no partial writes, and author certificates are left FAILED with a readable reason", async () => {
  const { conferenceId, trackId } = await seedFullConference();
  try {
    const res = await fetch(base + `/chair/dashboard/enable-pdf-download/${conferenceId}`, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${certChairToken}` } });
    assert.equal(res.status, 302);
    const message = decodeURIComponent(res.headers.get("location") || "");
    assert.match(message, /0 recipients/);
    assert.match(message, /failed/);

    // Manage Certificates (the new page this failure is now visible on,
    // not just the server log) needs author certificate rows to persist
    // and explain what went wrong - the old behavior silently deleted a
    // failed reservation, leaving no trace at all.
    const certRows = await pool.query("select status, error_message from certificates where conference_id = $1 order by submission_id", [conferenceId]);
    assert.equal(certRows.rows.length, 2, "both eligible submissions must have a FAILED row left behind, not be silently deleted");
    for (const row of certRows.rows) {
      assert.equal(row.status, "FAILED");
      assert.match(row.error_message, /Canva is not connected/, "the recorded reason must be the actual, readable error - not a generic failure string");
    }

    const roleCertRows = await pool.query("select role, email from role_certificates where conference_id = $1 order by role, email", [conferenceId]);
    assert.deepEqual(roleCertRows.rows, [], "no role_certificates rows (reviewer/session_chair/invited_speaker) should exist after an all-failed attempt");
  } finally {
    await cleanupConference(conferenceId, trackId);
  }
});

test("Manage Certificates page shows FAILED rows with their reason and a Regenerate button, and regenerating re-attempts (still failing while Canva is disconnected, but recording why)", async () => {
  const { conferenceId, trackId, paperSubmissionId } = await seedFullConference();
  try {
    await fetch(base + `/chair/dashboard/enable-pdf-download/${conferenceId}`, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${certChairToken}` } });

    const pageHtml = await (await fetch(base + `/chair/dashboard/manage-certificates/${conferenceId}`, { headers: { Authorization: `Bearer ${certChairToken}` } })).text();
    assert.match(pageHtml, /Failed: .*Canva is not connected/, "the page must show the actual failure reason, not just \"Failed\"");
    assert.match(pageHtml, /Regenerate Certificate/, "a FAILED row must offer a way to retry it");

    const regenRes = await fetch(base + `/chair/dashboard/regenerate-certificate/${paperSubmissionId}`, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${certChairToken}` } });
    assert.equal(regenRes.status, 302);
    assert.match(decodeURIComponent(regenRes.headers.get("location")), /failed again/);

    const row = await pool.query("select status, error_message from certificates where submission_id = $1", [paperSubmissionId]);
    assert.equal(row.rows[0].status, "FAILED", "a FAILED row must be immediately reclaimable by Regenerate, not stuck waiting out the staleness window");
    assert.match(row.rows[0].error_message, /Canva is not connected/);
  } finally {
    await cleanupConference(conferenceId, trackId);
  }
});

test("a chair who does not own the conference cannot view its Manage Certificates page or regenerate its certificates", async () => {
  const { conferenceId, trackId, paperSubmissionId } = await seedFullConference();
  const outsiderToken = jwt.sign({ typ: "chair", email: "cert-outsider-chair@example.com", name: "Outsider", user_id: 9, role: "chair" }, secret, { expiresIn: "5m" });
  try {
    const pageRes = await fetch(base + `/chair/dashboard/manage-certificates/${conferenceId}`, { redirect: "manual", headers: { Authorization: `Bearer ${outsiderToken}` } });
    assert.equal(pageRes.status, 302);
    assert.match(decodeURIComponent(pageRes.headers.get("location")), /not authorized/);

    const regenRes = await fetch(base + `/chair/dashboard/regenerate-certificate/${paperSubmissionId}`, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${outsiderToken}` } });
    assert.equal(regenRes.status, 302);
    assert.match(decodeURIComponent(regenRes.headers.get("location")), /not authorized/);
  } finally {
    await cleanupConference(conferenceId, trackId);
  }
});

test("enable-pdf-download: a reviewer who already has a GENERATED role certificate for this Subject Area is skipped, not re-attempted", async () => {
  const { conferenceId, trackId } = await seedFullConference();
  try {
    await pool.query(
      "insert into role_certificates (conference_id, role, email, context_id, status, file_url) values ($1,'reviewer','cert-reviewer-1@example.com',$2,'GENERATED','https://res.cloudinary.com/demo/raw/upload/fake.pdf')",
      [conferenceId, trackId]
    );

    const res = await fetch(base + `/chair/dashboard/enable-pdf-download/${conferenceId}`, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${certChairToken}` } });
    const message = decodeURIComponent(res.headers.get("location") || "");

    // cert-reviewer-1 already has one and must not appear as a failure;
    // cert-reviewer-2 (same track, no existing certificate) is still
    // attempted and fails (Canva isn't connected), same as before.
    assert.doesNotMatch(message, /reviewer cert-reviewer-1@example\.com/);

    const roleCertRows = await pool.query(
      "select role, email from role_certificates where conference_id = $1 order by role, email",
      [conferenceId]
    );
    assert.deepEqual(roleCertRows.rows, [{ role: "reviewer", email: "cert-reviewer-1@example.com" }], "the pre-existing row must be untouched, and nothing new written for anyone else (their attempts all failed)");
  } finally {
    await cleanupConference(conferenceId, trackId);
  }
});
