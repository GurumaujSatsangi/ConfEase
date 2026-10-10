// Regression tests for two meta-reviewer bugs reported together:
// 1. GET /meta-reviewer/dashboard/:id listed one row per peer_review (i.e.
//    per reviewer) instead of one row per submission, so a paper reviewed
//    by two reviewers showed up twice with two separate "Submit
//    Recommendation" links to the same submission.
// 2. views/meta-reviewer-form.ejs closed its </table> tag inside the
//    peer_review.forEach loop, so only the first review rendered inside
//    the table - every review after the first rendered as bare, unstyled
//    text outside any table structure.
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
const metaReviewerEmail = "meta-dedup-test@example.com";
// hasConferenceRole reads user.roles[conferenceId] as an array of role
// strings, so the token can only be minted once the conference exists.
let token;

const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

let conferenceId;
let trackId;
let submissionId;
const peerReviewIds = [];
after(async () => {
  if (peerReviewIds.length) await pool.query("delete from peer_review where id = ANY($1)", [peerReviewIds]);
  if (conferenceId) {
    await pool.query("delete from meta_reviewer_decision where submission_id = $1", [submissionId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a submission reviewed by two reviewers appears once on the meta-reviewer dashboard, and both reviews render inside the recommendation table", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["META_DEDUP_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;
  token = jwt.sign(
    { typ: "access", email: metaReviewerEmail, name: "Meta Dedup Test", user_id: 1, role: "user", roles: { [conferenceId]: ["meta_reviewer"] } },
    secret,
    { expiresIn: "5m" }
  );

  const track = await pool.query(
    "insert into conference_tracks (conference_id, track_name, meta_reviewer) values ($1,$2,$3) returning track_id",
    [conferenceId, "Dedup Track", metaReviewerEmail]
  );
  trackId = track.rows[0].track_id;

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, track_id) values ($1,$2,$3,$4,'DESK ACCEPT',$5) returning submission_id",
    [conferenceId, "author@example.com", "Dedup Submission", "MDTA", trackId]
  );
  submissionId = sub.rows[0].submission_id;

  const baseId = Date.now();
  for (const [i, reviewer] of ["reviewer-one@example.com", "reviewer-two@example.com"].entries()) {
    const id = baseId + i;
    peerReviewIds.push(id);
    await pool.query(
      `insert into peer_review (id, conference_id, submission_id, originality_score, relevance_score, technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status, remarks, reviewer, review_status)
       values ($1,$2,$3,3,3,3,3,3,3,'Accept',$4,$5,'Completed')`,
      [id, conferenceId, submissionId, `remarks from ${reviewer}`, reviewer]
    );
  }

  const dashboardHtml = await (await get(`/meta-reviewer/dashboard/${conferenceId}`)).text();
  assert.equal(
    (dashboardHtml.match(new RegExp(`/meta-reviewer/dashboard/recommendation-submission/${submissionId}`, "g")) || []).length,
    1,
    "a submission reviewed by two reviewers must appear only once on the dashboard"
  );
  assert.ok(dashboardHtml.includes("Dedup Submission"), "the dashboard row should show the submission title");
  assert.match(dashboardHtml, />\s*2\s*</, "the dashboard row should show the review count (2)");

  const formHtml = await (await get(`/meta-reviewer/dashboard/recommendation-submission/${submissionId}`)).text();
  assert.ok(formHtml.includes("remarks from reviewer-one@example.com"), "the first review's remarks must be present");
  assert.ok(formHtml.includes("remarks from reviewer-two@example.com"), "the second review's remarks must also be present");

  // Both reviews must render INSIDE the single <table>...</table> block,
  // not with the table closed after the first row and the rest left as
  // bare text underneath it.
  const tableOpen = formHtml.indexOf("<table");
  const tableClose = formHtml.indexOf("</table>");
  const secondReviewIndex = formHtml.indexOf("remarks from reviewer-two@example.com");
  assert.ok(tableOpen !== -1 && tableClose !== -1, "the form must render a table");
  assert.ok(
    secondReviewIndex > tableOpen && secondReviewIndex < tableClose,
    "the second reviewer's remarks must be inside the table, not rendered as bare text after </table>"
  );
  assert.equal((formHtml.match(/<\/table>/g) || []).length, 1, "there must be exactly one closing </table> tag");
});
