// Regression tests for a set of related review-workflow changes:
// 1. The Chair's direct decision-making routes (resolve-conflicts,
//    resolve-re-review-conflicts, and their POST handlers) have been removed
//    entirely - a submission's final decision now only ever comes from a
//    Meta-Reviewer recommendation, applied at /publish/review-results.
// 2. The Meta-Reviewer dashboard now also lists "Submitted Revised Paper"
//    submissions that have been re-reviewed, not just first-round
//    "DESK ACCEPT" submissions, since the Chair no longer resolves revised
//    papers directly either.
// 3. The peer-review deadline (conferences.deadline_peer_review) is now
//    enforced: once it has passed, a reviewer can no longer open the review
//    form or submit a review (first round or re-review).
// Uses the real routes and the real local Postgres database.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "review-workflow-test-chair@example.com";
const metaReviewerEmail = "review-workflow-test-meta@example.com";
const reviewerEmail = "review-workflow-test-reviewer@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "RW Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const conferenceIds = [];
const trackIds = [];
const submissionIds = [];

async function makeConference() {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["RW_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceIds.push(conf.rows[0].conference_id);
  return conf.rows[0].conference_id;
}

async function makeTrack(conferenceId, overrides = {}) {
  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, meta_reviewer, track_reviewers) values ($1,$2,$3,$4) returning track_id",
    [conferenceId, "RW Track " + crypto.randomBytes(2).toString("hex"), overrides.meta_reviewer ?? metaReviewerEmail, overrides.track_reviewers ?? [reviewerEmail]]
  );
  trackIds.push(track.rows[0].track_id);
  return track.rows[0].track_id;
}

async function makeSubmission(conferenceId, trackId, status) {
  // FILE-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md): the paper's
  // file link shown in any view is now a freshly-signed Cloudinary
  // download URL (getSignedPaperUrl, api/index.js), generated from
  // file_public_id/file_resource_type/file_format - not the stored
  // file_url itself, which is never rendered directly. A row needs a
  // file_public_id for a link to appear at all.
  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, track_id, file_url, file_public_id, file_resource_type, file_format) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning submission_id",
    [conferenceId, "rw-test-author@example.com", "RW Test Submission", "RW" + crypto.randomBytes(3).toString("hex"), status, trackId, "https://example.com/rw-test-paper.pdf", "rw-test-papers/rw-test-" + crypto.randomBytes(3).toString("hex"), "image", "pdf"]
  );
  submissionIds.push(sub.rows[0].submission_id);
  return sub.rows[0].submission_id;
}

