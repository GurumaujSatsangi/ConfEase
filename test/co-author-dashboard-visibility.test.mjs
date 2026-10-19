// A co-author was never shown their co-authored submissions on
// /conference/:id's My Submissions table (it only queried by
// primary_author) - fixed by also matching submissions where the user's
// email is in co_authors, and tagging each row with isPrimaryAuthor so the
// template and the mutating routes below can tell the two apart. Only
// viewing is shared; editing, deleting, submitting the camera-ready paper,
// and registering stay primary-author-only, both in the UI and server-side.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { createClient } from "redis";

// Deliberately not VERCEL=1 (that also skips api/index.js's own Redis
// connection) - the stale-cache regression test below needs the route's
// real cache-read path to run, not a bypassed one.
process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const redisProbe = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, connectTimeout: 5000 },
});
redisProbe.on("error", () => {});
let redisAvailable = false;
try {
  await redisProbe.connect();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
function submissionsCacheKey(email, conferenceId) {
  return `${String(email || "").trim().toLowerCase()}_submissions_conference_${conferenceId}`;
}

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const primaryEmail = "coauthor-dash-test-primary@example.com";
const coAuthorEmail = "coauthor-dash-test-coauthor@example.com";

const primaryToken = jwt.sign({ typ: "access", email: primaryEmail, name: "Primary", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const coAuthorToken = jwt.sign({ typ: "access", email: coAuthorEmail, name: "Co-Author", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });
const post = (path, token, body) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body || {}),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId;
let underReviewSubmissionId;
let fcrpOralSubmissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["COAUTHOR_DASH_TEST_" + crypto.randomBytes(3).toString("hex"), "coauthor-dash-test-chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  const underReview = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, co_authors) values ($1,$2,'Co-Author Dash Paper','CAD01',301,'Submitted for Review',ARRAY[$3]) returning submission_id",
    [conferenceId, primaryEmail, coAuthorEmail]
  );
  underReviewSubmissionId = underReview.rows[0].submission_id;

  const fcrpOral = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, co_authors) values ($1,$2,'Co-Author Dash FCRP Oral','CAD02',302,'Submitted Final Camera Ready Paper for Oral Presentation',ARRAY[$3]) returning submission_id",
    [conferenceId, primaryEmail, coAuthorEmail]
  );
  fcrpOralSubmissionId = fcrpOral.rows[0].submission_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from registration where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  if (redisAvailable) await redisProbe.quit();
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a stale cache entry predating isPrimaryAuthor does not hide Edit/Delete/Co-Author Requests from the real primary author", { skip: !redisAvailable && "Redis is not reachable in this environment" }, async () => {
  // Seeds the exact shape a pre-this-fix cache write would have left behind:
  // raw submission rows with no isPrimaryAuthor field at all. The route must
  // recompute isPrimaryAuthor itself instead of trusting whatever's cached,
  // or this looks identical to every row being someone else's co-authored
  // submission.
  const staleRow = (await pool.query("select * from submissions where submission_id = $1", [underReviewSubmissionId])).rows[0];
  await redisProbe.set(submissionsCacheKey(primaryEmail, conferenceId), JSON.stringify([staleRow]), { EX: 300 });

  const html = await (await get(`/conference/${conferenceId}`, primaryToken)).text();
  assert.match(html, /Edit Submission/, "a stale cache entry must not hide the edit link from the real primary author");
  assert.match(html, /Delete Submission/);
  assert.match(html, /Co-Author Requests/);

  await redisProbe.del(submissionsCacheKey(primaryEmail, conferenceId));
});

test("a co-author sees the submission on their own dashboard", async () => {
  const html = await (await get(`/conference/${conferenceId}`, coAuthorToken)).text();
  assert.match(html, /Co-Author Dash Paper/);
  assert.match(html, /0301/);
});

