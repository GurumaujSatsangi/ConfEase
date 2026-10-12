// Regression test for DB-06 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// POST /publish/review-results previously applied outstanding
// meta-reviewer decisions via a loop of individual UPDATEs followed by a
// separate bulk DELETE, with no transaction - a crash partway through
// could leave a submission updated with its decision applied while the
// corresponding meta_reviewer_decision row was never deleted, letting the
// same decision be silently reapplied on a later publish. Now wrapped in
// one transaction. This test verifies the end-to-end correct-path
// behavior (not a simulated crash, which the existing transaction pattern
// used elsewhere in this file already gives strong confidence in): a
// pending meta-reviewer decision is applied to the submission AND the
// decision row is cleared, together, when publish runs.

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
const chairEmail = "db06-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "DB06 Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

let conferenceId;
let submissionId;

before(async () => {
  const conf = await pool.query(
    // A date far in the past means every submission not pending-review is
    // treated as past-notification-date, matching how the route's own
    // "pending" bucket works - the one actually-processed submission in
    // this test just needs a status outside {Submitted Revised Paper,
    // Submitted for Review, DESK ACCEPT} so it isn't routed into the
    // pending list instead of being published directly.
    "insert into conferences (title, created_by, acceptance_notification) values ($1,$2,$3) returning conference_id",
    ["DB06_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "2020-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'DB06 Test Paper','DB06',801,'DESK ACCEPT') returning submission_id",
    [conferenceId, "db06-test-author@example.com"]
  );
  submissionId = sub.rows[0].submission_id;

  await pool.query(
    "insert into meta_reviewer_decision (submission_id, status, remarks) values ($1, $2, $3)",
    [submissionId, "Accepted for Oral Presentation", "Strong paper, accept."]
  );
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from meta_reviewer_decision where submission_id = $1", [submissionId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("publishing applies the pending meta-reviewer decision to the submission and clears the decision row, together", async () => {
  const res = await fetch(base + "/publish/review-results", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${chairToken}` },
    body: new URLSearchParams({ conference_id: conferenceId }),
  });

  // DESK ACCEPT is one of the "pending acceptance notification" statuses
  // (handled by a separate chair-facing flow), so after the meta-decision
  // is applied the status becomes "Accepted for Oral Presentation", which
  // is NOT in that pending set - so this submission is published directly
  // and the route redirects rather than rendering the pending-notifications
  // page.
  assert.equal(res.status, 302);

  const submission = await pool.query("select submission_status, remarks from submissions where submission_id = $1", [submissionId]);
  assert.equal(submission.rows[0].submission_status, "Accepted for Oral Presentation", "the meta-reviewer's decision must be applied to the submission");
  assert.equal(submission.rows[0].remarks, "Strong paper, accept.");

  const decisionRow = await pool.query("select 1 from meta_reviewer_decision where submission_id = $1", [submissionId]);
  assert.equal(decisionRow.rows.length, 0, "the meta_reviewer_decision row must be cleared once applied, together with the submission update");
});
