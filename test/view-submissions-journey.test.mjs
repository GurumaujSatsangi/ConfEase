// Regression tests for two related chair/dashboard/view-submissions changes:
// 1. The "Review Details" modal now shows a six-stage journey timeline
//    (Submitted -> Desk Review -> Peer Review -> Meta-Reviewer Review ->
//    Decision Published -> Submitted Final Paper) plus peer-review,
//    re-review, and meta-reviewer score/remarks tables - gated by the same
//    pre-existing "has this been published yet" condition the page already
//    used for the old accordion (unchanged).
// 2. Helmet's own default CSP directive (script-src-attr 'none') was
//    silently overriding this app's documented 'unsafe-inline' intent for
//    inline onclick/onsubmit handlers, breaking them site-wide (including
//    the password show/hide toggle). Fixed by setting scriptSrcAttr
//    explicitly.
// Uses the real routes and the real local Postgres database.

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
const chairEmail = "journey-test-chair@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Journey Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

let conferenceId;
let pendingSubmissionId; // "Submitted for Review" - details must stay hidden
let deskRejectSubmissionId; // "DESK REJECT" - a dead end
let decidedSubmissionId; // "Accepted for Oral Presentation" with a peer review and a meta-reviewer decision already applied
let fcrpSubmissionId; // "Submitted Final Camera Ready Paper for Oral Presentation" - decision already published, final paper already in

const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${chairToken}` }, redirect: "manual" });

// Isolates one submission's #reviewModal-<id> content. The page also has a
// data-bs-target="#reviewModal-<id>" button referencing the same id earlier
// in the table, so this anchors on the modal's own id="reviewModal-<id>"
// attribute specifically, then stops at the next modal's own id="...Modal-
// (detailsModal- or reviewModal- for any submission), not just any
// substring match of "reviewModal-".
function extractReviewModalHtml(html, submissionId) {
  const startMarker = `id="reviewModal-${submissionId}"`;
  const start = html.indexOf(startMarker);
  if (start === -1) return "";
  const searchFrom = start + startMarker.length;
  const nextModalId = html.indexOf('Modal-', searchFrom);
  return html.slice(start, nextModalId === -1 ? undefined : html.lastIndexOf("<div", nextModalId));
}

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, acceptance_notification) values ($1,$2,$3) returning conference_id",
    ["JOURNEY_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail, "2020-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const pending = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Pending Paper','JP1',101,'Submitted for Review') returning submission_id",
    [conferenceId, "journey-test-author-pending@example.com"]
  );
  pendingSubmissionId = pending.rows[0].submission_id;

  const deskRejected = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Desk Rejected Paper','JP2',102,'DESK REJECT') returning submission_id",
    [conferenceId, "journey-test-author-deskreject@example.com"]
  );
  deskRejectSubmissionId = deskRejected.rows[0].submission_id;

  const decided = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, remarks) values ($1,$2,'Decided Paper','JP3',103,'Accepted for Oral Presentation','Strong paper, accept.') returning submission_id",
    [conferenceId, "journey-test-author-decided@example.com"]
  );
  decidedSubmissionId = decided.rows[0].submission_id;

  await pool.query(
    "insert into peer_review (conference_id, submission_id, reviewer, mean_score, remarks) values ($1,$2,$3,$4,$5)",
    [conferenceId, decidedSubmissionId, chairEmail, 4.5, "Well written."]
  );

  // The meta-reviewer decided "Accepted for Oral Presentation", and the
  // author has since submitted their camera-ready paper - submission_status
  // has moved on from the decision itself, but remarks (set when the
  // decision was published) is untouched by that later status change.
  const fcrp = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, remarks) values ($1,$2,'FCRP Paper','JP4',104,'Submitted Final Camera Ready Paper for Oral Presentation','Great revision, accept.') returning submission_id",
    [conferenceId, "journey-test-author-fcrp@example.com"]
  );
  fcrpSubmissionId = fcrp.rows[0].submission_id;
});

after(async () => {
  if (conferenceId) {
    const ids = [pendingSubmissionId, deskRejectSubmissionId, decidedSubmissionId, fcrpSubmissionId];
    await pool.query("delete from peer_review where submission_id = ANY($1)", [ids]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("view-submissions: a pending submission's journey marks only 'Submitted' reached, and review details stay hidden", async () => {
  const res = await get(`/chair/dashboard/view-submissions/${conferenceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  const detailsModalMatch = html.split(`detailsModal-${pendingSubmissionId}`)[1];
  assert.ok(detailsModalMatch, "the details modal for the pending submission must be present");

  const reviewModalHtml = extractReviewModalHtml(html, pendingSubmissionId);
  assert.ok(reviewModalHtml, "the review modal for the pending submission must be present");

  assert.match(reviewModalHtml, /journey-step current">[\s\S]*?Submitted</, "the 'Submitted' stage must be the current one");
  assert.match(reviewModalHtml, /Review details are hidden until results are published/, "a still-pending submission must not reveal review details yet");
});

