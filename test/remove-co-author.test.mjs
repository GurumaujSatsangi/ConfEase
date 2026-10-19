// Regression tests for POST /remove-co-author/:submission_id/:co_author
// (views/co-author-requests.ejs's "Remove Co-Author" button, which posted
// to this route already but the route itself didn't exist). Covers
// authorization (primary-author-only), that co_authors is actually
// updated, and that the co_author_requests row is deleted rather than left
// behind - uniq_co_author_requests_pending (migration 014) is a partial
// unique index on (submission_id, co_author) WHERE status != 'Rejected',
// so a stale 'Accepted' row would silently block that person from ever
// sending a new join request for this paper again.

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
const primaryEmail = "remove-coauthor-test-primary@example.com";
const coAuthorEmail = "remove-coauthor-test-coauthor@example.com";
const strangerEmail = "remove-coauthor-test-stranger@example.com";

const primaryToken = jwt.sign({ typ: "access", email: primaryEmail, name: "Primary", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const strangerToken = jwt.sign({ typ: "access", email: strangerEmail, name: "Stranger", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });
const post = (path, token) => fetch(base + path, { method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${token}` } });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

const createdConferences = [];
async function createAcceptedCoAuthorSubmission() {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["REMOVE_COAUTHOR_TEST_" + crypto.randomBytes(3).toString("hex"), "remove-coauthor-test-chair@example.com"]
  );
  const conferenceId = conf.rows[0].conference_id;
  createdConferences.push(conferenceId);

  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, co_authors) values ($1,$2,'Remove Co-Author Test Paper',$3,401,'Submitted for Review',ARRAY[$4]) returning submission_id",
    [conferenceId, primaryEmail, "RCA" + crypto.randomBytes(3).toString("hex"), coAuthorEmail]
  );
  const submissionId = sub.rows[0].submission_id;

  await pool.query(
    "insert into co_author_requests (conference_id, submission_id, primary_author, co_author, status) values ($1,$2,$3,$4,'Accepted')",
    [conferenceId, submissionId, primaryEmail, coAuthorEmail]
  );

  return { conferenceId, submissionId };
}

after(async () => {
  for (const id of createdConferences) {
    await pool.query("delete from co_author_requests where conference_id = $1", [id]);
    await pool.query("delete from submissions where conference_id = $1", [id]);
    await pool.query("delete from conferences where conference_id = $1", [id]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a non-primary-author cannot remove a co-author", async () => {
  const { submissionId } = await createAcceptedCoAuthorSubmission();
  const res = await post(`/remove-co-author/${submissionId}/${encodeURIComponent(coAuthorEmail)}`, strangerToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized to remove co-authors/);

  const row = await pool.query("select co_authors from submissions where submission_id = $1", [submissionId]);
  assert.ok(row.rows[0].co_authors.includes(coAuthorEmail), "the co-author must not have been removed");
});

test("the primary author can remove a co-author, and the co_author_requests row is deleted (not just flipped)", async () => {
  const { conferenceId, submissionId } = await createAcceptedCoAuthorSubmission();

  const res = await post(`/remove-co-author/${submissionId}/${encodeURIComponent(coAuthorEmail)}`, primaryToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /Co-author removed successfully/);

  const submissionRow = await pool.query("select co_authors from submissions where submission_id = $1", [submissionId]);
  assert.ok(!submissionRow.rows[0].co_authors.includes(coAuthorEmail), "the co-author must be removed from co_authors");

  const requestRow = await pool.query("select 1 from co_author_requests where submission_id = $1 and co_author = $2", [submissionId, coAuthorEmail]);
  assert.equal(requestRow.rows.length, 0, "the old co_author_requests row must be deleted, not left as a stale 'Accepted' row");

  // The removed co-author must no longer see this submission on their dashboard.
  const coAuthorToken = jwt.sign({ typ: "access", email: coAuthorEmail, name: "Co-Author", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });
  const dashHtml = await (await get(`/conference/${conferenceId}`, coAuthorToken)).text();
  assert.ok(!dashHtml.includes("Remove Co-Author Test Paper"), "a removed co-author must no longer see the submission");
});

test("after removal, the former co-author can send a fresh join request (not blocked by a stale Accepted row)", async () => {
  const { submissionId } = await createAcceptedCoAuthorSubmission();
  await post(`/remove-co-author/${submissionId}/${encodeURIComponent(coAuthorEmail)}`, primaryToken);

  const submissionRow = await pool.query("select paper_code, conference_id from submissions where submission_id = $1", [submissionId]);
  const coAuthorToken = jwt.sign({ typ: "access", email: coAuthorEmail, name: "Co-Author", user_id: 4, role: "user", roles: {} }, secret, { expiresIn: "5m" });

  const joinRes = await fetch(base + "/join", {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${coAuthorToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ paper_code: submissionRow.rows[0].paper_code, id: submissionRow.rows[0].conference_id }),
  });
  assert.match(loc(joinRes), /Co-author request submitted successfully/, "a fresh join request must succeed after removal");
});
