// drillbit.js
//
// Client for Drillbit's AI/plagiarism checking API
// (https://apidocs.drillbitglobal.com/classroom-management.html#auth),
// used to run every first-time full paper submission (POST /submit in
// api/index.js - not revised papers, not camera-ready papers) through
// plagiarism and AI-content analysis, surfaced to the chair on the desk
// review page.
//
// Entirely optional: every function here is a no-op (or, for the
// chair-facing report route, returns a clear "not configured" error)
// when DRILLBIT_EMAIL/DRILLBIT_PASSWORD aren't set - exactly like this
// app already treats Redis or Canva as optional until configured. No
// submission route depends on Drillbit succeeding.
//
// There's no background worker/cron in this app, so rather than add one,
// "pending" submissions are checked lazily: refreshPendingReports() is
// called whenever the chair loads the desk review page, checking Drillbit
// for a result for each submission still "pending" and updating the DB
// in place. Drillbit's own docs say analysis typically takes 10-15
// minutes, so a chair who reopens the page a few minutes later sees
// updated results without any separate polling process.
import dotenv from "dotenv";

dotenv.config();

const DRILLBIT_BASE_URL = "https://s1.drillbitplagiarismcheck.com";

export function isDrillbitConfigured() {
  return Boolean(process.env.DRILLBIT_EMAIL && process.env.DRILLBIT_PASSWORD);
}

let cachedToken = null;
let cachedTokenAt = 0;
// Drillbit's docs don't state an exact token lifetime ("tokens expire and
// must be refreshed") - this is a defensive refresh window, not a
// documented value. A 401 from any call also forces an immediate
// re-authentication regardless of this window (see drillbitFetch).
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function authenticate() {
  const res = await fetch(`${DRILLBIT_BASE_URL}/authentication/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.DRILLBIT_EMAIL, password: process.env.DRILLBIT_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Drillbit authentication failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  if (!data?.token) throw new Error("Drillbit authentication response had no token");
  return data.token;
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return cachedToken;
  cachedToken = await authenticate();
  cachedTokenAt = Date.now();
  return cachedToken;
}

// Wraps a Drillbit API call, retrying once with a freshly re-authenticated
// token if the first attempt comes back 401.
async function drillbitFetch(path, options = {}) {
  const token = await getToken();
  let res = await fetch(`${DRILLBIT_BASE_URL}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    const freshToken = await getToken(true);
    res = await fetch(`${DRILLBIT_BASE_URL}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${freshToken}` },
    });
  }
  return res;
}

let cachedFolderId = null;