test("view-submissions: a desk-rejected submission's journey is a dead end after Desk Review", async () => {
  const res = await get(`/chair/dashboard/view-submissions/${conferenceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  const reviewModalHtml = extractReviewModalHtml(html, deskRejectSubmissionId);
  assert.ok(reviewModalHtml, "the review modal for the desk-rejected submission must be present");

  assert.match(reviewModalHtml, /journey-step rejected">[\s\S]*?Desk Review</, "Desk Review must be marked rejected");
  assert.match(reviewModalHtml, /journey-step skipped">[\s\S]*?Peer Review</, "Peer Review must be marked skipped after a desk rejection");
});

test("view-submissions: a decided, published submission shows its peer review and meta-reviewer decision tables", async () => {
  const res = await get(`/chair/dashboard/view-submissions/${conferenceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  const reviewModalHtml = extractReviewModalHtml(html, decidedSubmissionId);
  assert.ok(reviewModalHtml, "the review modal for the decided submission must be present");

  assert.match(reviewModalHtml, /journey-step current">[\s\S]*?Decision Published</, "a decided-but-not-yet-FCRP submission's current stage must be Decision Published");
  assert.match(reviewModalHtml, />Peer Review</, "the peer review table must be shown once published");
  assert.match(reviewModalHtml, /Well written\./, "the reviewer's remarks must appear");
  assert.match(reviewModalHtml, />Meta-Reviewer Decision</, "the meta-reviewer's final decision must be shown once published");
  assert.match(reviewModalHtml, /Strong paper, accept\./, "the meta-reviewer's remarks must appear");
});

test("view-submissions: once the final paper is submitted, the journey's last stage reads as done (not still in progress), and the decision shown is the original decision, not the drifted current status", async () => {
  const res = await get(`/chair/dashboard/view-submissions/${conferenceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  const reviewModalHtml = extractReviewModalHtml(html, fcrpSubmissionId);
  assert.ok(reviewModalHtml, "the review modal for the FCRP submission must be present");

  assert.match(
    reviewModalHtml,
    /journey-step done">[\s\S]*?Submitted Final\s*Paper/,
    "'Submitted Final Paper' must read as done, not current/in-progress, once the final paper has actually been submitted"
  );
  assert.doesNotMatch(
    reviewModalHtml,
    /journey-step current">[\s\S]*?Submitted Final\s*Paper/,
    "the final stage must never be shown as still in progress"
  );

  assert.match(
    reviewModalHtml,
    /Accepted for Oral Presentation<\/td>\s*<td>Great revision, accept\./,
    "the Meta-Reviewer Decision table must show the original decision (Accepted for Oral Presentation), not the submission's current status (Submitted Final Camera Ready Paper for Oral Presentation)"
  );
});

test("every response carries a CSP that allows inline event handler attributes (script-src-attr), not Helmet's silent 'none' default", async () => {
  const res = await get(`/chair/dashboard/view-submissions/${conferenceId}`);
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, "a CSP header must be present");
  assert.match(csp, /script-src-attr 'unsafe-inline'/, "script-src-attr must explicitly allow inline handlers like onclick=, matching this app's documented scriptSrc 'unsafe-inline' intent");
  assert.doesNotMatch(csp, /script-src-attr 'none'/);
});
