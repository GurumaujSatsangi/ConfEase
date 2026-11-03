-- reviewers_assigned_papers (per-paper reviewer assignment, set via the
-- chair's /chair/dashboard/assign-papers/:id page) was "added directly to
-- the database" on whichever database migration 026 was first written
-- against - 026 only ALTERs this table (adds NOT NULL constraints and a
-- unique index), it never CREATEs it, so a database where this table was
-- never manually created (confirmed: production - "relation
-- reviewers_assigned_papers does not exist", error 42P01, on
-- GET /chair/dashboard/assign-papers/:id) was missing it entirely, with
-- no migration anywhere to fill the gap. This one does, matching
-- db/schema.sql's authoritative column list exactly.
--
-- Safe to run whether or not migration 026 already ran successfully
-- elsewhere: CREATE TABLE IF NOT EXISTS is a no-op if the table already
-- exists (from 026 having found it pre-created), and includes the same
-- NOT NULL columns and unique index 026 adds, so running 026 again
-- afterward (or having already run it before) is also a harmless no-op.
CREATE TABLE IF NOT EXISTS reviewers_assigned_papers (
  conference_id text NOT NULL,
  submission_id text NOT NULL,
  reviewer text NOT NULL,
  track text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_reviewers_assigned_papers_submission
  ON reviewers_assigned_papers (submission_id);
