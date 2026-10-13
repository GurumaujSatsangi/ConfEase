// Regression test: GET /conference/:id used to decide whether to show
// "Submit Invited Talk Paper" / "My Invited Talk Submissions" purely from
// the "invitee" role baked into the user's JWT (roles claim, set at
// login/token-refresh time from conference_roles) - never checking the
// live invitees table. A JWT's roles claim is a point-in-time snapshot;
// if conference_roles and invitees ever fall out of sync (or a role claim
// simply outlives whatever it was meant to reflect), the page kept
// showing invited-talk UI with nothing real behind it, confirmed by a
// user whose email was not in invitees for that conference but who still
// saw the button. The underlying submission routes
// (GET /submission/invited-talk/:id, POST /submit-invited-talk) already
// checked the live invitees table correctly and would have rejected the
// user - this was a display-only bug, not a bypassable authorization gap
// - but still a real "I appear invited when I'm not" problem. Fixed by
// having the route itself query invitees live and pass that as `isInvitee`
// to the template, instead of trusting the token's cached role.

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
const staleEmail = "invitee-stale-role@example.com";
const realEmail = "invitee-real-role@example.com";

const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

let conferenceId;

before(async () => {
  const conf = await pool.query(
    "insert into conferences (title, created_by) values ($1,$2) returning conference_id",
    ["INVITEE_ROLE_TEST_" + crypto.randomBytes(3).toString("hex"), "invitee-role-test-chair@example.com"]
  );
  conferenceId = conf.rows[0].conference_id;

  // realEmail genuinely is an invitee for this conference.
  await pool.query("insert into invitees (conference_id, name, email) values ($1,$2,$3)", [conferenceId, "Real Invitee", realEmail]);
});

after(async () => {
  if (conferenceId) {
    await pool.query("delete from conferences where conference_id = $1", [conferenceId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a user whose JWT claims an 'invitee' role for this conference, but who has no row in invitees, does not see invited-talk UI", async () => {
  // Same roles-claim shape loadConferenceRoles()/the real login flow
  // produces: { [conference_id]: ["invitee"] } - minted directly here
  // (no login flow) specifically to simulate a stale/out-of-sync claim,
  // since staleEmail is never inserted into invitees at all.
  const staleToken = jwt.sign(
    { typ: "access", email: staleEmail, name: "Stale Role User", user_id: 1, role: "user", roles: { [conferenceId]: ["invitee"] } },
    secret,
    { expiresIn: "5m" }
  );

  const html = await (await get(`/conference/${conferenceId}`, staleToken)).text();
  assert.ok(!html.includes("Submit Invited Talk Paper"), "a user not in invitees must not see the submit button, even if their token claims the invitee role");
  assert.ok(!html.includes("My Invited Talk Submissions"), "a user not in invitees must not see the invited-submissions button either");
});

test("a genuine invitee (a real row in invitees for this conference) does see the invited-talk UI", async () => {
  const realToken = jwt.sign(
    { typ: "access", email: realEmail, name: "Real Invitee", user_id: 2, role: "user", roles: { [conferenceId]: ["invitee"] } },
    secret,
    { expiresIn: "5m" }
  );

  const html = await (await get(`/conference/${conferenceId}`, realToken)).text();
  assert.ok(html.includes("Submit Invited Talk Paper"), "a genuine invitee must still see the submit button");
  assert.ok(html.includes("My Invited Talk Submissions"), "a genuine invitee must still see the invited-submissions button");
});
