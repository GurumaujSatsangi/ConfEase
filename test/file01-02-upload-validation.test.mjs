// Regression tests for FILE-01 and FILE-02
// (security-audit/COMPLETE_FINDINGS_REGISTER.md):
//
// FILE-01: multer previously had no fileFilter, so any mimetype/extension
// was buffered into memory (up to the 4MB cap) before the app's own
// magic-byte check (isAllowedDocument) ran. A fileFilter now rejects
// disallowed extensions at the multer layer itself, before buffering.
//
// FILE-02: the .docx branch of isAllowedDocument only checked the generic
// "PK" ZIP signature, true of any ZIP archive, not specifically an Office
// document. It now also requires the literal "[Content_Types].xml" ZIP
// entry name that every real docx/xlsx/pptx stores.
//
// Both tests below use POST /submit and deliberately stop short of a real
// upload: a rejected file (wrong extension, or wrong content) never
// reaches the Cloudinary call later in that route, so these tests invoke
// no external service, matching the project's testing conventions.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const authorEmail = "file0102-test-author@example.com";
const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "FILE0102 Test Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

let conferenceId;
let trackId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, full_paper_submission) values ($1,$2,$3) returning conference_id",
    ["FILE0102_TEST_" + crypto.randomBytes(3).toString("hex"), "file0102-test-chair@example.com", "2099-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query("insert into conference_tracks (conference_id, track_name) values ($1,'FILE0102 Track') returning track_id", [conferenceId]);
  trackId = track.rows[0].track_id;
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

const submitWithFile = (fileBytes, filename, extraFields = {}) => {
  const form = new FormData();
  form.append("title", "FILE0102 Test Paper");
  form.append("abstract", "An abstract.");
  form.append("areas", String(trackId));
  form.append("id", String(conferenceId));
  for (const [key, value] of Object.entries(extraFields)) form.append(key, value);
  form.append("file", new Blob([fileBytes]), filename);

  return fetch(base + "/submit", {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${authorToken}` },
    body: form,
  });
};

test("FILE-01: a disallowed file extension is rejected by multer's fileFilter before any buffering/processing", async () => {
  const res = await submitWithFile(Buffer.from("just some plain text, not a document"), "notes.txt");
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /Only PDF, DOC, and DOCX files are allowed/, `expected the fileFilter's rejection message, got redirect to: ${location}`);
});

test("FILE-02: a .docx-named file that is a ZIP but not actually an OOXML document is rejected by the content check", async () => {
  // Generic ZIP local-file-header signature ("PK\x03\x04") followed by
  // arbitrary bytes - passes the old "starts with PK" check, but contains
  // no "[Content_Types].xml" entry, so it isn't a real Office document.
  const fakeZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not an office document, just zip-flavored bytes")]);
  const res = await submitWithFile(fakeZip, "paper.docx");
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /Only PDF, DOC and DOCX files are allowed/, `expected isAllowedDocument's rejection message, got redirect to: ${location}`);
});
