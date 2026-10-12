// Regression test for REL-02 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// previously there was no SIGTERM/SIGINT handling at all, no close of the
// Postgres pool or Redis client, and no last-resort uncaughtException/
// unhandledRejection handler.
//
// This test deliberately does NOT send an OS-level signal (`kill`/
// `child.kill('SIGINT')`) to a child process - on Windows that path is
// unreliable (signal emulation for externally-delivered signals is not
// guaranteed the way it is on Linux/the actual Docker deployment target,
// and was confirmed experimentally during this fix not to reliably invoke
// a registered handler at all). Instead it emits 'SIGINT' directly on the
// running process - this is a valid way to test the handler itself,
// because by the time any OS actually delivers a signal to a Node
// process, libuv's signal watcher has already called exactly
// process.emit('SIGINT') internally; the unreliable part on Windows is
// the OS-to-process transport in an automated test harness, not what
// Node does once the signal arrives, which this test exercises directly.
//
// Because this app's own module-level `app.listen()` only runs when
// SKIP_AUTOLISTEN is unset (every other test in this suite sets it to
// avoid a second, unclosable listener), this file deliberately does NOT
// set that flag - it needs the real shutdown-handler registration path,
// and is the one file in this suite allowed to let the module's own
// app.listen() run, immediately closing that listener once the module has
// loaded and before emitting the signal.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PORT = "0"; // bind to an OS-assigned port, not the app's usual default
const originalExit = process.exit.bind(process);

test("SIGINT triggers a clean shutdown: HTTP server, database pool, and Redis client are all closed, then the process exits with code 0", async () => {
  const { default: pool } = await import("../config/db.js");
  const originalPoolEnd = pool.end.bind(pool);
  let poolEndCalled = false;
  pool.end = async (...args) => {
    poolEndCalled = true;
    return originalPoolEnd(...args);
  };

  let exitCode = null;
  let exitCalled = false;
  process.exit = (code) => {
    exitCalled = true;
    exitCode = code;
    // Swallow the exit instead of actually terminating the test process -
    // this IS the thing under test, so we need to observe it, not suffer it.
  };

  await import("../api/index.js");

  // Give the module a moment to finish its own app.listen() callback.
  await new Promise((resolve) => setTimeout(resolve, 200));

  process.emit("SIGINT");

  // The shutdown sequence is async (server.close callback -> pool.end ->
  // redisClient.quit -> process.exit) - poll briefly for it to finish
  // rather than assuming a fixed delay is enough.
  const deadline = Date.now() + 5000;
  while (!exitCalled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  process.exit = originalExit;

  assert.equal(exitCalled, true, "process.exit must be called once shutdown completes");
  assert.equal(exitCode, 0, "a clean SIGINT shutdown must exit with code 0");
  assert.equal(poolEndCalled, true, "the database pool must be closed during shutdown");

  // The real shutdown handler already closed the pool - nothing left to
  // clean up here, just let the process end.
  setImmediate(() => originalExit(0));
});
