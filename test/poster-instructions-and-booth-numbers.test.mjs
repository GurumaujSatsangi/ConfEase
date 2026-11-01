// Regression tests for three new poster-session features:
// 1. The poster coordinator can set/update poster_session.instructions
//    from views/score-posters.ejs (POST /score-posters/:id/set-instructions).
// 2. The poster coordinator can run a one-time, irreversible allotment of
//    poster display board numbers (POST /score-posters/:id/allot-booth-numbers),
//    assigned in ascending paper_number order, scoped to registered
//    submissions with "Submitted Final Camera Ready Paper for Poster
//    Presentation" status, and blocked from running a second time.
// 3. A registered author sees both the instructions and their board number
//    (once allotted) under their submission's Registration Details on
//    GET /conference/:id, only for the poster-status submission.
//
// Uses the real routes and the real local Postgres database.

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
const coordinatorEmail = "poster-coord-test@example.com";
const outsiderEmail = "poster-outsider-test@example.com";
const authorEmail = "poster-booth-author@example.com";

const coordinatorToken = jwt.sign({ typ: "access", email: coordinatorEmail, name: "Coord", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const outsiderToken = jwt.sign({ typ: "access", email: outsiderEmail, name: "Outsider", user_id: 2, role: "user", roles: {} }, secret, { expiresIn: "5m" });
const authorToken = jwt.sign({ typ: "access", email: authorEmail, name: "Author", user_id: 3, role: "user", roles: {} }, secret, { expiresIn: "5m" });

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
const post = (path, token, body = {}) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

let conferenceId;
let sub0002, sub0001, sub0003; // seeded out of order, to prove ascending-by-paper_number assignment
let unregisteredSub;

async function cleanup() {
  if (conferenceId) {
    await pool.query("delete from poster_session_booth_details where submission_id in (select submission_id from submissions where conference_id = $1)", [conferenceId]);
    await pool.query("delete from registration where conference_id = $1", [conferenceId]);
    await pool.query("delete from submissions where conference_id = $1", [conferenceId]);
    await pool.query("delete from poster_session where conference_id = $1", [conferenceId]);
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
}

after(async () => {
  await cleanup();
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["BOOTH_TEST_" + crypto.randomBytes(3).toString("hex"), "chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  await pool.query(
    "insert into poster_session (conference_id, coodinators) values ($1, $2)",
    [conferenceId, [coordinatorEmail]]
  );

  // Seeded with paper_number 2 first, then 1, then 3 - the allotment must
  // still assign board numbers in ascending paper_number order (2,1,3),
  // not insertion order.
  const mk = async (paperCode, paperNumber, status, registered) => {
    const s = await pool.query(
      "insert into submissions (conference_id, primary_author, title, paper_code, paper_number, submission_status) values ($1,$2,$3,$4,$5,$6) returning submission_id",
      [conferenceId, authorEmail, `Paper ${paperCode}`, paperCode, paperNumber, status]
    );
    const submissionId = s.rows[0].submission_id;
    if (registered) {
      await pool.query(
        "insert into registration (conference_id, submission_id, mode_of_presentation, attending_offline) values ($1,$2,'Offline',1)",
        [conferenceId, submissionId]
      );
    }
    return submissionId;
  };

  sub0002 = await mk("BT02", 2, "Submitted Final Camera Ready Paper for Poster Presentation", true);
  sub0001 = await mk("BT01", 1, "Submitted Final Camera Ready Paper for Poster Presentation", true);
  sub0003 = await mk("BT03", 3, "Submitted Final Camera Ready Paper for Poster Presentation", true);
  unregisteredSub = await mk("BT04", 4, "Submitted Final Camera Ready Paper for Poster Presentation", false);
});

test("a non-coordinator cannot set instructions or allot board numbers", async () => {
  const res1 = await post(`/score-posters/${conferenceId}/set-instructions`, outsiderToken, { instructions: "Hacked" });
  assert.equal(res1.status, 302);
  assert.match(loc(res1), /not authorized/);

  const res2 = await post(`/score-posters/${conferenceId}/allot-booth-numbers`, outsiderToken, {});
  assert.equal(res2.status, 302);
  assert.match(loc(res2), /not authorized/);

  const row = await pool.query("select instructions from poster_session where conference_id = $1", [conferenceId]);
  assert.notEqual(row.rows[0].instructions, "Hacked");
});

test("the coordinator can set and update instructions", async () => {
  const res = await post(`/score-posters/${conferenceId}/set-instructions`, coordinatorToken, {
    instructions: "Please set up your poster by 9am.",
  });
  assert.equal(res.status, 302);
  assert.match(loc(res), /Instructions saved/);

  const row = await pool.query("select instructions from poster_session where conference_id = $1", [conferenceId]);
  assert.equal(row.rows[0].instructions, "Please set up your poster by 9am.");
});

test("the registered author sees the instructions under Registration Details for the poster submission only", async () => {
  const res = await get(`/conference/${conferenceId}`, authorToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Instructions regarding Poster Presentation/);
  assert.match(html, /Please set up your poster by 9am\./);
  assert.match(html, /Poster Display Board Number/);
  assert.match(html, /Not yet allotted\./);
});

test("allotment assigns board numbers in ascending paper_number order, only to registered poster submissions", async () => {
  const res = await post(`/score-posters/${conferenceId}/allot-booth-numbers`, coordinatorToken, {});
  assert.equal(res.status, 302);
  assert.match(loc(res), /allotted to 3 participant/);

  const rows = await pool.query(
    "select submission_id, booth from poster_session_booth_details where submission_id = ANY($1)",
    [[sub0001, sub0002, sub0003, unregisteredSub]]
  );
  const byId = Object.fromEntries(rows.rows.map((r) => [r.submission_id, r.booth]));

  assert.equal(byId[sub0001], 1, "paper 0001 must get board number 1");
  assert.equal(byId[sub0002], 2, "paper 0002 must get board number 2");
  assert.equal(byId[sub0003], 3, "paper 0003 must get board number 3");
  assert.equal(byId[unregisteredSub], undefined, "an unregistered submission must not get a board number");
});

test("running the allotment a second time is blocked, since it can't be undone", async () => {
  const res = await post(`/score-posters/${conferenceId}/allot-booth-numbers`, coordinatorToken, {});
  assert.equal(res.status, 302);
  assert.match(loc(res), /already been allotted/);

  // Confirm nothing changed (still exactly one row per registered poster submission).
  const count = await pool.query(
    "select count(*)::int as n from poster_session_booth_details where submission_id = ANY($1)",
    [[sub0001, sub0002, sub0003]]
  );
  assert.equal(count.rows[0].n, 3);
});

test("the registered author now sees their actual board number", async () => {
  const res = await get(`/conference/${conferenceId}`, authorToken);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /Not yet allotted\./);
  // All three of 1, 2, 3 must appear somewhere (one per poster submission row).
  assert.match(html, />1<\/p>/);
  assert.match(html, />2<\/p>/);
  assert.match(html, />3<\/p>/);
});
