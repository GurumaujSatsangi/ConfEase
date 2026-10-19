import pkg from "pg";
const { Pool, types } = pkg;

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { retryWithBackoff } from "../retry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This tells dotenv to look in the parent directory (the root ConfEase folder)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Return date columns as raw 'YYYY-MM-DD' strings instead of JS Date objects
// This prevents timezone-related off-by-one errors
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  user: process.env.DB_USER ,
  host: process.env.DB_HOST ,
  database: process.env.DB_NAME ,
  password: process.env.DB_PASSWORD ,
  port: parseInt(process.env.DB_PORT),
  // Local PostgreSQL does not use SSL; set DB_SSL=true for a remote server that requires it
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  // The app now runs as a single persistent server process (not one pool per
  // serverless invocation), so this pool is the only one that will ever
  // exist - sized for real concurrent request handling instead of staying
  // conservative to avoid multiplying across serverless instances.
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  // DB-AUD-004: `pg`'s own default here is 0 ("wait forever") - a request
  // that can't get a connection because all `max` are busy would otherwise
  // hang indefinitely instead of failing fast with a clear error. This
  // only changes that one exhaustion edge case; normal requests are
  // unaffected since a connection is almost always available immediately.
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS) || 5000,
});

// REL-04 (security-audit/PRODUCTION_RELIABILITY.md, "R4"): a brief
// Postgres restart or network blip previously failed every in-flight
// query outright, with no retry at any level. Wrapping pool.query() here
// (rather than touching the ~300 call sites across the app) gives every
// existing call site bounded, automatic retry for free - but only for
// SELECT queries: a write (INSERT/UPDATE/DELETE) that fails with a
// connection-level error is NOT safe to blindly retry, because node-postgres
// can't tell us whether the statement had already reached and executed on
// the server before the connection dropped - retrying it could silently
// duplicate the write. A SELECT has no such risk: running it again just
// re-reads the same data.
function isRetryableConnectionError(err) {
  const retryableCodes = new Set(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EPIPE", "EAI_AGAIN"]);
  // Postgres error codes for "the connection/server itself is the problem"
  // (admin/crash shutdown, cannot connect now, connection failure/rejected) -
  // as opposed to a real query error (syntax, constraint violation, etc.),
  // which has its own distinct, non-connection-class code and must not be
  // retried (it will just fail the same way again).
  const retryablePgCodes = new Set(["57P01", "57P02", "57P03", "08000", "08003", "08006", "08001", "08004"]);
  return (
    retryableCodes.has(err?.code) ||
    retryablePgCodes.has(err?.code) ||
    /Connection terminated unexpectedly/i.test(err?.message || "")
  );
}

function isSelectOnly(text) {
  return typeof text === "string" && /^\s*select\b/i.test(text);
}

// Factored out so a test can verify the wrapping behavior itself (retried
// vs not, how many attempts) against a disposable fake pool, without
// needing to fault-inject a real Postgres connection.
function wrapPoolQueryWithRetry(targetPool) {
  const originalQuery = targetPool.query.bind(targetPool);
  targetPool.query = (text, params, ...rest) => {
    if (!isSelectOnly(text)) return originalQuery(text, params, ...rest);
    return retryWithBackoff(() => originalQuery(text, params, ...rest), {
      retries: 2,
      baseDelayMs: 150,
      isRetryable: isRetryableConnectionError,
      onRetry: (err, attempt) => console.warn(`DB query retry ${attempt}/2 after connection error: ${err.message}`),
    });
  };
  return targetPool;
}

wrapPoolQueryWithRetry(pool);

export { isRetryableConnectionError, isSelectOnly, wrapPoolQueryWithRetry };
export default pool;