after(async () => {
  if (submissionIds.length) {
    await pool.query("delete from peer_review where submission_id = ANY($1)", [submissionIds]);
    await pool.query("delete from revised_submissions where submission_id = ANY($1)", [submissionIds]);
    await pool.query("delete from meta_reviewer_decision where submission_id = ANY($1)", [submissionIds]);
    await pool.query("delete from submissions where submission_id = ANY($1)", [submissionIds]);
  }
  if (trackIds.length) await pool.query("delete from conference_tracks where track_id = ANY($1)", [trackIds]);
  if (conferenceIds.length) await pool.query("delete from conferences where conference_id = ANY($1)", [conferenceIds]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the Chair's old direct-decision routes no longer exist", async () => {
  const conferenceId = await makeConference();
  const trackId = await makeTrack(conferenceId);
  const submissionId = await makeSubmission(conferenceId, trackId, "DESK ACCEPT");

  const getResolve = await get(`/chair/dashboard/resolve-conflicts/${submissionId}`, chairToken);
  assert.equal(getResolve.status, 404, "GET resolve-conflicts must no longer be a route");

  const postResolve = await post(`/resolve-conflict/${submissionId}/${conferenceId}`, chairToken, { final_remarks: "x", status: "Rejected" });
  assert.equal(postResolve.status, 404, "POST resolve-conflict must no longer be a route");

  const getReReview = await get(`/chair/dashboard/resolve-re-review-conflicts/${submissionId}`, chairToken);
  assert.equal(getReReview.status, 404, "GET resolve-re-review-conflicts must no longer be a route");

  const postReReview = await post(`/resolve-re-review-conflicts/${submissionId}/${conferenceId}`, chairToken, { final_remarks: "x", status: "Rejected" });
  assert.equal(postReReview.status, 404, "POST resolve-re-review-conflicts must no longer be a route");

  // Sanity: the submission's status is untouched by any of the above.
  const row = await pool.query("select submission_status from submissions where submission_id = $1", [submissionId]);
  assert.equal(row.rows[0].submission_status, "DESK ACCEPT");
});

test("Meta-Reviewer dashboard lists both a first-round DESK ACCEPT submission and a re-reviewed Submitted Revised Paper submission", async () => {
  const conferenceId = await makeConference();
  const trackId = await makeTrack(conferenceId);
  const metaToken = jwt.sign({ typ: "access", email: metaReviewerEmail, name: "RW Meta", user_id: 2, role: "user", roles: { [conferenceId]: ["meta_reviewer"] } }, secret, { expiresIn: "5m" });

  const firstRoundId = await makeSubmission(conferenceId, trackId, "DESK ACCEPT");
  await pool.query(
    "insert into peer_review (conference_id, submission_id, originality_score, relevance_score, technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status, remarks, reviewer, review_status) values ($1,$2,3,3,3,3,3,3,'Accepted for Oral Presentation','ok',$3,'Reviewed')",
    [conferenceId, firstRoundId, reviewerEmail]
  );

  const revisedId = await makeSubmission(conferenceId, trackId, "Submitted Revised Paper");
  await pool.query(
    "insert into revised_submissions (submission_id, originality_score, relevance_score, technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status, review_status, reviewer, remarks) values ($1,3,3,3,3,3,3,'Accepted for Oral Presentation','Re-Reviewed',$2,'ok')",
    [revisedId, reviewerEmail]
  );

  const html = await (await get(`/meta-reviewer/dashboard/${conferenceId}`, metaToken)).text();
  assert.ok(html.includes(`/meta-reviewer/dashboard/recommendation-submission/${firstRoundId}`), "the first-round submission must be listed");
  assert.ok(html.includes(`/meta-reviewer/dashboard/recommendation-submission/${revisedId}`), "the re-reviewed submission must also be listed");
  assert.match(html, /First Review/);
  assert.match(html, /Re-Review/);

  // The recommendation form for the revised submission must show the
  // re-review data (from revised_submissions), not the first-round table.
  const formHtml = await (await get(`/meta-reviewer/dashboard/recommendation-submission/${revisedId}`, metaToken)).text();
  assert.ok(formHtml.includes(reviewerEmail), "the re-reviewer's identity must appear on the recommendation form");
  assert.match(formHtml, /re-review/i);
});

test("peer-review deadline: once it has passed, a reviewer cannot open or submit a review", async () => {
  const conferenceId = await makeConference();
  await pool.query("update conferences set deadline_peer_review = $1 where conference_id = $2", ["2000-01-01", conferenceId]);
  const trackId = await makeTrack(conferenceId);
  const submissionId = await makeSubmission(conferenceId, trackId, "DESK ACCEPT");
  const paperCode = (await pool.query("select paper_code from submissions where submission_id = $1", [submissionId])).rows[0].paper_code;

  const reviewerToken = jwt.sign({ typ: "access", email: reviewerEmail, name: "RW Reviewer", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

  const formHtml = await (await get(`/reviewer/dashboard/review/${paperCode}`, reviewerToken)).text();
  assert.match(formHtml, /deadline.*passed/i, "the review form must refuse to render once the deadline has passed");

  const postRes = await post("/mark-as-reviewed", reviewerToken, {
    submission_id: submissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: 3,
    relevance_score: 3,
    technical_quality_score: 3,
    clarity_score: 3,
    impact_score: 3,
    remarks: "test",
  });
  assert.equal(postRes.status, 302);
  const location = postRes.headers.get("location") || "";
  assert.match(location, /deadline.*passed/i, "the POST must also refuse once the deadline has passed");

  const stored = await pool.query("select 1 from peer_review where submission_id = $1", [submissionId]);
  assert.equal(stored.rows.length, 0, "no review row should have been written after the deadline");
});

test("peer-review deadline also blocks re-review of a revised paper", async () => {
  const conferenceId = await makeConference();
  await pool.query("update conferences set deadline_peer_review = $1 where conference_id = $2", ["2000-01-01", conferenceId]);
  const trackId = await makeTrack(conferenceId);
  const submissionId = await makeSubmission(conferenceId, trackId, "Submitted Revised Paper");
  const paperCode = (await pool.query("select paper_code from submissions where submission_id = $1", [submissionId])).rows[0].paper_code;

  const reviewerToken = jwt.sign({ typ: "access", email: reviewerEmail, name: "RW Reviewer", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

  const formHtml = await (await get(`/reviewer/dashboard/re-review/${paperCode}`, reviewerToken)).text();
  assert.match(formHtml, /deadline.*passed/i);

  const postRes = await post("/mark-as-re-reviewed", reviewerToken, {
    submission_id: submissionId,
    conference_id: conferenceId,
    status: "Accepted for Oral Presentation",
    originality_score: 3,
    relevance_score: 3,
    technical_quality_score: 3,
    clarity_score: 3,
    impact_score: 3,
    remarks: "test",
  });
  assert.equal(postRes.status, 302);
  assert.match(postRes.headers.get("location") || "", /deadline.*passed/i);

  const stored = await pool.query("select 1 from revised_submissions where submission_id = $1", [submissionId]);
  assert.equal(stored.rows.length, 0, "no re-review row should have been written after the deadline");
});

test("AI detection columns are gone from the schema", async () => {
  const cols = await pool.query(
    "select table_name, column_name from information_schema.columns where column_name in ('ai_score','is_ai') and table_name in ('submissions','revised_submissions')"
  );
  assert.equal(cols.rows.length, 0, "ai_score/is_ai must not exist on submissions or revised_submissions anymore");
});

test("cfp_link: set at creation, shown on the conference page, editable afterwards", async () => {
  const userToken = jwt.sign({ typ: "access", email: "rw-test-author@example.com", name: "RW Author", user_id: 4, role: "user", roles: {} }, secret, { expiresIn: "5m" });

  const createRes = await post("/create-new-conference", chairToken, {
    title: "RW_TEST_CFP_" + crypto.randomBytes(3).toString("hex"),
    description: "d",
    conference_start_date: "2027-01-01",
    conference_end_date: "2027-01-02",
    full_paper_submission: "2027-01-01",
    acceptance_notification: "2027-01-01",
    camera_ready_paper_submission: "2027-01-01",
    deadline_peer_review: "2027-01-01",
    cfp_link: "https://example.com/cfp-v1.pdf",
  });
  assert.equal(createRes.status, 302);

  const created = await pool.query("select conference_id, cfp_link from conferences where cfp_link = $1", ["https://example.com/cfp-v1.pdf"]);
  assert.equal(created.rows.length, 1, "the conference must be saved with the submitted cfp_link");
  const conferenceId = created.rows[0].conference_id;
  conferenceIds.push(conferenceId);

  const pageHtml = await (await get(`/conference/${conferenceId}`, userToken)).text();
  assert.ok(pageHtml.includes("https://example.com/cfp-v1.pdf"), "the public conference page must show the CFP link");

  const updateRes = await post(`/chair/dashboard/update-conference/${conferenceId}`, chairToken, {
    title: "RW_TEST_CFP_updated",
    description: "d2",
    conference_start_date: "2027-01-01",
    conference_end_date: "2027-01-02",
    full_paper_submission: "2027-01-01",
    acceptance_notification: "2027-01-01",
    camera_ready_paper_submission: "2027-01-01",
    cfp_link: "https://example.com/cfp-v2.pdf",
  });
  assert.equal(updateRes.status, 302);

  const updated = await pool.query("select cfp_link from conferences where conference_id = $1", [conferenceId]);
  assert.equal(updated.rows[0].cfp_link, "https://example.com/cfp-v2.pdf", "update-conference must save the new cfp_link");
});

test("Meta-Reviewer dashboard/form/decision are all gated on EVERY assigned reviewer having submitted", async () => {
  const conferenceId = await makeConference();
  const secondReviewerEmail = "review-workflow-test-reviewer-2@example.com";
  const trackId = await makeTrack(conferenceId, { track_reviewers: [reviewerEmail, secondReviewerEmail] });
  const metaToken = jwt.sign({ typ: "access", email: metaReviewerEmail, name: "RW Meta 2", user_id: 6, role: "user", roles: { [conferenceId]: ["meta_reviewer"] } }, secret, { expiresIn: "5m" });

  const submissionId = await makeSubmission(conferenceId, trackId, "DESK ACCEPT");
  await pool.query("update submissions set paper_number = 7 where submission_id = $1", [submissionId]);
  // Only the first of the two assigned reviewers has reviewed so far.
  await pool.query(
    "insert into peer_review (conference_id, submission_id, originality_score, relevance_score, technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status, remarks, reviewer, review_status) values ($1,$2,3,3,3,3,3,3,'Accepted for Oral Presentation','ok',$3,'Reviewed')",
    [conferenceId, submissionId, reviewerEmail]
  );

  const dashboardHtml = await (await get(`/meta-reviewer/dashboard/${conferenceId}`, metaToken)).text();
  assert.ok(!dashboardHtml.includes(`/meta-reviewer/dashboard/recommendation-submission/${submissionId}`), "a submission with an outstanding reviewer must not appear on the dashboard yet");

  const formRes = await get(`/meta-reviewer/dashboard/recommendation-submission/${submissionId}`, metaToken);
  assert.equal(formRes.status, 302);
  assert.match(decodeURIComponent(formRes.headers.get("location") || ""), /not.*submitted/i);

  const postRes = await post(`/submit-meta-reviewer-decision/${submissionId}`, metaToken, { status: "Accepted for Oral Presentation", remarks: "trying anyway" });
  assert.equal(postRes.status, 302);
  assert.match(decodeURIComponent(postRes.headers.get("location") || ""), /not.*submitted/i);
  const decisionRow = await pool.query("select 1 from meta_reviewer_decision where submission_id = $1", [submissionId]);
  assert.equal(decisionRow.rows.length, 0, "no recommendation should have been recorded while a reviewer is still outstanding");

  // Now the second reviewer submits too - the submission must appear, and
  // the recommendation form/page must now work.
  await pool.query(
    "insert into peer_review (conference_id, submission_id, originality_score, relevance_score, technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status, remarks, reviewer, review_status) values ($1,$2,4,4,4,4,4,4,'Accepted for Oral Presentation','ok too',$3,'Reviewed')",
    [conferenceId, submissionId, secondReviewerEmail]
  );

  const dashboardHtml2 = await (await get(`/meta-reviewer/dashboard/${conferenceId}`, metaToken)).text();
  assert.ok(dashboardHtml2.includes(`/meta-reviewer/dashboard/recommendation-submission/${submissionId}`), "the submission must appear once every assigned reviewer has submitted");

  const formHtml2 = await (await get(`/meta-reviewer/dashboard/recommendation-submission/${submissionId}`, metaToken)).text();
  assert.ok(formHtml2.includes(reviewerEmail) && formHtml2.includes(secondReviewerEmail), "both reviewers must be shown");
  // Paper ID and a link to the paper must be shown on the form. The link
  // is a freshly-signed Cloudinary download URL, not the stored file_url
  // itself (FILE-04) - assert on the signed download API's own URL shape
  // and the asset's public_id, which it must always contain.
  const paperRow = await pool.query("select paper_number, file_public_id from submissions where submission_id = $1", [submissionId]);
  assert.ok(formHtml2.includes(String(paperRow.rows[0].paper_number)), "the Paper ID must be shown on the recommendation form");
  assert.ok(
    formHtml2.includes("/image/download") && formHtml2.includes(encodeURIComponent(paperRow.rows[0].file_public_id)),
    "a signed download link for the paper file must be shown on the recommendation form"
  );
});

test("a chair who is neither the creator nor (the now-removed) a co-chair cannot manage someone else's conference", async () => {
  const conferenceId = await makeConference();
  const strangerChairToken = jwt.sign({ typ: "chair", email: "rw-test-stranger-chair@example.com", name: "Stranger Chair", user_id: 5, role: "chair" }, secret, { expiresIn: "5m" });

  const res = await get(`/chair/dashboard/edit-conference/${conferenceId}`, strangerChairToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);
});
