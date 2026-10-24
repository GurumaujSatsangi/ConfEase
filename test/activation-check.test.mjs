// SEC-004: POST /activation-check used to fall through with no response at
// all when a user existed, was still ACTIVATION PENDING, but had no
// activation_requests row (e.g. the code was already used). Every
// supported path must now return the same enumeration-safe redirect.
//
// Found during a later audit (user report: "some users are not able to
// create their accounts"): the SEC-004 fix overcorrected - it made the
// route's two queries pure no-ops (results read and discarded), so it
// never actually regenerated a code or sent an email for ANYONE, including
// the one case this route exists to serve. A user whose original
// activation email never arrived (or whose registration partially failed -
// see POST /user-registration) had no way back in: POST /user-registration
// refuses to let an existing email register again, and this "Did not
// receive code?" flow silently did nothing. Tests below now assert the
// real work actually happens for a still-pending user, not just that the
// response looks the same.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");
const { testSentEmails, resetTestSentEmails } = await import("../mailer.js");

beforeEach(() => resetTestSentEmails());

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const post = (body) =>
  fetch(`${base}/activation-check`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const createdEmails = [];
after(async () => {
  for (const email of createdEmails) {
    await pool.query("delete from activation_requests where email = $1", [email]);
    await pool.query("delete from users where email = $1", [email]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a non-existent email completes the request, and no email is actually sent", async () => {
  const res = await post({ email: "activation-check-test-nobody@example.com" });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);
  assert.equal(testSentEmails.length, 0, "an email must never be sent for an address with no account - that would be an enumeration/spam vector");
});

test("a pending user WITH an activation_requests row gets a genuinely new code emailed to them", async () => {
  const email = "activation-check-test-pending-with-row@example.com";
  createdEmails.push(email);
  await pool.query("insert into users (name, email, password, status) values ($1,$2,'x','ACTIVATION PENDING')", ["Test", email]);
  const oldCode = crypto.randomUUID();
  await pool.query("insert into activation_requests (email, activation_code) values ($1,$2)", [email, oldCode]);

  const res = await post({ email });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);

  assert.equal(testSentEmails.length, 1, "the resend must actually send an email, not silently do nothing");
  assert.equal(testSentEmails[0].to, email);

  const rows = await pool.query("select activation_code from activation_requests where email = $1 order by id", [email]);
  assert.ok(rows.rows.length >= 2, "a fresh activation_requests row must be inserted, not just the original one left in place");
  assert.ok(rows.rows.some(r => r.activation_code !== oldCode), "the new row's code must differ from the stale one");
});

test("a pending user with NO activation_requests row (the original SEC-004 bug's exact trigger) gets a fresh code emailed to them, not just a non-crashing response", async () => {
  const email = "activation-check-test-pending-no-row@example.com";
  createdEmails.push(email);
  await pool.query("insert into users (name, email, password, status) values ($1,$2,'x','ACTIVATION PENDING')", ["Test", email]);
  // Deliberately no activation_requests row for this email.

  const res = await post({ email });
  assert.equal(res.status, 302, "this exact path used to hang with no response at all");
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);

  assert.equal(testSentEmails.length, 1, "a user stuck ACTIVATION PENDING with no code at all must still be able to get back in");
  assert.equal(testSentEmails[0].to, email);

  const rows = await pool.query("select 1 from activation_requests where email = $1", [email]);
  assert.equal(rows.rows.length, 1, "exactly one fresh activation_requests row must now exist");
});

test("an already-activated user completes the request, and no email is sent (nothing to resend, and must not leak activation status)", async () => {
  const email = "activation-check-test-already-active@example.com";
  createdEmails.push(email);
  await pool.query("insert into users (name, email, password, status) values ($1,$2,'x','ACCOUNT ACTIVATED')", ["Test", email]);

  const res = await post({ email });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);
  assert.equal(testSentEmails.length, 0, "an already-activated account has nothing to resend, and silently doing nothing here is what keeps this route enumeration-safe");
});
