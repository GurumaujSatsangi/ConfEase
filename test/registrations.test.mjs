// Regression tests for the chair-side Registrations dashboard:
// GET /chair/dashboard/registrations/:id and its Excel export at
// GET /chair/dashboard/registrations/:id/export.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import ExcelJS from "exceljs";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const chairEmail = "registrations-test-chair@example.com";
const authorAEmail = "registrations-test-author-a@example.com";
const authorBEmail = "registrations-test-author-b@example.com";

const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Registrations Test Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { redirect: "manual", headers: { Authorization: `Bearer ${token}` } });

let conferenceId;
let otherChairConferenceId;
let registeredSubmissionId;
let unregisteredSubmissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["REGISTRATIONS_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["Author A", authorAEmail]);
  await pool.query("insert into users (name, email, password) values ($1,$2,'x') on conflict (email) do nothing", ["Author B", authorBEmail]);

  const registered = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Registered Oral Paper','RGA1',101,'Submitted Final Camera Ready Paper for Oral Presentation') returning submission_id",
    [conferenceId, authorAEmail]
  );
  registeredSubmissionId = registered.rows[0].submission_id;

  const unregistered = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Unregistered Poster Paper','RGA2',102,'Submitted Final Camera Ready Paper for Poster Presentation') returning submission_id",
    [conferenceId, authorBEmail]
  );
  unregisteredSubmissionId = unregistered.rows[0].submission_id;

  // Accepted but not yet at the final-camera-ready stage - should count
  // toward "accepted" but not toward "final camera ready submitted", and
  // must not appear in the row list.
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Accepted Not Yet FCRP','RGA3',103,'Accepted for Oral Presentation')",
    [conferenceId, authorAEmail]
  );

  // Already scored - should still count as "accepted" and "final camera
  // ready submitted" (lineage), but must not appear in the row list (the
  // list is scoped strictly to the two FCRP statuses).
  await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Already Scored','RGA4',104,'Poster Scored')",
    [conferenceId, authorBEmail]
  );

  await pool.query(
    "insert into registration (conference_id, submission_id, mode_of_presentation, link_to_video, attending_offline) values ($1,$2,'Online','https://video.example.com/registered',2)",
    [conferenceId, registeredSubmissionId]
  );
});

after(async () => {
  for (const id of [conferenceId, otherChairConferenceId].filter(Boolean)) {
    await pool.query("delete from registration where conference_id = $1", [id]);
    await pool.query("delete from submissions where conference_id = $1", [id]);
    await pool.query("delete from conferences where conference_id = $1", [id]);
  }
  await pool.query("delete from users where email = ANY($1)", [[authorAEmail, authorBEmail]]);
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a non-owning chair is redirected away from another conference's registrations page", async () => {
  const otherChairToken = jwt.sign({ typ: "chair", email: "registrations-other-chair@example.com", name: "Other Chair", user_id: 2, role: "chair" }, secret, { expiresIn: "5m" });
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["REGISTRATIONS_TEST_OTHER_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  otherChairConferenceId = conf.rows[0].conference_id;

  const res = await get(`/chair/dashboard/registrations/${otherChairConferenceId}`, otherChairToken);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /not authorized/);
});

test("the dashboard lists the full final-camera-ready lineage, and reports correct counters", async () => {
  const res = await get(`/chair/dashboard/registrations/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Row scoping: both FCRP submissions appear, and so does the one that's
  // since been scored (still registered, just further along) - only the
  // one that was merely accepted and never reached FCRP is excluded.
  assert.match(html, /Registered Oral Paper/);
  assert.match(html, /Unregistered Poster Paper/);
  assert.match(html, /Already Scored/);
  assert.doesNotMatch(html, /Accepted Not Yet FCRP/);

  // Counters: accepted = 4 (both FCRP + the Accepted-only one + the
  // Poster Scored one), fcrpSubmitted = 3 (both FCRP + Poster Scored),
  // registered = 1, online = 1, offline = 0.
  assert.match(html, /4\s*\/\s*3/);
  assert.match(html, /1\s*\/\s*3/);
  assert.match(html, /1\s*\/\s*0/);

  assert.match(html, /Registered</);
  assert.match(html, /Not Registered</);
});

test("the Excel export returns an .xlsx file with one row per final-camera-ready-lineage submission", async () => {
  const res = await get(`/chair/dashboard/registrations/${conferenceId}/export`, chairToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(res.headers.get("content-disposition") || "", /attachment/);

  const buffer = Buffer.from(await res.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Registrations");

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    rows.push(row.values);
  });

  // The two FCRP submissions plus the already-scored one (still in the
  // lineage); the merely-accepted one is excluded.
  assert.equal(rows.length, 3);
  const registeredRow = rows.find((r) => r[1] === "0101");
  const unregisteredRow = rows.find((r) => r[1] === "0102");
  const scoredRow = rows.find((r) => r[1] === "0104");
  assert.ok(registeredRow, "registered submission's row must be present");
  assert.ok(unregisteredRow, "unregistered submission's row must be present");
  assert.ok(scoredRow, "already-scored submission's row must still be present");
  assert.equal(registeredRow[6], "Registered");
  assert.equal(unregisteredRow[6], "Not Registered");
  assert.equal(scoredRow[6], "Not Registered");
});
