// Regression tests for the "Manage Certificates" page (replaces the chair
// dashboard's old "Enable PDF Download" button, which now lives on this
// page instead): GET /chair/dashboard/manage-certificates/:id lists every
// certificate-eligible submission's Paper ID and a human-readable
// certificate status, sourced from the certificates table. These tests
// seed certificates rows directly (GENERATED / FAILED with a reason / no
// row at all) rather than going through the real Canva/Cloudinary
// pipeline - that pipeline's own success/failure behavior is covered in
// test/canva.test.mjs, which owns the canva_connection singleton these
// tests deliberately don't touch.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "manage-cert-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Manage Cert Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

let conferenceId;
let generatedSubmissionId;
let failedSubmissionId;
let pendingSubmissionId;
let notEligibleSubmissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["MANAGE_CERT_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  const makeSub = async (paperCode, paperNumber, status) => {
    const sub = await pool.query(
      "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,$3,$4,$5,$6) returning submission_id",
      [conferenceId, "manage-cert-test-author@example.com", "Manage Cert Test Paper " + paperCode, paperCode, paperNumber, status]
    );
    return sub.rows[0].submission_id;
  };

  generatedSubmissionId = await makeSub("MC01", 101, "Presentation Completed");
  failedSubmissionId = await makeSub("MC02", 102, "Poster Scored");
  pendingSubmissionId = await makeSub("MC03", 103, "Presentation Completed");
  notEligibleSubmissionId = await makeSub("MC04", 104, "Submitted for Review");

  await pool.query(
    "insert into certificates (conference_id, submission_id, status, file_url) values ($1,$2,'GENERATED','https://example.com/cert.pdf')",
    [conferenceId, generatedSubmissionId]
  );
  await pool.query(
    "insert into certificates (conference_id, submission_id, status, error_message) values ($1,$2,'FAILED',$3)",
    [conferenceId, failedSubmissionId, "Canva is not connected yet. An Admin needs to connect it from the Admin page before certificates can be generated."]
  );
  // pendingSubmissionId deliberately gets no certificates row at all.
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from certificates where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the page shows each eligible submission's Paper ID and a readable status, with Regenerate only on the FAILED row", async () => {
  const html = await (await get(`/chair/dashboard/manage-certificates/${conferenceId}`, chairToken)).text();

  assert.ok(html.includes("0101"), "the generated submission's Paper ID must be shown");
  assert.ok(html.includes("0102"), "the failed submission's Paper ID must be shown");
  assert.ok(html.includes("0103"), "the not-yet-generated submission's Paper ID must be shown");
  assert.ok(!html.includes("0104"), "a submission that isn't yet certificate-eligible must not appear at all");

  assert.match(html, /Generated/);
  assert.match(html, /Failed: Canva is not connected yet/, "the FAILED row's actual error message must be shown, not a generic label");
  assert.match(html, /Not Yet Generated/);

  const regenerateCount = (html.match(/Regenerate Certificate/g) || []).length;
  assert.equal(regenerateCount, 1, "exactly one row (the FAILED one) must offer Regenerate");
  assert.ok(html.includes(`/chair/dashboard/regenerate-certificate/${failedSubmissionId}`), "the Regenerate button must target the FAILED submission specifically");

  assert.ok(html.includes("Enable PDF Download"), "the bulk-generation button must still be present on this page");
});

test("a non-chair cannot view the Manage Certificates page", async () => {
  const userToken = jwt.sign({ typ: "access", email: "manage-cert-not-a-chair@example.com", name: "Not A Chair", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });
  const res = await get(`/chair/dashboard/manage-certificates/${conferenceId}`, userToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /login|not authorized/i);
});

test("regenerating a submission that isn't certificate-eligible is rejected", async () => {
  const res = await fetch(base + `/chair/dashboard/regenerate-certificate/${notEligibleSubmissionId}`, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${chairToken}` },
  });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not yet eligible/);
});
