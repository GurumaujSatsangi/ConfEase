-- reviewers_assigned_papers was added directly to the database (per-paper
-- reviewer assignment: the chair's new /chair/dashboard/assign-papers/:id
-- page lets a chair assign each submission in a subject area to one
-- specific reviewer, rather than every reviewer on the track seeing every
-- submission). It had no constraints at all - not even NOT NULL - so a
-- fresh install from db/schema.sql would be missing both the column
-- definitions' intent and the UNIQUE constraint the chair's save route
-- relies on (ON CONFLICT (submission_id) DO UPDATE, so re-saving the page
-- edits an existing assignment instead of leaving duplicate/stale rows).

ALTER TABLE reviewers_assigned_papers ALTER COLUMN conference_id SET NOT NULL;
ALTER TABLE reviewers_assigned_papers ALTER COLUMN submission_id SET NOT NULL;
ALTER TABLE reviewers_assigned_papers ALTER COLUMN reviewer SET NOT NULL;
ALTER TABLE reviewers_assigned_papers ALTER COLUMN track SET NOT NULL;

-- CREATE UNIQUE INDEX (not ADD CONSTRAINT), same as migration 022 - Postgres
-- has no ADD CONSTRAINT IF NOT EXISTS, and ON CONFLICT accepts a unique
-- index just as well as a named constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reviewers_assigned_papers_submission
  ON reviewers_assigned_papers (submission_id);
