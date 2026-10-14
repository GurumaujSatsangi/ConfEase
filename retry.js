// REL-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md / PRODUCTION_RELIABILITY.md's
// "R4"): a shared, bounded retry-with-backoff helper for operations that can
// fail transiently (a dropped DB/Redis connection, a momentary SMTP hiccup,
// an external API's rate limit) but are safe to simply try again - used by
// config/db.js (read-only queries), mailer.js (SMTP sends), and canva.js
// (Canva Connect API calls). Deliberately NOT used for anything that isn't
// provably safe to repeat: retrying a non-idempotent operation after an
// ambiguous failure (did it actually go through before the connection
// dropped?) can cause a duplicate write/duplicate email, which would be
// worse than the original failure. Each caller decides what counts as
// retryable for its own failure modes via `isRetryable`.
//
// `getDelayMs(err, attempt, baseDelayMs)`, when given, computes the wait
// before the next attempt instead of the default exponential schedule -
// needed for a rate-limited API that tells you exactly how long to wait
// (an HTTP 429's Retry-After header) rather than guessing.
export async function retryWithBackoff(fn, { retries = 2, baseDelayMs = 200, isRetryable = () => true, onRetry, getDelayMs } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable(err)) throw err;
      if (onRetry) onRetry(err, attempt);
      const delay = getDelayMs ? getDelayMs(err, attempt, baseDelayMs) : baseDelayMs * 3 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Small, deliberate pause between independent operations in a batch (e.g.
// one certificate generation to the next) - spreads call volume out over
// time so a bulk run is less likely to approach a rate limit in the first
// place, as a complement to (not a replacement for) retryWithBackoff
// actually recovering when one is hit anyway.
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
