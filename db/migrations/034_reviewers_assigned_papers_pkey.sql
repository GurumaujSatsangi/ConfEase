-- DBA-012 (security-audit): reviewers_assigned_papers is the one table in
-- the schema with no primary key. Its existing unique index
-- (uniq_reviewers_assigned_papers_submission, on submission_id - see
-- migration 026) combined with the NOT NULL on that column already
-- enforces everything a primary key requires, so this is safe regardless
-- of what data currently exists: Postgres adopts the existing index as
-- the constraint's backing index instead of scanning/rebuilding anything,
-- and can only fail if the already-enforced NOT NULL/uniqueness were
-- somehow already violated, which they cannot be.
--
-- Deliberately NOT doing the larger DBA-003 structural fix here (text ->
-- uuid conversion, adding foreign keys to conferences/submissions/
-- conference_tracks) - this project's local dev copy of the table is
-- empty, so there's no way to confirm from here whether production's real
-- assignment data is clean enough for that conversion to succeed without
-- failing partway through. That remains a documented, open follow-up
-- requiring a read-only check against production first (see
-- security-audit/CONFEASE_DB_AUDIT_2026-11.md, DBA-003).
ALTER TABLE reviewers_assigned_papers
  ADD CONSTRAINT reviewers_assigned_papers_pkey PRIMARY KEY USING INDEX uniq_reviewers_assigned_papers_submission;
