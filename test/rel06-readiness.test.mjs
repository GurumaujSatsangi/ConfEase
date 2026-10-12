// Regression test for REL-06 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// GET / is a deliberate liveness-only route (it catches its own DB errors
// and still returns 200), so the Docker health check couldn't distinguish
// "process alive" from "database actually reachable". GET /healthz/ready
// adds that distinction without exposing any schema/query detail - only
// up/down booleans.

import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.SKIP_AUTOLISTEN = "1"; // see api/index.js - avoids a second, unclosable app.listen(port)

const { default: app } = await import("../api/index.js");
const { default: pool } = await import("../config/db.js");

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.close();
  await pool.end();
  setImmediate(() => process.exit(0));
});

test("GET /healthz/ready reports 200 and database:true when the database is reachable", async () => {
  const res = await fetch(base + "/healthz/ready");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ready");
  assert.equal(body.database, true);
  // No schema or query detail should ever be present in the response.
  assert.equal(Object.keys(body).sort().join(","), "database,redis,status");
});
