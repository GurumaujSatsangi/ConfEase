-- DB-07 (security-audit/COMPLETE_FINDINGS_REGISTER.md): add indexes on the
-- columns the application actually filters by in its hottest-path queries.
-- None of these existed before - submissions/peer_review/registration had
-- indexes only on their primary/unique keys, and conference_roles had none
-- at all (not even a primary key), so every lookup of "who reviews/chairs
-- this conference" was a full sequential scan.
--
-- Purely additive - no column types change, no data is touched, nothing
-- here can break existing queries. Safe to run against a live database at
-- any time.
--
-- Production note: on a database under real write load, prefer running
-- each CREATE INDEX CONCURRENTLY statement individually, outside any
-- transaction block (CONCURRENTLY cannot run inside one) - the plain form
-- below is fine for a local/staging database or a low-traffic maintenance
-- window, which is how every migration in this project is actually applied
-- (there's no migration-runner script; see db/migrations/README context
-- from the project's own history - .sql files here are run by hand).

CREATE INDEX IF NOT EXISTS idx_submissions_conference_id ON submissions (conference_id);
CREATE INDEX IF NOT EXISTS idx_submissions_conference_status ON submissions (conference_id, submission_status);
CREATE INDEX IF NOT EXISTS idx_submissions_primary_author ON submissions (primary_author);

CREATE INDEX IF NOT EXISTS idx_peer_review_submission_id ON peer_review (submission_id);
CREATE INDEX IF NOT EXISTS idx_peer_review_conference_id ON peer_review (conference_id);

CREATE INDEX IF NOT EXISTS idx_registration_conference_id ON registration (conference_id);

-- conference_roles had no primary key or any index at all - add a
-- surrogate PK plus the composite index the application's role-lookup
-- queries actually need (conference_id, email_id).
ALTER TABLE conference_roles ADD COLUMN IF NOT EXISTS id bigserial;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'conference_roles'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE conference_roles ADD CONSTRAINT conference_roles_pkey PRIMARY KEY (id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_conference_roles_conference_email ON conference_roles (conference_id, email_id);
