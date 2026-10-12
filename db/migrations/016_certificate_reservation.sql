-- BL-01 (security-audit/COMPLETE_FINDINGS_REGISTER.md): both certificate
-- paths (author certificates in `certificates`, reviewer/session-chair/
-- invited-speaker certificates in `role_certificates`) read "not yet
-- generated", then called the Canva API, uploaded to Cloudinary, and sent
-- an email - all BEFORE writing the row that would prevent a repeat. Their
-- unique constraints stop a duplicate database ROW, but not duplicate
-- external side effects (Canva calls, Cloudinary uploads, emails) that
-- already fired before that row was written - a double-click on "Enable
-- PDF Download", or a client retry after a slow response, could trigger
-- the whole pipeline twice for the same recipient.
--
-- `reserved_at` backs an atomic claim-or-steal-stale-claim pattern (see
-- api/index.js): a row is first written with status='GENERATING' and
-- reserved_at=now() via INSERT ... ON CONFLICT ... DO UPDATE ... WHERE
-- (not yet generated, and not reserved recently) RETURNING - a concurrent
-- second attempt loses that race and sees zero rows back, so it skips
-- instead of repeating the expensive work. A reservation older than 5
-- minutes (i.e. a process that crashed mid-generation) is treated as
-- stale and can be re-claimed, so a genuinely failed generation can still
-- be retried rather than being stuck forever.

ALTER TABLE certificates ADD COLUMN IF NOT EXISTS reserved_at timestamptz;
ALTER TABLE role_certificates ADD COLUMN IF NOT EXISTS reserved_at timestamptz;
