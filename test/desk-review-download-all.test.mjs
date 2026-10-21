// Regression tests for GET /chair/dashboard/desk/download-all/:id, the new
// "Download All Submissions (.zip)" button on the desk review page. Covers
// what can be verified without hitting Cloudinary for a real file (this
// suite never downloads real files elsewhere either - see
// file04-private-papers.test.mjs's own noPublicIdSubmissionId fixture for
// the same pattern): authorization, the "nothing to download" empty state,
// and that a submission with no file_public_id (getSignedPaperUrl returns
// null for it) is skipped rather than crashing the whole archive, still
// producing a structurally valid (if effectively empty) zip.
// Uses the real route and the real local Postgres database.

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
const chairEmail = "desk-zip-chair@example.com";
const otherChairEmail = "desk-zip-other@example.com";
const chairToken = jwt.sign({ typ: "chair", email: chairEmail, name: "Desk Zip Chair", user_id: 1, role: "chair" }, secret, { expiresIn: "5m" });
const otherChairToken = jwt.sign({ typ: "chair", email: otherChairEmail, name: "Other Chair", user_id: 2, role: "chair" }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

let conferenceId;
let emptyConferenceId;
let submissionId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["DESK_ZIP_TEST_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  conferenceId = conf.rows[0].conference_id;

  // No file_public_id - getSignedPaperUrl(submission) returns null for it,
  // same as file04-private-papers.test.mjs's own fixture for this case.
  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,'Desk Zip Test Paper','DZ1',901,'Submitted for Review') returning submission_id",
    [conferenceId, "desk-zip-author@example.com"]
  );
  submissionId = sub.rows[0].submission_id;

  const emptyConf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["DESK_ZIP_EMPTY_" + crypto.randomBytes(3).toString("hex"), chairEmail]
  );
  emptyConferenceId = emptyConf.rows[0].conference_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  if (emptyConferenceId) {
    await pool.query("delete from conferences where conference_id = $1", [emptyConferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a chair who does not own this conference is blocked", async () => {
  const res = await get(`/chair/dashboard/desk/download-all/${conferenceId}`, otherChairToken);
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location"));
  assert.match(location, /not authorized/);
});

test("a conference with nothing awaiting desk review redirects back with a message instead of an empty download", async () => {
  const res = await get(`/chair/dashboard/desk/download-all/${emptyConferenceId}`, chairToken);
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location"));
  assert.match(location, /No submissions awaiting desk review to download/);
});

test("the owning chair gets a zip response, and a submission with no uploaded file is skipped rather than crashing it", async () => {
  const res = await get(`/chair/dashboard/desk/download-all/${conferenceId}`, chairToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="desk-review-submissions-/);

  const bytes = Buffer.from(await res.arrayBuffer());
  // A zip file's End Of Central Directory record signature - present even
  // in a structurally valid empty archive (every entry here was skipped
  // for having no file_public_id, so this one has zero files in it).
  assert.ok(bytes.includes(Buffer.from("PK\x05\x06")), "the response body must be a structurally valid zip archive");
});
