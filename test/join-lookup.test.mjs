// Regression tests for GET /join/lookup: looks up a submission by paper
// code (title + primary author name/email) before the actual join
// request, so the "Join a Paper" page (views/submission2.ejs) can show a
// SweetAlert confirmation naming the real paper and author, instead of a
// co-author request firing (and emailing a stranger) off a typo'd code.
// Deliberately does NOT duplicate POST /join's own eligibility checks
// (already a co-author, wrong status, etc.) - this route only answers
// "does a submission with this code exist in this conference, and what
// is it", the same first check POST /join itself does.

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
const coAuthorEmail = "join-lookup-test-coauthor@example.com";
const primaryEmail = "join-lookup-test-primary@example.com";
const token = jwt.sign({ typ: "access", email: coAuthorEmail, name: "CoAuthor", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, auth = true) =>
  fetch(base + path, { headers: auth ? { Authorization: `Bearer ${token}` } : {}, redirect: "manual" });

let conferenceId;
after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  await pool.query("delete from users where email = $1", [primaryEmail]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("setup: seed a conference, a primary author, and a submission", async () => {
  await pool.query(
    "insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing",
    ["Primary Author Name", primaryEmail]
  );
  const conf = await pool.query(
    "insert into conferences (title, created_by, full_paper_submission) values ($1,$2,'2099-01-01') returning conference_id",
    ["JOIN_LOOKUP_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'A Great Paper','JLT1',1,'Submitted for Review')",
    [conferenceId, primaryEmail]
  );
});

test("a valid paper code returns the real title and primary author's name/email", async () => {
  const res = await get(`/join/lookup?paper_code=JLT1&id=${conferenceId}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, {
    ok: true,
    title: "A Great Paper",
    primaryAuthorName: "Primary Author Name",
    primaryAuthorEmail: primaryEmail,
  });
});

test("an unknown paper code in this conference returns a clear 404", async () => {
  const res = await get(`/join/lookup?paper_code=NOPE&id=${conferenceId}`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.message, /Invalid Paper Code/);
});

test("a real paper code from a DIFFERENT conference is not found (conference-scoped)", async () => {
  const otherConf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["JOIN_LOOKUP_OTHER_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  const res = await get(`/join/lookup?paper_code=JLT1&id=${otherConf.rows[0].conference_id}`);
  assert.equal(res.status, 404);
  await pool.query("delete from conferences where conference_id = $1", [otherConf.rows[0].conference_id]);
});

test("missing paper_code or id is rejected with 400, not a server error", async () => {
  const res1 = await get(`/join/lookup?id=${conferenceId}`);
  assert.equal(res1.status, 400);
  const res2 = await get(`/join/lookup?paper_code=JLT1`);
  assert.equal(res2.status, 400);
});

test("an unauthenticated request is redirected, not allowed to look up submissions", async () => {
  const res = await get(`/join/lookup?paper_code=JLT1&id=${conferenceId}`, false);
  assert.equal(res.status, 302);
});

test("the Join a Paper page renders the confirm-before-submit script and form wiring", async () => {
  const res = await get(`/submission/co-author/${conferenceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="joinPaperForm"/);
  assert.match(html, /\/join\/lookup/);
  assert.match(html, /escapeHtmlForAlert/, "server-supplied title/name/email must be escaped before going into SweetAlert's html option");
});
