// Regression test: GET /reset-password/:token used to pass the whole
// password_resets database row to login/reset-password.ejs, whose hidden
// form field read result.token - but that column holds the SHA-256 hash
// stored in the database, not the raw token from the URL. The form
// therefore submitted the hash, and POST /update-password hashed it AGAIN
// before comparing against the stored hash - a hash-of-a-hash that could
// never match the stored single hash, no matter how fresh the link was.
// This made every single password reset fail, 100% of the time, with
// "Your reset link is invalid or has expired" - indistinguishable from an
// actually-expired link. Every other test covering this route called
// POST /update-password directly with a known-correct raw token, bypassing
// the GET page's rendering entirely, which is exactly why this was never
// caught. This test instead drives the real GET page and extracts the
// hidden field's actual value, the same way a browser would.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import crypto from "node:crypto";

process.env.SKIP_AUTOLISTEN = "1"; // bypasses authRateLimitMemory and CSRF, same as every other route test

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const get = (path) => fetch(base + path, { redirect: "manual" });
const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
const loc = (res) => decodeURIComponent(res.headers.get("location") || "");

const email = "reset-form-token-test@example.com";
let userId;

after(async () => {
  if (userId) {
    await pool.query("delete from password_resets where email = $1", [email]);
    await pool.query("delete from users where id = $1", [userId]);
  }
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("the actual hidden form field on the GET reset-password page carries a token that POST /update-password accepts", async () => {
  const oldPasswordHash = await bcrypt.hash("OldPassw0rd1", 10);
  const userResult = await pool.query(
    "insert into users (name, email, password, status) values ($1,$2,$3,'ACCOUNT ACTIVATED') returning id",
    ["Reset Form Token Test", email, oldPasswordHash]
  );
  userId = userResult.rows[0].id;

  // Seed a reset token exactly the way /send-password-reset-link does
  // (store the hash, email the raw token) - then drive the real GET page
  // with the raw token, the same way a browser following the emailed link
  // would.
  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashed = crypto.createHash("sha256").update(rawToken).digest("hex");
  await pool.query(
    "insert into password_resets (email, token, expires_at) values ($1,$2, now() + interval '1 hour')",
    [email, hashed]
  );

  const getRes = await get(`/reset-password/${rawToken}`);
  assert.equal(getRes.status, 200, "a valid, unexpired token must render the form, not redirect");
  const html = await getRes.text();

  const match = html.match(/name="token"\s+value="([^"]*)"/);
  assert.ok(match, "the rendered page must contain a hidden token field");
  const formToken = match[1];

  // This is the actual bug: before the fix, formToken was the SHA-256 hash
  // (64 hex chars, but NOT equal to rawToken) - asserting equality here is
  // what would have caught it.
  assert.equal(formToken, rawToken, "the hidden form field must carry the raw token, not its stored hash");

  const updateRes = await post("/update-password", { token: formToken, new_password: "NewPassw0rd2" });
  assert.equal(updateRes.status, 302);
  assert.match(loc(updateRes), /Password Updated/, "the exact token the page handed the browser must be accepted");

  const userRow = await pool.query("select password from users where id = $1", [userId]);
  assert.equal(await bcrypt.compare("NewPassw0rd2", userRow.rows[0].password), true);
});
