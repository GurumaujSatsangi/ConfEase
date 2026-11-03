// Regression test: the "Area" dropdown on the paper-submission and
// invited-talk-submission forms (GET /submission/primary-author/:id,
// GET /submission/invited-talk/:id) used to list every subject area
// (conference_tracks row) in the conference as a flat, unlabeled list -
// with no indication of which Track/group each one belonged to, and no
// ORDER BY at all. Since the same subject-area name is only blocked
// *within* one Track (see the chair-side duplicate-name check: "group_id
// is not distinct from $3"), two different Tracks can legitimately each
// have a subject area with the same name, and an author had no way to
// tell them apart in the dropdown.
//
// Fixed on the frontend only - the submitted value is still the subject
// area's own track_id (unique regardless of Track), nothing about what
// gets stored changed. The dropdown label now reads "Track Name: Subject
// Area Name" (falling back to just the subject area name for one with no
// Track/group), grouped and sorted by Track name.

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
// Two separate identities: GET /submission/primary-author/:id explicitly
// redirects an invitee away ("Invited Speakers are not allowed to submit
// papers"), so the same email can't be used for both forms in this test.
const authorEmail = "track-label-test-author@example.com";
const inviteeEmail = "track-label-test-invitee@example.com";
const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const inviteeToken = jwt.sign({ typ: "access", email: inviteeEmail, name: "Invitee", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

let conferenceId;
after(async () => {
  if (conferenceId) {
    await pool.query("delete from invitees where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_tracks where conference_id = $1", [conferenceId]);
    await pool.query("delete from conference_groups where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

function extractOptionLabels(html) {
  return [...html.matchAll(/<option value="[^"]*">\s*([^<]+?)\s*<\/option>/g)].map((m) => m[1].trim());
}

test("the paper-submission and invited-talk-submission Area dropdowns label each option with its Track name, disambiguating same-named subject areas across different Tracks", async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by, full_paper_submission) values ($1,$2,'2099-01-01') returning conference_id",
    ["TRACK_LABEL_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  const g1 = await pool.query("insert into conference_groups (conference_id, group_name) values ($1,'Track 1') returning group_id", [conferenceId]);
  const g2 = await pool.query("insert into conference_groups (conference_id, group_name) values ($1,'Track 2') returning group_id", [conferenceId]);

  // Same subject-area name ("Machine Learning") deliberately repeated
  // across two different Tracks - this is the exact scenario the fix
  // addresses, and it's explicitly allowed (duplicate-name checks are
  // scoped per-Track, not per-conference).
  await pool.query("insert into conference_tracks (conference_id, group_id, track_name) values ($1,$2,'Machine Learning')", [conferenceId, g1.rows[0].group_id]);
  await pool.query("insert into conference_tracks (conference_id, group_id, track_name) values ($1,$2,'Computer Vision')", [conferenceId, g1.rows[0].group_id]);
  await pool.query("insert into conference_tracks (conference_id, group_id, track_name) values ($1,$2,'Machine Learning')", [conferenceId, g2.rows[0].group_id]);
  // A subject area with no Track/group at all ("directly under the
  // conference") must show with no prefix, not "null: General".
  await pool.query("insert into conference_tracks (conference_id, group_id, track_name) values ($1,NULL,'General')", [conferenceId]);

  // GET /submission/invited-talk/:id requires an invitees row for this
  // email/conference, or it redirects away before ever rendering the
  // dropdown.
  await pool.query("insert into invitees (conference_id, email, name) values ($1,$2,$3)", [conferenceId, inviteeEmail, "Invitee"]);

  let renderedCount = 0;
  for (const [path, token] of [
    [`/submission/primary-author/${conferenceId}`, authorToken],
    [`/submission/invited-talk/${conferenceId}`, inviteeToken],
  ]) {
    const res = await get(path, token);
    assert.equal(res.status, 200, `${path} must render the form, not redirect`);
    renderedCount++;
    const html = await res.text();
    const options = extractOptionLabels(html);

    assert.ok(options.includes("Track 1: Machine Learning"), `${path}: expected "Track 1: Machine Learning" in ${JSON.stringify(options)}`);
    assert.ok(options.includes("Track 2: Machine Learning"), `${path}: expected "Track 2: Machine Learning" in ${JSON.stringify(options)}`);
    assert.ok(options.includes("Track 1: Computer Vision"), `${path}: expected "Track 1: Computer Vision" in ${JSON.stringify(options)}`);
    assert.ok(options.includes("General"), `${path}: an ungrouped subject area must show with no Track prefix, got ${JSON.stringify(options)}`);
    assert.ok(!options.some((o) => o.startsWith("null:")), `${path}: an ungrouped subject area must never show a literal "null:" prefix`);
  }
  assert.equal(renderedCount, 2, "both forms must have actually rendered and been checked");
});
