// Canva Connect API (REST) integration, used to bulk-generate certificates
// via Autofill + Export against a Canva Brand Template.
//
// Canva's REST API has no server-to-server (client_credentials) grant - every
// access token traces back to a real person authorizing the app once via the
// browser (authorization-code + PKCE). After that one-time consent, the
// resulting refresh token lets the server mint new access tokens on its own
// indefinitely (each refresh token is single-use and is rotated on every
// refresh - see getValidAccessToken). That one-time connection is shared by
// the whole app (one row in canva_connection, id=1), set up once by an Admin
// from the Admin page - see /admin/canva/connect and /admin/canva/callback
// in api/index.js.
//
// Docs: https://www.canva.dev/docs/apps/rest-apis/autofill-guide/

import crypto from "crypto";
import pool from "./config/db.js";

const CANVA_API_BASE = "https://api.canva.com/rest/v1";
const CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";

// Least-privilege: only what Autofill + Export actually need. No asset
// scopes - the certificate template has no image placeholders, only text.
export const CANVA_SCOPES = "design:content:read design:content:write design:meta:read brandtemplate:meta:read brandtemplate:content:read";

function basicAuthHeader() {
  const creds = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString("base64");
  return `Basic ${creds}`;
}

// PKCE values for one authorization attempt. code_verifier and state must be
// kept server-side (in the session) between /admin/canva/connect and
// /admin/canva/callback - never sent to or round-tripped through the browser
// as anything but the opaque `state` query parameter.
export function generatePkce() {
  const codeVerifier = crypto.randomBytes(96).toString("base64url"); // 128 chars, the max allowed
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

export function buildAuthorizeUrl({ codeChallenge, state, redirectUri }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.CANVA_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CANVA_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${CANVA_AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch(CANVA_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Canva token request failed (${res.status}): ${data.error || "unknown"} ${data.error_description || ""}`.trim());
  }
  return data;
}

export async function exchangeCodeForTokens(code, codeVerifier, redirectUri) {
  return tokenRequest({ grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri });
}

async function refreshTokens(refreshToken) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function saveConnection({ access_token, refresh_token, expires_in }, connectedBy) {
  const expiresAt = new Date(Date.now() + expires_in * 1000);
  await pool.query(
    `insert into canva_connection (id, access_token, refresh_token, expires_at, connected_by, connected_at)
     values (1, $1, $2, $3, $4, now())
     on conflict (id) do update set
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       connected_by = excluded.connected_by,
       connected_at = now()`,
    [access_token, refresh_token, expiresAt, connectedBy]
  );
}

export async function getConnectionInfo() {
  const r = await pool.query("select connected_by, connected_at from canva_connection where id = 1");
  return r.rows[0] || null;
}

export async function disconnect() {
  await pool.query("delete from canva_connection where id = 1");
}

// Returns a valid access token, transparently refreshing (and persisting the
// rotated refresh token - Canva's are single-use) when the stored one is at
// or near expiry. Throws a clear, user-facing error when nobody has
// connected Canva yet.
export async function getValidAccessToken() {
  const r = await pool.query("select access_token, refresh_token, expires_at from canva_connection where id = 1");
  const row = r.rows[0];
  if (!row) {
    throw new Error("Canva is not connected yet. An Admin needs to connect it from the Admin page before certificates can be generated.");
  }

  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) {
    return row.access_token;
  }

  const refreshed = await refreshTokens(row.refresh_token);
  await pool.query(
    "update canva_connection set access_token = $1, refresh_token = $2, expires_at = $3 where id = 1",
    [refreshed.access_token, refreshed.refresh_token, new Date(Date.now() + refreshed.expires_in * 1000)]
  );
  return refreshed.access_token;
}

async function canvaApiRequest(path, { method = "GET", body } = {}) {
  const token = await getValidAccessToken();
  const res = await fetch(`${CANVA_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Canva API ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// For diagnostics (see GET /admin/canva/dataset) - lists a brand template's
// real placeholder names and types, so the certificate-field mapping in
// api/index.js is set from what the template actually has, not guessed.
// There are several brand templates now (one per submission status/role -
// see CANVA_TEMPLATE_IDS in api/index.js), so this takes the template id
// as a parameter rather than reading a single env var itself.
export async function getBrandTemplateDataset(brandTemplateId) {
  const data = await canvaApiRequest(`/brand-templates/${brandTemplateId}/dataset`);
  return data.dataset;
}

async function pollJob(getFn, { intervalMs = 2000, timeoutMs = 90_000 } = {}) {
  const start = Date.now();
  for (;;) {
    const data = await getFn();
    if (data.job.status === "success") return data.job;
    if (data.job.status === "failed") {
      throw new Error(`Canva job failed: ${data.job.error?.code || "unknown"} - ${data.job.error?.message || ""}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error("Canva job timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Fills the given brand template with the given text fields (dataset key ->
// plain string value; keys not present in the template's own dataset are
// simply ignored by Canva), waits for the autofilled design, exports it as
// a PDF, waits for the export, and returns the (temporary - 24h) download
// URL for the generated PDF's first page. Caller is responsible for
// fetching that URL and storing the bytes somewhere permanent right away.
export async function generateCertificatePdfUrl(brandTemplateId, textFields) {
  const createData = await canvaApiRequest("/autofills", {
    method: "POST",
    body: {
      brand_template_id: brandTemplateId,
      data: Object.fromEntries(Object.entries(textFields).map(([key, value]) => [key, { type: "text", text: String(value) }])),
    },
  });
  const autofillJob = await pollJob(() => canvaApiRequest(`/autofills/${createData.job.id}`));
  const designId = autofillJob.result.design.id;

  const exportCreateData = await canvaApiRequest("/exports", {
    method: "POST",
    body: { design_id: designId, format: { type: "pdf" } },
  });
  const exportJob = await pollJob(() => canvaApiRequest(`/exports/${exportCreateData.job.id}`));

  return exportJob.urls[0];
}
