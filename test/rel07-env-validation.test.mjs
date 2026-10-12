// Regression test for REL-07 (security-audit/COMPLETE_FINDINGS_REGISTER.md):
// previously nothing validated required configuration at startup - a
// misconfigured production deployment would start successfully and only
// fail later, confusingly, the first time a token was signed/verified.
// This spawns the real server as a child process (api/index.js calls
// process.exit() on failure, which would kill the test runner if imported
// in-process) with required env vars missing and NODE_ENV=production, and
// asserts it fails fast with a clear exit code and message - and that the
// message never contains the (blank, but still as a principle) secret
// values themselves, only variable names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appEntry = path.join(__dirname, "..", "api", "index.js");

function runWithEnv(envOverrides, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [appEntry], {
      env: { ...process.env, ...envOverrides },
      cwd: path.join(__dirname, ".."),
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", () => {}); // drain
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ timedOut: true, stderr, code: null });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ timedOut: false, stderr, code });
    });
  });
}

test("the server exits immediately with a clear error when required config is missing in production", async () => {
  const result = await runWithEnv({
    NODE_ENV: "production",
    DB_USER: "",
    DB_HOST: "",
    DB_NAME: "",
    DB_PASSWORD: "",
    DB_PORT: "",
    JWT_ACCESS_TOKEN_SECRET: "",
    JWT_REFRESH_TOKEN_SECRET: "",
    JWT_SECRET: "",
    SKIP_AUTOLISTEN: "",
  });

  assert.equal(result.timedOut, false, "the process must exit on its own, not hang");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FATAL: missing required environment variable/);
  assert.match(result.stderr, /DB_USER/);
  assert.match(result.stderr, /JWT_ACCESS_TOKEN_SECRET/);
});

test("the test harness flag (SKIP_AUTOLISTEN) bypasses the check even with missing config", async () => {
  const result = await runWithEnv({
    NODE_ENV: "production",
    DB_USER: "",
    DB_HOST: "",
    DB_NAME: "",
    DB_PASSWORD: "",
    DB_PORT: "",
    JWT_ACCESS_TOKEN_SECRET: "",
    JWT_REFRESH_TOKEN_SECRET: "",
    JWT_SECRET: "",
    SKIP_AUTOLISTEN: "1",
  }, 1500);

  // Under SKIP_AUTOLISTEN the validator is a no-op, so this must NOT hit
  // the FATAL exit(1) path - unlike the previous test, the process doesn't
  // exit on its own here (the pg Pool / Redis client stay open with no
  // app.listen() to accept a request that would use test/_setup.mjs-style
  // explicit cleanup, same as every real test file needs its own
  // pool.end()/process.exit(0) at the end), so this test only checks what
  // was actually logged before the timeout kills it, not the exit code.
  assert.doesNotMatch(result.stderr, /FATAL: missing required environment variable/);
});
