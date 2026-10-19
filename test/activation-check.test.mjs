// SEC-004: POST /activation-check used to fall through with no response at
// all when a user existed, was still ACTIVATION PENDING, but had no
// activation_requests row (e.g. the code was already used). Every
// supported path must now return the same enumeration-safe redirect.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1";

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

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

test("a non-existent email completes the request (previously the only working path)", async () => {
  const res = await post({ email: "activation-check-test-nobody@example.com" });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);
});

test("a pending user WITH an activation_requests row completes the request", async () => {
  const email = "activation-check-test-pending-with-row@example.com";
  createdEmails.push(email);
  await pool.query("insert into users (name, email, password, status) values ($1,$2,'x','ACTIVATION PENDING')", ["Test", email]);
  await pool.query("insert into activation_requests (email, activation_code) values ($1,$2)", [email, crypto.randomUUID()]);

  const res = await post({ email });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);
});

test("a pending user with NO activation_requests row (the bug's exact trigger) still completes the request", async () => {
  const email = "activation-check-test-pending-no-row@example.com";
  createdEmails.push(email);
  await pool.query("insert into users (name, email, password, status) values ($1,$2,'x','ACTIVATION PENDING')", ["Test", email]);
  // Deliberately no activation_requests row for this email.

  const res = await post({ email });
  assert.equal(res.status, 302, "this exact path used to hang with no response at all");
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);
});

test("an already-activated user also completes the request", async () => {
  const email = "activation-check-test-already-active@example.com";
  createdEmails.push(email);
  await pool.query("insert into users (name, email, password, status) values ($1,$2,'x','ACCOUNT ACTIVATED')", ["Test", email]);

  const res = await post({ email });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location") || ""), /Account Activation Code has been sent/);
});
