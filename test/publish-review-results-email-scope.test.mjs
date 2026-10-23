// Regression test: POST /publish/review-results used to email EVERY
// submission in the conference whose status wasn't one of the three
// "still pending" statuses (Submitted Revised Paper / Submitted for
// Review / DESK ACCEPT) - including submissions that were already
// decided (and already notified) at an earlier publish, with no new
// decision involved this time. Concretely: author A submits a revision,
// the meta-reviewer recommends a decision for A, and the chair clicks
// Publish to notify A - but author B, whose submission was decided and
// emailed weeks ago and never had any revision, got the same decision
// email resent too, just because B's status also wasn't "pending".
//
// Fixed so only submissions whose decision is newly applied in this
// publish (i.e. had a meta_reviewer_decision row just now) get emailed.
// Uses the real route and the real local Postgres database; sendMail is
// intercepted via mailer.js's test-only recorder (SKIP_AUTOLISTEN=1).

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");
const { testSentEmails, resetTestSentEmails, testForcedFailures, resetTestForcedFailures } = await import("../mailer.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "publish-scope-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Publish Scope Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

let conferenceId;
let alreadyDecidedSubmissionId; // author B: decided and "emailed" at an earlier publish, no revision
let alreadyDecidedAuthorEmail = "publish-scope-author-b@example.com";
let revisedSubmissionId; // author A: just re-reviewed, meta-reviewer decision pending application
let revisedAuthorEmail = "publish-scope-author-a@example.com";

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, acceptance_notification) values ($1,$2,$3) returning conference_id",
    ["PUBLISH_SCOPE_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "2020-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  // Author B: already decided (e.g. accepted) at some earlier publish,
  // never had a revision, has no outstanding meta_reviewer_decision row.
  const already = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Already Decided Paper','PSB',901,'Accepted for Oral Presentation') returning submission_id",
    [conferenceId, alreadyDecidedAuthorEmail]
  );
  alreadyDecidedSubmissionId = already.rows[0].submission_id;

  // Author A: submitted a revision, meta-reviewer has just recommended a
  // decision for it (not yet applied/published).
  const revised = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Revised Paper','PSA',902,'Submitted Revised Paper') returning submission_id",
    [conferenceId, revisedAuthorEmail]
  );
  revisedSubmissionId = revised.rows[0].submission_id;

  await pool.query(
    "insert into meta_reviewer_decision (submission_id, status, remarks) values ($1, $2, $3)",
    [revisedSubmissionId, "Accepted for Oral Presentation", "Revision addressed all concerns, accept."]
  );
});

beforeEach(() => {
  resetTestSentEmails();
  resetTestForcedFailures();
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from meta_reviewer_decision where submission_id = ANY($1)", [[alreadyDecidedSubmissionId, revisedSubmissionId]]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("publishing a revised submission's decision emails only that author, not an already-decided author with no revision", async () => {
  const res = await fetch(base + "/publish/review-results", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${chairToken}` },
    body: new URLSearchParams({ conference_id: conferenceId }),
  });
  assert.equal(res.status, 302);

  const recipients = testSentEmails.map((e) => e.to);
  assert.ok(recipients.includes(revisedAuthorEmail), "the author whose revision was just decided must be emailed");
  assert.ok(
    !recipients.includes(alreadyDecidedAuthorEmail),
    "an author already decided (and already notified) at an earlier publish, with no new decision this time, must NOT be re-emailed"
  );

  const revisedRow = await pool.query("select submission_status from submissions where submission_id = $1", [revisedSubmissionId]);
  assert.equal(revisedRow.rows[0].submission_status, "Accepted for Oral Presentation", "the meta-reviewer's decision must still be applied to the submission");
});

test("one author's notification email failing to send doesn't stop the rest of the batch from being notified", async () => {
  // Two fresh submissions, both newly decided together in this one
  // publish - independent of any earlier test's state, since a
  // submission already published once is no longer "newly decided" (see
  // the test above) and so wouldn't be re-emailed regardless of success
  // or failure, which would make this test pass for the wrong reason.
  const succeedingAuthorEmail = "publish-scope-author-ok@example.com";
  const failingAuthorEmail = "publish-scope-author-fail@example.com";

  const succeeding = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Succeeding Notification Paper','PSOK',904,'Submitted Revised Paper') returning submission_id",
    [conferenceId, succeedingAuthorEmail]
  );
  const succeedingSubmissionId = succeeding.rows[0].submission_id;
  const failing = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Failing Notification Paper','PSC',903,'Submitted Revised Paper') returning submission_id",
    [conferenceId, failingAuthorEmail]
  );
  const failingSubmissionId = failing.rows[0].submission_id;

  await pool.query(
    "insert into meta_reviewer_decision (submission_id, status, remarks) values ($1, $2, $3)",
    [succeedingSubmissionId, "Accepted for Poster Presentation", "Accept."]
  );
  await pool.query(
    "insert into meta_reviewer_decision (submission_id, status, remarks) values ($1, $2, $3)",
    [failingSubmissionId, "Rejected", "Does not meet the bar."]
  );

  testForcedFailures.add(failingAuthorEmail);

  try {
    const res = await fetch(base + "/publish/review-results", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${chairToken}` },
      body: new URLSearchParams({ conference_id: conferenceId }),
    });
    assert.equal(res.status, 302, "the route must still redirect normally, not error out, when one notification fails");

    const location = decodeURIComponent(res.headers.get("location"));
    assert.match(location, /1 notification\(s\) failed to send/, "the failure must be surfaced to the chair in the redirect message");

    const recipients = testSentEmails.map((e) => e.to);
    assert.ok(recipients.includes(succeedingAuthorEmail), "the other author in the same batch must still have been notified");
    assert.ok(!recipients.includes(failingAuthorEmail), "the forced-failure recipient's send must not be recorded as sent");

    const failingRow = await pool.query("select submission_status, remarks from submissions where submission_id = $1", [failingSubmissionId]);
    assert.equal(failingRow.rows[0].submission_status, "Rejected", "the decision must still be applied to the database even though its notification email failed");
    assert.equal(failingRow.rows[0].remarks, "Does not meet the bar.");
  } finally {
    await pool.query("delete from meta_reviewer_decision where submission_id = ANY($1)", [[succeedingSubmissionId, failingSubmissionId]]);
    await pool.query("delete from submissions where submission_id = ANY($1)", [[succeedingSubmissionId, failingSubmissionId]]);
  }
});
