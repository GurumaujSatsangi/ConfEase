// Regression tests for the Drillbit AI/plagiarism integration
// (drillbit.js, GET /chair/dashboard/desk/:id, GET
// /chair/dashboard/desk/drillbit-report/:submissionId/:type): every
// first-time full paper submission (POST /submit) is sent to Drillbit in
// the background, and the chair sees plagiarism %, AI %, and report links
// on the desk review page once Drillbit finishes.
//
// No real Drillbit credentials exist yet (the account owner said they'll
// add them later), so this suite covers what's verifiable without one:
// the feature is a no-op end to end when unconfigured, the desk review
// page renders every drillbit_reports status correctly once rows exist,
// and the report-proxy route's authorization/not-ready handling - all
// without drillbit.js ever making a real network call (a 'pending' row
// is seeded with no folder_id/paper_id, which refreshPendingReports
// already skips rather than looking up).
//
// DRILLBIT_EMAIL/DRILLBIT_PASSWORD are set to fake values *before*
// api/index.js (and therefore drillbit.js) is imported, purely to flip
// isDrillbitConfigured() to true so the desk review page's Drillbit
// column renders - dotenv.config() never overwrites an already-set
// process.env key, so this is safe regardless of what's in .env.
process.env.DRILLBIT_EMAIL = "drillbit-test@example.com";
process.env.DRILLBIT_PASSWORD = "drillbit-test-password";
process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");
const { isDrillbitConfigured } = await import("../drillbit.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "drillbit-test-chair@example.com";
const otherChairEmail = "drillbit-test-other@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Drillbit Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const otherChairToken = jwt.sign({ typ: "chair", email: otherChairEmail, name: "Other Chair", user_id: 2, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

let conferenceId;
let pendingSubmissionId;
let completedSubmissionId;
let failedSubmissionId;
let noRowSubmissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["DRILLBIT_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const makeSubmission = async (paperNumber) => {
    const sub = await pool.query(
      "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Drillbit Test Paper','DB" + paperNumber + "',$3,'Submitted for Review') returning submission_id",
      [conferenceId, "drillbit-author@example.com", paperNumber]
    );
    return sub.rows[0].submission_id;
  };

  pendingSubmissionId = await makeSubmission(201);
  completedSubmissionId = await makeSubmission(202);
  failedSubmissionId = await makeSubmission(203);
  noRowSubmissionId = await makeSubmission(204);

  // Deliberately no folder_id/paper_id - refreshPendingReports must skip
  // this rather than attempt a real Drillbit call with fake credentials.
  await pool.query(
    "insert into drillbit_reports (submission_id, status) values ($1, 'pending')",
    [pendingSubmissionId]
  );
  await pool.query(
    "insert into drillbit_reports (submission_id, status, plagiarism_percent, ai_percent, paper_id, d_key) values ($1, 'completed', 12.5, 3.2, 'paper123', 'dkey123')",
    [completedSubmissionId]
  );
  await pool.query(
    "insert into drillbit_reports (submission_id, status, error_message) values ($1, 'failed', 'Drillbit upload failed: 500')",
    [failedSubmissionId]
  );
  // noRowSubmissionId intentionally has no drillbit_reports row at all.
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from drillbit_reports where submission_id in ($1,$2,$3,$4)", [
      pendingSubmissionId,
      completedSubmissionId,
      failedSubmissionId,
      noRowSubmissionId,
    ]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("isDrillbitConfigured: true once DRILLBIT_EMAIL/DRILLBIT_PASSWORD are set", () => {
  assert.equal(isDrillbitConfigured(), true);
});

test("desk review page shows the AI/plagiarism column and every status correctly, without making a real Drillbit call", async () => {
  const res = await get(`/chair/dashboard/desk/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /AI \/ PLAGIARISM CHECK/);
  assert.match(html, /Processing \(usually 10-15 min\)/, "a pending submission with no folder_id/paper_id yet must show as still processing");
  assert.match(html, /Plagiarism: <strong>12\.5%<\/strong>/, "a completed submission must show its plagiarism percentage");
  assert.match(html, /AI Content: <strong>3\.2%<\/strong>/, "a completed submission must show its AI percentage");
  assert.match(html, new RegExp(`/chair/dashboard/desk/drillbit-report/${completedSubmissionId}/similarity`), "a completed submission must link to its similarity report");
  assert.match(html, new RegExp(`/chair/dashboard/desk/drillbit-report/${completedSubmissionId}/ai`), "a completed submission must link to its AI report");
  assert.match(html, /Analysis failed/, "a failed submission must show as failed");
  assert.match(html, /Not submitted/, "a submission with no drillbit_reports row at all must show as not submitted");
});

test("drillbit-report route: a chair who does not own this conference is blocked", async () => {
  const res = await get(`/chair/dashboard/desk/drillbit-report/${completedSubmissionId}/similarity`, otherChairToken);
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location"));
  assert.match(location, /not authorized/);
});

test("drillbit-report route: an invalid report type is rejected", async () => {
  const res = await get(`/chair/dashboard/desk/drillbit-report/${completedSubmissionId}/not-a-real-type`, chairToken);
  assert.equal(res.status, 400);
});

test("drillbit-report route: a submission with no paper_id/d_key yet redirects with a 'not ready' message instead of attempting a download", async () => {
  const res = await get(`/chair/dashboard/desk/drillbit-report/${pendingSubmissionId}/similarity`, chairToken);
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location"));
  assert.match(location, /not ready yet/);
});

test("drillbit-report route: a submission with no drillbit_reports row at all redirects with a 'not found' message", async () => {
  const res = await get(`/chair/dashboard/desk/drillbit-report/${noRowSubmissionId}/similarity`, chairToken);
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location"));
  assert.match(location, /not found/);
});
