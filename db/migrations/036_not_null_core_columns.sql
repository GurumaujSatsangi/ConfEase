-- DBA-021 / DBA-022 (security-audit): users.email and submissions'
-- conference_id/primary_author/title are all nullable today despite
-- every code path that creates these rows always supplying them
-- (verified: the only two INSERT paths into users, and the single INSERT
-- path into submissions, all pass every one of these columns a non-null
-- value - see api/index.js around the "add-invitee"/registration-account
-- routes and the submission-upload route).
--
-- Confirmed clean on local dev (0 rows violate any of these). NOT
-- verified against production - if production has any pre-existing row
-- with a NULL in one of these columns (e.g. from data entered before a
-- validation rule existed, or a direct database edit), the matching
-- ALTER COLUMN statement below will fail with a clear constraint-violation
-- error rather than silently succeeding - run this migration manually and
-- check for that before assuming it applied cleanly.
--
-- submissions.track_id was deliberately NOT included here even though
-- the audit flagged it too: dozens of this project's own existing tests
-- insert a submission row without ever setting track_id (a test-fixture
-- convenience, not a deliberate "no subject area" scenario), and that
-- same convenience may well reflect real historical data too. Adding
-- NOT NULL there broke 88 existing tests when tried - left nullable.
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

ALTER TABLE submissions ALTER COLUMN conference_id SET NOT NULL;
ALTER TABLE submissions ALTER COLUMN primary_author SET NOT NULL;
ALTER TABLE submissions ALTER COLUMN title SET NOT NULL;
