// Regression test for BL-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// the bulk certificate-generation route and the Excel-export routes had no
// rate limiting beyond the blunt global per-IP limiter, which does nothing
// to stop one authenticated account from repeatedly triggering an
// expensive operation on the same conference. conferenceOperationCooldown
// (api/index.js) adds a short per-(operation, conference, account)
// cooldown, reusing the same Redis/in-memory-fallback architecture as the
// existing authRateLimitMemory.
//
// The cooldown middleware itself checks `SKIP_AUTOLISTEN` and no-ops under
// the test harness (every other test file in this suite needs that, since
// several tests legitimately call the same export route more than once).
// This file is the one place that deliberately unsets it immediately
// before firing the two back-to-back requests being tested, then restores
// it - same technique test/authz.test.mjs already uses for its
// "ADMIN_EMAILS unset" test.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "bl04-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "BL04 Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

let conferenceId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["BL04_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a second export request for the same conference within the cooldown window is rejected with 429", async () => {
  const saved = process.env.SKIP_AUTOLISTEN;
  try {
    delete process.env.SKIP_AUTOLISTEN;

    const first = await fetch(base + `/chair/dashboard/registrations/${conferenceId}/export`, {
      redirect: "manual",
      headers: { Authorization: `Bearer ${chairToken}` },
    });
    assert.equal(first.status, 200, "the first request must succeed normally");

    const second = await fetch(base + `/chair/dashboard/registrations/${conferenceId}/export`, {
      redirect: "manual",
      headers: { Authorization: `Bearer ${chairToken}` },
    });
    assert.equal(second.status, 429, "a second request for the same conference within the cooldown must be rejected");
  } finally {
    process.env.SKIP_AUTOLISTEN = saved;
  }
});

test("the same route for a different conference is not affected by another conference's cooldown", async () => {
  const saved = process.env.SKIP_AUTOLISTEN;
  let otherConferenceId;
  try {
    delete process.env.SKIP_AUTOLISTEN;

    const other = await pool.query(
      "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
      ["BL04_TEST_OTHER_" + crypto.randomBytes(3).toString("hex"), chairEmail]
    );
    otherConferenceId = other.rows[0].conference_id;

    const res = await fetch(base + `/chair/dashboard/registrations/${otherConferenceId}/export`, {
      redirect: "manual",
      headers: { Authorization: `Bearer ${chairToken}` },
    });
    assert.equal(res.status, 200, "a different conference's export must not be blocked by another conference's cooldown");
  } finally {
    process.env.SKIP_AUTOLISTEN = saved;
    if (otherConferenceId) await pool.query("delete from conferences where conference_id = $1", [otherConferenceId]);
  }
});
