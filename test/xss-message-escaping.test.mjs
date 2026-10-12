// Regression test for XSS-03 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// views/partials/dashboard/header.ejs reflected req.query.message into a
// <script> block as `text: '<%= message %>'` - HTML-escaping, not
// JS-string escaping. It happened to be safe only because EJS's default
// HTML-escaping also neutralizes the characters needed to break out of a
// JS string/script tag, which made it fragile rather than genuinely safe.
// Fixed to use JSON.stringify() (proper JS-string escaping) with an extra
// `</g` guard so a message containing "</script>" can't prematurely close
// the script tag either.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
const userEmail = "xss-msg-test-user@example.com";

after(async () => {
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("a message containing quotes, angle brackets, and a script-closing tag is rendered as a safe JS string literal", async () => {
  const token = jwt.sign({ typ: "access", email: userEmail, name: "XSS Msg Test", user_id: 1, role: "user", roles: {} }, secret, { expiresIn: "5m" });
  const payload = `it's "quoted" </script><script>alert(1)</script>`;

  const res = await fetch(base + "/dashboard?message=" + encodeURIComponent(payload), {
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const html = await res.text();

  // The payload must appear only inside a JSON.stringify()'d JS string
  // literal, never as a raw, unescaped "</script>" that could terminate
  // the surrounding <script> block early.
  assert.doesNotMatch(html, /text: '[^']*<\/script>/, "the old unsafe single-quoted reflection pattern must not be present");
  assert.match(html, /text:\s*"it's \\"quoted\\" \\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>"/, "the payload must be JSON-escaped with </ neutralized");

  // And the page must not contain a literal, premature closing </script>
  // immediately followed by attacker-controlled markup (i.e. the payload's
  // own "<script>" must never appear outside of the escaped string).
  assert.ok(!html.includes("</script><script>alert(1)</script>"), "the payload must never appear as live, unescaped markup");
});
