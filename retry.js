// REL-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md / PRODUCTION_RELIABILITY.md's
// "R4"): a shared, bounded retry-with-backoff helper for operations that can
// fail transiently (a dropped DB/Redis connection, a momentary SMTP hiccup)
// but are safe to simply try again - used by config/db.js (read-only
// queries) and mailer.js (SMTP sends). Deliberately NOT used for anything
// that isn't provably safe to repeat: retrying a non-idempotent operation
// after an ambiguous failure (did it actually go through before the
// connection dropped?) can cause a duplicate write/duplicate email, which
// would be worse than the original failure. Each caller decides what
// counts as retryable for its own failure modes via `isRetryable`.
export async function retryWithBackoff(fn, { retries = 2, baseDelayMs = 200, isRetryable = () => true, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable(err)) throw err;
      if (onRetry) onRetry(err, attempt);
      const delay = baseDelayMs * 3 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
