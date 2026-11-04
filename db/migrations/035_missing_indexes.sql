-- DBA-007 through DBA-010, DBA-020 (security-audit): these are all
-- foreign-key-backed columns that Postgres does not automatically index
-- on the referencing side, and that were missed by the earlier index
-- pass (migration 013) that covered submissions.conference_id/
-- submission_status/primary_author and peer_review's columns. Each one
-- is queried/joined on frequently in api/index.js (reviewer dashboards,
-- isAuthorizedReviewerForSubmission, getAllowedDecisionsForTrack, the
-- cascade-delete paths, the chair's view-submissions page). Verified none
-- of these columns are already covered by an existing index (including as
-- a leading column of a composite one) before writing this.
--
-- Plain CREATE INDEX (not CONCURRENTLY) to match every other index-adding
-- migration in this project (e.g. 013) - CONCURRENTLY cannot run inside
-- the transaction wrapper migrations are typically applied under here, and
-- these tables are not large enough yet for a brief lock to matter. If
-- run against a production table that has since grown large, consider
-- running the equivalent CREATE INDEX CONCURRENTLY statements by hand
-- outside a transaction instead.
CREATE INDEX IF NOT EXISTS idx_submissions_track_id ON submissions (track_id);
CREATE INDEX IF NOT EXISTS idx_desk_review_paper_id ON desk_review (paper_id);
CREATE INDEX IF NOT EXISTS idx_revised_submissions_submission_id ON revised_submissions (submission_id);
CREATE INDEX IF NOT EXISTS idx_reviewers_assigned_papers_track ON reviewers_assigned_papers (track);
CREATE INDEX IF NOT EXISTS idx_poster_session_conference_id ON poster_session (conference_id);
