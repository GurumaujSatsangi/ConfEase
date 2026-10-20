// Integration tests for the conference registration feature:
// GET/POST /submission/register/:id, and the resulting state on the
// conference page's My Submissions table (disabled "Registered" button +
// accordion once a submission is registered). Uses the real routes and the
// real local Postgres database.

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
const authorEmail = "registration-test-author@example.com";
const token = jwt.sign({ typ: "access", email: authorEmail, name: "Author", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const headers = { Authorization: `Bearer ${token}` };

const get = (path) => fetch(base + path, { headers, redirect: "manual" });
const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

const createdConferences = [];
async function createConferenceWithSubmission(status) {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["REGISTRATION_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  const conferenceId = conf.rows[0].conference_id;
  createdConferences.push(conferenceId);
  const sub = await pool.query(
    "insert into submissions (conference_id, primary_author, title, paper_code, submission_status, paper_number) values ($1,$2,'Registration Test Paper',$3,$4,3) returning submission_id",
    [conferenceId, authorEmail, "REG" + crypto.randomBytes(3).toString("hex"), status]
  );
  return { conferenceId, submissionId: sub.rows[0].submission_id };
}

after(async () => {
  for (const id of createdConferences) {
    await pool.query("delete from registration where conference_id = $1", [id]);
    await pool.query("delete from submissions where conference_id = $1", [id]);
    await pool.query("delete from conferences where conference_id = $1", [id]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("GET /submission/register/:id rejects a submission that isn't at a final-camera-ready status", async () => {
  const { submissionId } = await createConferenceWithSubmission("DESK ACCEPT");
  const res = await get(`/submission/register/${submissionId}`);
  assert.equal(res.status, 302);
  assert.match(loc(res), /Registration is not open for this submission yet/);
});

test("full registration flow: form renders, submits, saves, and then disables itself", async () => {
  const { conferenceId, submissionId } = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Oral Presentation");

  const formRes = await get(`/submission/register/${submissionId}`);
  assert.equal(formRes.status, 200);
  const formHtml = await formRes.text();
  assert.ok(formHtml.includes("Conference Registration"), "page title");
  assert.ok(formHtml.includes("0003"), "paper id shown, zero-padded");
  assert.ok(formHtml.includes('name="mode_of_presentation"'));
  assert.ok(formHtml.includes('name="attending_offline"'));
  assert.ok(formHtml.includes('name="link_to_video"'));
  assert.ok(formHtml.includes("Are you sure you want to submit the entered details?"), "confirmation prompt text");

  const submitRes = await post(`/submission/register/${submissionId}`, {
    mode_of_presentation: "Offline",
    attending_offline: "2",
    link_to_video: "https://drive.google.com/file/d/abc123",
  });
  assert.equal(submitRes.status, 302);
  assert.equal(loc(submitRes), `/conference/${conferenceId}?message=Registration submitted successfully!`);

  const row = (await pool.query("select * from registration where submission_id = $1", [submissionId])).rows[0];
  assert.equal(row.mode_of_presentation, "Offline");
  assert.equal(row.attending_offline, 2);
  assert.equal(row.link_to_video, "https://drive.google.com/file/d/abc123");

  // The route is now disabled for this submission - both GET and POST.
  const getAfter = await get(`/submission/register/${submissionId}`);
  assert.match(loc(getAfter), /already been registered/);

  const postAfter = await post(`/submission/register/${submissionId}`, {
    mode_of_presentation: "Online",
    attending_offline: "0",
    link_to_video: "https://drive.google.com/file/d/xyz",
  });
  assert.match(loc(postAfter), /already been registered/);

  const rowCount = (await pool.query("select count(*) from registration where submission_id = $1", [submissionId])).rows[0].count;
  assert.equal(Number(rowCount), 1, "the duplicate attempt must not create a second row");

  // The conference page reflects the registered state: disabled button + accordion.
  const confHtml = await (await get(`/conference/${conferenceId}`)).text();
  assert.ok(confHtml.includes(">Registered<"), "button should read Registered, not Register");
  assert.ok(confHtml.includes("Mode of Presentation:</strong> Offline"));
  assert.ok(confHtml.includes("Number of Authors attending Offline:</strong> 2"));
  assert.ok(confHtml.includes("https://drive.google.com/file/d/abc123"));
});

test("My Submissions shows the Link for Online Attendees for online poster/oral registrations (from poster_session/conference_tracks respectively), not for offline ones", async () => {
  const onlinePoster = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Poster Presentation");
  await pool.query(
    "insert into poster_session (conference_id, vc_link) values ($1,$2)",
    [onlinePoster.conferenceId, "https://meet.example.com/online-poster-room"]
  );
  await post(`/submission/register/${onlinePoster.submissionId}`, {
    mode_of_presentation: "Online",
    attending_offline: "0",
    link_to_video: "https://drive.google.com/file/d/online-poster",
  });

  const onlineHtml = await (await get(`/conference/${onlinePoster.conferenceId}`)).text();
  assert.ok(onlineHtml.includes("Link for Online Attendees"));
  assert.ok(onlineHtml.includes("https://meet.example.com/online-poster-room"));

  const offlinePoster = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Poster Presentation");
  await pool.query(
    "insert into poster_session (conference_id, vc_link) values ($1,$2)",
    [offlinePoster.conferenceId, "https://meet.example.com/offline-poster-room"]
  );
  await post(`/submission/register/${offlinePoster.submissionId}`, {
    mode_of_presentation: "Offline",
    attending_offline: "1",
    link_to_video: "https://drive.google.com/file/d/offline-poster",
  });
  const offlineHtml = await (await get(`/conference/${offlinePoster.conferenceId}`)).text();
  assert.ok(!offlineHtml.includes("Link for Online Attendees"), "an offline registration must not show the vc_link");

  // An oral submission's "Link for Online Attendees" comes from its own
  // subject area's vc_link (conference_tracks), not poster_session's - the
  // poster_session.vc_link inserted above for this conference must not
  // leak into an oral submission's display.
  const onlineOral = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Oral Presentation");
  await pool.query(
    "insert into poster_session (conference_id, vc_link) values ($1,$2)",
    [onlineOral.conferenceId, "https://meet.example.com/should-not-appear"]
  );
  const oralTrack = await pool.query(
    "insert into conference_tracks (conference_id, track_name, vc_link) values ($1,'Oral VC Link Track','https://meet.example.com/online-oral-room') returning track_id",
    [onlineOral.conferenceId]
  );
  await pool.query("update submissions set track_id = $1 where submission_id = $2", [oralTrack.rows[0].track_id, onlineOral.submissionId]);
  await post(`/submission/register/${onlineOral.submissionId}`, {
    mode_of_presentation: "Online",
    attending_offline: "0",
    link_to_video: "https://drive.google.com/file/d/online-oral",
  });
  const oralHtml = await (await get(`/conference/${onlineOral.conferenceId}`)).text();
  assert.ok(oralHtml.includes("Link for Online Attendees"), "an online oral registration must show its subject area's vc_link");
  assert.ok(oralHtml.includes("https://meet.example.com/online-oral-room"));
  assert.ok(!oralHtml.includes("https://meet.example.com/should-not-appear"), "the poster session's vc_link must not leak into the oral submission's link");

  const offlineOral = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Oral Presentation");
  const offlineOralTrack = await pool.query(
    "insert into conference_tracks (conference_id, track_name, vc_link) values ($1,'Offline Oral Track','https://meet.example.com/not-shown-offline') returning track_id",
    [offlineOral.conferenceId]
  );
  await pool.query("update submissions set track_id = $1 where submission_id = $2", [offlineOralTrack.rows[0].track_id, offlineOral.submissionId]);
  await post(`/submission/register/${offlineOral.submissionId}`, {
    mode_of_presentation: "Offline",
    attending_offline: "2",
    link_to_video: "https://drive.google.com/file/d/offline-oral",
  });
  const offlineOralHtml = await (await get(`/conference/${offlineOral.conferenceId}`)).text();
  assert.ok(!offlineOralHtml.includes("Link for Online Attendees"), "an offline oral registration must not show the vc_link even though the track has one");
});

test("POST rejects an invalid mode of presentation and a missing video link, without writing a row", async () => {
  const { submissionId } = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Poster Presentation");

  const badMode = await post(`/submission/register/${submissionId}`, {
    mode_of_presentation: "Hybrid",
    attending_offline: "1",
    link_to_video: "https://drive.google.com/file/d/abc",
  });
  assert.match(loc(badMode), /valid mode of presentation/);

  const missingVideo = await post(`/submission/register/${submissionId}`, {
    mode_of_presentation: "Online",
    attending_offline: "1",
    link_to_video: "",
  });
  assert.match(loc(missingVideo), /link to your video/);

  const rowCount = (await pool.query("select count(*) from registration where submission_id = $1", [submissionId])).rows[0].count;
  assert.equal(Number(rowCount), 0);
});

// registration_deadline (conferences table) - a chair-configured, optional
// cutoff. Null (the default for any conference that predates this column,
// or where a chair just hasn't set one) must never block registration.
async function setRegistrationDeadline(conferenceId, deadline) {
  await pool.query("update conferences set registration_deadline = $1 where conference_id = $2", [deadline, conferenceId]);
}

test("GET and POST /submission/register/:id are blocked once the conference's registration deadline has passed", async () => {
  const { conferenceId, submissionId } = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Oral Presentation");
  await setRegistrationDeadline(conferenceId, "2000-01-01");

  const getRes = await get(`/submission/register/${submissionId}`);
  assert.equal(getRes.status, 302);
  assert.match(loc(getRes), /registration deadline for this conference has passed/);

  const postRes = await post(`/submission/register/${submissionId}`, {
    mode_of_presentation: "Online",
    attending_offline: "0",
    link_to_video: "https://drive.google.com/file/d/past-deadline",
  });
  assert.match(loc(postRes), /registration deadline for this conference has passed/);

  const row = await pool.query("select 1 from registration where submission_id = $1", [submissionId]);
  assert.equal(row.rows.length, 0, "a past-deadline attempt must not create a registration row");
});

test("registration still works when the deadline is in the future", async () => {
  const { conferenceId, submissionId } = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Oral Presentation");
  await setRegistrationDeadline(conferenceId, "2099-01-01");

  const res = await get(`/submission/register/${submissionId}`);
  assert.equal(res.status, 200);
});

test("registration still works when no deadline has been configured at all (null, the pre-existing default)", async () => {
  const { submissionId } = await createConferenceWithSubmission("Submitted Final Camera Ready Paper for Oral Presentation");
  // createConferenceWithSubmission never sets registration_deadline - confirms it stays null and isn't treated as "already passed".
  const res = await get(`/submission/register/${submissionId}`);
  assert.equal(res.status, 200);
});
