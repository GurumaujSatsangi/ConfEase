// Regression tests for POST /submit-invited-talk's new field requirements:
// profile_photo is now required, while the subject area (areas) and the
// paper (file) are both optional - previously the reverse (paper
// required, profile_photo didn't exist, areas required).
//
// Like file01-02-upload-validation.test.mjs, these deliberately stop
// short of a real Cloudinary upload - a rejected/invalid request never
// reaches that call. To prove areas/file are genuinely optional without
// needing a real upload to actually succeed, the last two tests send a
// profile photo with the right extension but deliberately wrong magic
// bytes: that only gets rejected at the image-content check, which runs
// *after* the required-fields and areas/file handling - so reaching that
// specific error proves the missing areas/file never blocked the request
// earlier, without this suite needing real Cloudinary credentials to
// succeed.

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
const inviteeEmail = "invited-talk-photo-test@example.com";
const inviteeToken = jwt.sign({ typ: "access", email: inviteeEmail, name: "Invited Talk Photo Test", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });

let conferenceId;
let trackId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, full_paper_submission) values ($1,$2,$3) returning conference_id",
    ["INVITED_PHOTO_TEST_" + crypto.randomBytes(3).toString("hex"), "invited-photo-test-chair@example.com", "2099-01-01"]
  );
  conferenceId = conf.rows[0].conference_id;

  const track = await pool.query("insert into conference_tracks (conference_id, track_name) values ($1,'Invited Photo Track') returning track_id", [conferenceId]);
  trackId = track.rows[0].track_id;

  await pool.query("insert into invitees (conference_id, email, name) values ($1,$2,'Invited Talk Photo Test')", [conferenceId, inviteeEmail]);
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from invited_talk_submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from invitees where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

function buildForm({ title = "A Talk", abstract = "An abstract.", areas, profilePhoto, paper } = {}) {
  const form = new FormData();
  form.append("conference_id", String(conferenceId));
  if (title !== null) form.append("title", title);
  if (abstract !== null) form.append("abstract", abstract);
  if (areas !== undefined) form.append("areas", areas);
  if (profilePhoto) form.append("profile_photo", new Blob([profilePhoto.bytes]), profilePhoto.filename);
  if (paper) form.append("file", new Blob([paper.bytes]), paper.filename);
  return form;
}

const post = (form) =>
  fetch(base + "/submit-invited-talk", {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${inviteeToken}` },
    body: form,
  });

test("no profile photo at all is rejected before any file is checked", async () => {
  const res = await post(buildForm());
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /A profile photo is required/);
});

test("a profile photo with a disallowed extension is rejected by multer's fileFilter", async () => {
  const res = await post(
    buildForm({ profilePhoto: { bytes: Buffer.from("not an image"), filename: "photo.txt" } })
  );
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /Only JPG, JPEG, PNG, and WEBP images are allowed/);
});

test("missing title/abstract is still rejected even with a profile photo attached", async () => {
  const res = await post(
    buildForm({ title: null, profilePhoto: { bytes: Buffer.from("irrelevant"), filename: "photo.png" } })
  );
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(location, /Title and Abstract are required/);
});

test("no subject area and no paper are both accepted - the request reaches the image-content check, not an area/paper requirement", async () => {
  const res = await post(
    buildForm({
      areas: "", // deliberately omitted - must not be treated as required
      profilePhoto: { bytes: Buffer.from("deliberately wrong content for a .png"), filename: "photo.png" },
      // no paper attached
    })
  );
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  assert.match(
    location,
    /Only JPG, JPEG, PNG, and WEBP images are allowed for the profile photo/,
    "reaching the image-content check (not an area/paper error) proves the missing subject area and paper never blocked the request"
  );
});

test("a paper with a disallowed extension is rejected even though the paper itself is optional", async () => {
  const res = await post(
    buildForm({
      profilePhoto: { bytes: Buffer.from("deliberately wrong content for a .png"), filename: "photo.png" },
      paper: { bytes: Buffer.from("not a real document"), filename: "paper.txt" },
    })
  );
  assert.equal(res.status, 302);
  const location = decodeURIComponent(res.headers.get("location") || "");
  // multer's own fileFilter rejects the .txt paper before either file's
  // content is checked - this is the same "file" field extension
  // allow-list every other document upload in this app already uses.
  assert.match(location, /Only PDF, DOC, and DOCX files are allowed/);
});
