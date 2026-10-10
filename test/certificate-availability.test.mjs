// Regression test for the "Download Certificate" display on the conference
// page's My Submissions table: once a submission's status is 'Poster
// Scored', the action cell shows a Download Certificate button only if
// there's a certificates row for that submission_id with status
// 'GENERATED'; otherwise it shows "Not Yet Generated". Uses the real route
// and the real local Postgres database.

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
const authorEmail = "cert-test-author@example.com";
const token = jwt.sign({ typ: "access", email: authorEmail, name: "Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

let conferenceId;
after(async () => {
  if (conferenceId) {
    await pool.query("delete from certificates where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("conference page shows Download Certificate only when a GENERATED certificate row exists, else 'Not Yet Generated'", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["CERT_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  const generated = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Generated','CERTA','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );
  const pending = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'Pending','CERTB','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );
  const noRowAtAll = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'NoCertRow','CERTC','Poster Scored') returning submission_id",
    [conferenceId, authorEmail]
  );
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status) values ($1,$2,'NotScoredYet','CERTD','DESK ACCEPT')",
    [conferenceId, authorEmail]
  );

  await pool.query("insert into certificates (conference_id, submission_id, status) values ($1,$2,'GENERATED')", [conferenceId, generated.rows[0].submission_id]);
  await pool.query("insert into certificates (conference_id, submission_id, status) values ($1,$2,'PENDING')", [conferenceId, pending.rows[0].submission_id]);
  // noRowAtAll intentionally has no certificates row at all.

  const html = await (await get(`/conference/${conferenceId}`)).text();

  assert.ok(html.includes(`/submission/download-certificate/${generated.rows[0].submission_id}`), "the GENERATED submission must get a download link");
  assert.equal((html.match(/Download Certificate<\/a>/g) || []).length, 1, "only the GENERATED one gets a button");
  assert.equal((html.match(/Not Yet Generated/g) || []).length, 2, "the PENDING-status row and the no-row-at-all row both show the placeholder");
  assert.ok(html.includes("Edit Submission"), "the still-pending (non-Poster-Scored) submission keeps its normal actions");
});
