-- SEC-008 (security-audit/*): activation_requests.activation_code had no
-- expiry at all - a code was valid forever until used. Low real risk (the
-- code is a crypto.randomUUID(), effectively unguessable) but inconsistent
-- with every other one-time link in this app (password resets, account
-- setup), which all expire.
--
-- Non-destructive: adds a nullable-then-backfilled column, so existing
-- pending activation requests are not invalidated by this migration itself
-- - they get a fresh 24-hour window from the moment this runs, same as if
-- they'd just requested it. Only a later login attempt against an
-- actually-expired row is rejected, not this migration.
--
-- Rollback: `ALTER TABLE activation_requests DROP COLUMN IF EXISTS expires_at;`

ALTER TABLE activation_requests ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE activation_requests SET expires_at = NOW() + INTERVAL '24 hours' WHERE expires_at IS NULL;
ALTER TABLE activation_requests ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '24 hours');