test("the Co-Authors/Primary Author column shows the primary author's email to a co-author, and the co-authors list to the primary author", async () => {
  const coAuthorHtml = await (await get(`/conference/${conferenceId}`, coAuthorToken)).text();
  assert.match(coAuthorHtml, new RegExp(primaryEmail.replace(/[.+]/g, "\\$&")), "a co-author must see the primary author's email in that column");

  const primaryHtml = await (await get(`/conference/${conferenceId}`, primaryToken)).text();
  assert.match(primaryHtml, new RegExp(`data-bs-content="[^"]*${coAuthorEmail.replace(/[.+]/g, "\\$&")}`), "the primary author must see the co-author's email in the co-authors popover");
});

test("a co-author does not see Edit/Delete/Co-Author Requests for a Submitted for Review paper", async () => {
  const html = await (await get(`/conference/${conferenceId}`, coAuthorToken)).text();
  assert.ok(!html.includes("Edit Submission"), "co-author must not see an edit link");
  assert.ok(!html.includes("Delete Submission"), "co-author must not see a delete link");
  assert.ok(!html.includes("Co-Author Requests"), "co-author must not see the co-author requests management link");
});

test("the primary author still sees Edit/Delete/Co-Author Requests for their own submission", async () => {
  const html = await (await get(`/conference/${conferenceId}`, primaryToken)).text();
  assert.match(html, /Edit Submission/);
  assert.match(html, /Delete Submission/);
  assert.match(html, /Co-Author Requests/);
});

test("a co-author sees a note instead of a Register button for an FCRP submission", async () => {
  const html = await (await get(`/conference/${conferenceId}`, coAuthorToken)).text();
  assert.ok(!html.includes(">Register<"), "co-author must not see a Register button");
  assert.match(html, /Only the primary author can register this submission/);
});

test("the primary author still sees the Register button for their own FCRP submission", async () => {
  const html = await (await get(`/conference/${conferenceId}`, primaryToken)).text();
  assert.match(html, />Register</);
});

test("GET /submission/edit/primary-author/:id blocks the co-author", async () => {
  const res = await get(`/submission/edit/primary-author/${underReviewSubmissionId}`, coAuthorToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /Only the primary author can edit this submission/);
});

test("POST /submission/delete/primary-author/:id blocks the co-author", async () => {
  const res = await post(`/submission/delete/primary-author/${underReviewSubmissionId}`, coAuthorToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /not authorized to delete/);
  const stillThere = await pool.query("select 1 from submissions where submission_id = $1", [underReviewSubmissionId]);
  assert.equal(stillThere.rows.length, 1, "the co-author's request must not have deleted the submission");
});

test("GET /submission/final-camera-ready/primary-author/:id blocks the co-author", async () => {
  const accepted = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status, co_authors) values ($1,$2,'Co-Author Dash Accepted','CAD03',303,'Accepted for Oral Presentation',ARRAY[$3]) returning submission_id",
    [conferenceId, primaryEmail, coAuthorEmail]
  );
  const res = await get(`/submission/final-camera-ready/primary-author/${accepted.rows[0].submission_id}`, coAuthorToken);
  assert.equal(res.status, 302);
  assert.match(loc(res), /Only the primary author can submit the camera-ready paper/);
});

test("GET and POST /submission/register/:id block the co-author", async () => {
  const getRes = await get(`/submission/register/${fcrpOralSubmissionId}`, coAuthorToken);
  assert.equal(getRes.status, 302);
  assert.match(loc(getRes), /Only the primary author can register this submission/);

  const postRes = await post(`/submission/register/${fcrpOralSubmissionId}`, coAuthorToken, {
    mode_of_presentation: "Online",
    attending_offline: "0",
    link_to_video: "https://drive.google.com/file/d/coauthor-attempt",
  });
  assert.equal(postRes.status, 302);
  assert.match(loc(postRes), /Only the primary author can register this submission/);

  const row = await pool.query("select 1 from registration where submission_id = $1", [fcrpOralSubmissionId]);
  assert.equal(row.rows.length, 0, "the co-author's attempt must not have created a registration row");
});

test("the primary author can still register normally", async () => {
  const res = await get(`/submission/register/${fcrpOralSubmissionId}`, primaryToken);
  assert.equal(res.status, 200);
});