// Drillbit requires uploading into a folder - this app only ever needs
// one, shared by every conference, cached in-memory and persisted to
// drillbit_connection so it survives a restart.
async function ensureFolder(pool) {
  if (cachedFolderId) return cachedFolderId;

  const existing = await pool.query("select folder_id from drillbit_connection where id = 1");
  if (existing.rows[0]?.folder_id) {
    cachedFolderId = existing.rows[0].folder_id;
    return cachedFolderId;
  }

  const res = await drillbitFetch("/extreme/folder", { method: "POST" });
  if (!res.ok) throw new Error(`Drillbit folder creation failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json();
  const href = data?._links?.self?.href;
  const folderId = href ? String(href).split("/").filter(Boolean).pop() : null;
  if (!folderId) throw new Error("Could not determine Drillbit folder id from its response");

  await pool.query(
    `insert into drillbit_connection (id, folder_id) values (1, $1)
     on conflict (id) do update set folder_id = excluded.folder_id`,
    [folderId]
  );
  cachedFolderId = folderId;
  return folderId;
}

function normalizeDKey(value) {
  return value && value !== "NA" ? String(value) : null;
}

// Uploads a just-submitted paper for analysis. Fire-and-forget from the
// caller's point of view (api/index.js never awaits this on the critical
// path of the author's own request) - every failure is caught and
// recorded on the row itself (status 'failed', error_message) rather than
// thrown, so it can never break the submission flow that triggered it.
export async function submitSubmissionForAnalysis(pool, { submissionId, fileBuffer, fileName, authorName, title }) {
  if (!isDrillbitConfigured()) return;

  try {
    const folderId = await ensureFolder(pool);

    const form = new FormData();
    form.append("file", new Blob([fileBuffer]), fileName || "paper.pdf");
    form.append("authorName", authorName || "Unknown");
    form.append("title", title || "Untitled");
    form.append("documentType", "Article");
    form.append("plagiarismCheck", "YES");
    form.append("grammarCheck", "NO");
    form.append("language", "English");

    const res = await drillbitFetch(`/files/myFolder/${folderId}/singleFile`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Drillbit upload failed: ${res.status} ${await res.text().catch(() => "")}`);
    }

    const data = await res.json();
    const submissionInfo = data?.submissions;
    if (!submissionInfo?.paper_id) {
      throw new Error("Drillbit upload response had no paper_id");
    }

    await pool.query(
      `insert into drillbit_reports (submission_id, folder_id, paper_id, d_key, status, error_message)
       values ($1, $2, $3, $4, 'pending', null)
       on conflict (submission_id) do update set
         folder_id = excluded.folder_id,
         paper_id = excluded.paper_id,
         d_key = excluded.d_key,
         status = 'pending',
         error_message = null`,
      [submissionId, folderId, String(submissionInfo.paper_id), normalizeDKey(submissionInfo.d_key)]
    );
  } catch (err) {
    console.error(`Drillbit submission failed for submission ${submissionId}:`, err);
    await pool
      .query(
        `insert into drillbit_reports (submission_id, status, error_message)
         values ($1, 'failed', $2)
         on conflict (submission_id) do update set status = 'failed', error_message = excluded.error_message`,
        [submissionId, String(err?.message || err)]
      )
      .catch((dbErr) => console.error(`Could not record Drillbit failure for submission ${submissionId}:`, dbErr));
  }
}

// Checks Drillbit for a result on every submission still "pending" among
// the given ids, updating the row in place as soon as a numeric percent
// comes back. Never throws - a Drillbit outage just means the submissions
// stay "pending" until the next time this is called (e.g. the chair's
// next page load).
export async function refreshPendingReports(pool, submissionIds) {
  if (!isDrillbitConfigured() || !submissionIds || submissionIds.length === 0) return;

  const pendingResult = await pool.query(
    "select submission_id, folder_id, paper_id, d_key from drillbit_reports where submission_id = ANY($1) and status = 'pending'",
    [submissionIds]
  );

  for (const row of pendingResult.rows) {
    if (!row.folder_id || !row.paper_id) continue;
    try {
      const res = await drillbitFetch(`/pro/folder/${row.folder_id}/submission/${row.paper_id}`);
      if (!res.ok) continue;
      const data = await res.json();

      const percent = Number(data?.percent);
      if (!Number.isFinite(percent)) continue; // still "--" / still processing

      const aiValue = Number(data?.ai);

      await pool.query(
        `update drillbit_reports
         set status = 'completed', plagiarism_percent = $1, ai_percent = $2, d_key = $3, checked_at = now()
         where submission_id = $4`,
        [percent, Number.isFinite(aiValue) ? aiValue : null, normalizeDKey(data?.d_key) || row.d_key, row.submission_id]
      );
    } catch (err) {
      console.error(`Drillbit result check failed for submission ${row.submission_id}:`, err);
    }
  }
}

// Streams one of Drillbit's PDF reports. Throws on failure - the caller
// (the chair-facing report route) is expected to catch it and redirect
// with a message, same as every other route in this app that proxies an
// external download.
export async function fetchDrillbitReport(paperId, dKey, type) {
  const path =
    type === "ai"
      ? `/analysis-gateway/api/ai/download2/${paperId}/${dKey}`
      : `/analysis-gateway/api/download2/${paperId}/${dKey}`;
  const res = await drillbitFetch(path);
  if (!res.ok) {
    throw new Error(`Drillbit report download failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res;
}
