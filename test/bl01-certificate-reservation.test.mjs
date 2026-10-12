// Regression tests for BL-01 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// certificate generation previously read "not yet generated," then called
// Canva/Cloudinary/email, then wrote the row - a check-then-act race where
// a double-click or retried request could run the whole expensive external
// pipeline twice for the same recipient. Fixed with an atomic reservation
// INSERT ... ON CONFLICT ... WHERE ... RETURNING (see
// generateAndEmailRoleCertificate and the author-certificate loop in
// POST /chair/dashboard/enable-pdf-download/:id, api/index.js).
//
// These tests exercise the reservation SQL directly against role_certificates
// and certificates - the actual mechanism that prevents the race - rather
// than mocking the whole Canva/Cloudinary/email pipeline through the HTTP
// route (which would also require touching canva_connection, a true
// app-wide singleton that only test/canva.test.mjs is allowed to touch -
// see that file's header comment for why). Testing the SQL pattern itself
// with genuinely concurrent requests (Promise.all) is a direct, reliable
// verification of the fix with no external-service mocking needed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: pool } = await import("../config/db.js");

const reserveRoleCertificate = (conferenceId, role, email, contextId) =>
  pool.query(
    `insert into role_certificates (conference_id, role, email, context_id, status, reserved_at)
     values ($1,$2,$3,$4,'GENERATING',now())
     on conflict (conference_id, role, email, context_id) do update
       set status = 'GENERATING', reserved_at = now()
       where role_certificates.status is distinct from 'GENERATED'
         and (role_certificates.reserved_at is null or role_certificates.reserved_at < now() - interval '5 minutes')
     returning *`,
    [conferenceId, role, email, contextId]
  );

const reserveAuthorCertificate = (conferenceId, submissionId) =>
  pool.query(
    `insert into certificates (conference_id, submission_id, status, reserved_at)
     values ($1, $2, 'GENERATING', now())
     on conflict (submission_id) do update
       set status = 'GENERATING', reserved_at = now()
       where certificates.status is distinct from 'GENERATED'
         and (certificates.reserved_at is null or certificates.reserved_at < now() - interval '5 minutes')
     returning *`,
    [conferenceId, submissionId]
  );

let conferenceId;
let submissionId;

after(async () => {
  if (conferenceId) {
    await pool.query("delete from role_certificates where conference_id = $1", [conferenceId]);
    await pool.query("delete from certificates where conference_id = $1", [conferenceId]);
  }
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("two concurrent reservation attempts for the same role certificate: only one wins", async () => {
  conferenceId = "BL01_TEST_" + crypto.randomBytes(3).toString("hex");
  const email = "bl01-reviewer@example.com";
  const contextId = crypto.randomUUID();

  const [a, b] = await Promise.all([
    reserveRoleCertificate(conferenceId, "reviewer", email, contextId),
    reserveRoleCertificate(conferenceId, "reviewer", email, contextId),
  ]);

  const winners = [a, b].filter((r) => r.rows.length > 0);
  assert.equal(winners.length, 1, "exactly one of the two concurrent reservations must win");

  const rows = await pool.query("select count(*)::int as n from role_certificates where conference_id = $1 and role = $2 and email = $3 and context_id = $4", [
    conferenceId,
    "reviewer",
    email,
    contextId,
  ]);
  assert.equal(rows.rows[0].n, 1, "only one row must exist regardless of how many reservation attempts ran");
});

test("a reservation is not granted again once the certificate is GENERATED", async () => {
  const email = "bl01-reviewer-generated@example.com";
  const contextId = crypto.randomUUID();

  const first = await reserveRoleCertificate(conferenceId, "reviewer", email, contextId);
  assert.equal(first.rows.length, 1);

  await pool.query("update role_certificates set status = 'GENERATED', file_url = 'https://example.com/cert.pdf' where conference_id = $1 and role = 'reviewer' and email = $2 and context_id = $3", [
    conferenceId,
    email,
    contextId,
  ]);

  const second = await reserveRoleCertificate(conferenceId, "reviewer", email, contextId);
  assert.equal(second.rows.length, 0, "a GENERATED certificate must never be re-reserved, even immediately after completion");
});

test("a stale (crashed) reservation can be reclaimed, but a fresh one cannot", async () => {
  const email = "bl01-reviewer-stale@example.com";
  const contextId = crypto.randomUUID();

  const first = await reserveRoleCertificate(conferenceId, "reviewer", email, contextId);
  assert.equal(first.rows.length, 1);

  // A second attempt immediately after must NOT win - this is what
  // protects against the double-click/retry race in real usage.
  const immediateRetry = await reserveRoleCertificate(conferenceId, "reviewer", email, contextId);
  assert.equal(immediateRetry.rows.length, 0, "a fresh (non-stale) reservation must not be reclaimed");

  // Simulate a crash during generation: the row is stuck at GENERATING
  // with an old reserved_at (older than the 5-minute staleness window).
  await pool.query("update role_certificates set reserved_at = now() - interval '10 minutes' where conference_id = $1 and role = 'reviewer' and email = $2 and context_id = $3", [
    conferenceId,
    email,
    contextId,
  ]);

  const afterStale = await reserveRoleCertificate(conferenceId, "reviewer", email, contextId);
  assert.equal(afterStale.rows.length, 1, "a stale reservation (crashed/abandoned attempt) must be reclaimable, so a retry is never permanently stuck");
});

test("author-certificate reservation (certificates table) follows the same race-safe pattern", async () => {
  submissionId = crypto.randomUUID();

  const [a, b] = await Promise.all([
    reserveAuthorCertificate(conferenceId, submissionId),
    reserveAuthorCertificate(conferenceId, submissionId),
  ]);

  const winners = [a, b].filter((r) => r.rows.length > 0);
  assert.equal(winners.length, 1, "exactly one of the two concurrent author-certificate reservations must win");

  const rows = await pool.query("select count(*)::int as n from certificates where submission_id = $1", [submissionId]);
  assert.equal(rows.rows[0].n, 1);
});
