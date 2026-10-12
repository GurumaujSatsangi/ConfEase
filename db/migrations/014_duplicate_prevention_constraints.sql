-- DB-04 / DB-05 (security-audit/COMPLETE_FINDINGS_REGISTER.md): peer_review
-- and co_author_requests had no unique constraint backing their
-- check-then-insert patterns in api/index.js, so two concurrent requests
-- (double-click, duplicate tab, retried request after a timeout) could both
-- pass the existence check and both insert - producing two review rows for
-- one reviewer (silently double-weighting their score in every leaderboard
-- average), or two pending co-author requests for the same person.
--
-- Verified against the live database before writing this migration: zero
-- existing duplicate (submission_id, reviewer) rows in peer_review, and
-- zero existing duplicate non-rejected (submission_id, co_author) rows in
-- co_author_requests - so these constraints are safe to add directly, no
-- cleanup step required first.
--
-- The co_author_requests constraint is partial (WHERE status != 'Rejected')
-- rather than a plain unique constraint, because the application's
-- intended behavior is that a previously-rejected request should not
-- permanently block a later, legitimate re-request from the same person -
-- that's existing business logic (see the route's own
-- "status != 'Rejected'" existence check in api/index.js), preserved here.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_peer_review_submission_reviewer
  ON peer_review (submission_id, reviewer);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_co_author_requests_pending
  ON co_author_requests (submission_id, co_author)
  WHERE status != 'Rejected';
