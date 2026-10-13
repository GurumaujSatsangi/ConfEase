-- DB-01 (security-audit/COMPLETE_FINDINGS_REGISTER.md), part 2 of 2:
-- submissions.submission_id and conferences.conference_id are uuid
-- primary keys, but nearly every table that logically references them
-- stored the reference as text/varchar with no foreign key at all - no
-- referential integrity anywhere this app's core data lives.
--
-- Verified live, immediately before writing this migration, for every
-- column converted below: every non-null value is valid UUID syntax, and
-- (after the cleanup step just below) every value matches an existing
-- parent row. Where that wasn't true, the cleanup step documents exactly
-- what was found and removed.
--
-- Orphan cleanup (local dev database only - see note at the end of this
-- file): desk_review.paper_id had 125 non-null values, of which only 3
-- matched an existing submission; poster_session.conference_id had 388,
-- of which only 1 matched an existing conference. Inspected a sample of
-- both: every orphaned row traces to this remediation session's own
-- repeated test runs (desk_review rows stamped with
-- "cache-test-chair@example.com" and timestamps from today; poster_session
-- rows with a null `date`, consistent with the placeholder row
-- /create-new-conference inserts, whose conference was later deleted
-- directly via `DELETE FROM conferences` by a test's own cleanup instead
-- of through the app's cascade-delete route). A genuine orphan - a row
-- whose referenced parent is already gone - has no valid use regardless
-- of how it was created, so removing them is safe independent of that
-- explanation; the explanation is included because this cleanup must
-- never run against a real production database without first confirming
-- its orphans are similarly inert.
DELETE FROM desk_review
  WHERE paper_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.submission_id::text = desk_review.paper_id);

DELETE FROM poster_session
  WHERE conference_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM conferences c WHERE c.conference_id::text = poster_session.conference_id);

-- Group A: already uuid on both sides, no cast needed. The app's own
-- delete-track route already blocks deleting a track that has submissions
-- (see /chair/dashboard/delete-track/:id) - RESTRICT backs that same
-- invariant at the database level instead of relying solely on the route
-- remembering to check it.
ALTER TABLE submissions
  ADD CONSTRAINT submissions_track_id_fkey
  FOREIGN KEY (track_id) REFERENCES conference_tracks (track_id) ON DELETE RESTRICT;

-- Group B: text/uuid mismatches. Each column is cast in place
-- (ALTER COLUMN ... TYPE uuid USING col::uuid) rather than added as a new
-- column and swapped, since every application call site already treats
-- these ids as opaque strings (the same pattern already used everywhere
-- against the existing uuid-typed submission_id/conference_id primary
-- keys) - node-postgres sends parameters untyped and lets Postgres infer
-- the type from the column, so no query changes are needed.
--
-- ON DELETE CASCADE is used for every submission_id/conference_id child
-- below: it's the exact behavior deleteSubmissionCascade() and the
-- conference-delete route (api/index.js) already implement by hand (see
-- DB-02/DB-03), so this is a backstop for those two routes, not a change
-- to what they do - and it also fixes the root cause of the orphan
-- cleanup above: any future direct `DELETE FROM conferences`/`DELETE FROM
-- submissions` (as several test files' own teardown already does,
-- bypassing the app's routes entirely) now cascades correctly instead of
-- quietly leaving the same kind of orphan behind again.
ALTER TABLE submissions ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE submissions
  ADD CONSTRAINT submissions_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;

ALTER TABLE certificates ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;
ALTER TABLE certificates ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

ALTER TABLE registration ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE registration
  ADD CONSTRAINT registration_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;
ALTER TABLE registration ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE registration
  ADD CONSTRAINT registration_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

ALTER TABLE peer_review ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE peer_review
  ADD CONSTRAINT peer_review_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;
ALTER TABLE peer_review ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE peer_review
  ADD CONSTRAINT peer_review_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

ALTER TABLE co_author_requests ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE co_author_requests
  ADD CONSTRAINT co_author_requests_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;
-- co_author_requests.submission_id is referenced by 3 row-level-security
-- policies left over from an apparent earlier Supabase/PostgREST-style
-- design - confirmed dead: ROW LEVEL SECURITY is not enabled on any table
-- in this database (pg_class.relrowsecurity is false everywhere), the app
-- connects as the table owner (which always bypasses RLS regardless), and
-- api/index.js never sets request.jwt.claims anywhere - but Postgres still
-- refuses to change a column's type while ANY policy (enabled or not)
-- references it. Dropped and recreated with their exact original
-- expressions (which already compare via ::text, so they keep working
-- identically once the column is uuid) rather than deleted outright, since
-- removing genuinely dead-but-harmless policy infrastructure is a separate
-- decision from fixing DB-01's missing foreign keys.
DROP POLICY co_author_requests_insert_authors ON co_author_requests;
DROP POLICY co_author_requests_read_authors ON co_author_requests;
DROP POLICY co_author_requests_read_target ON co_author_requests;

ALTER TABLE co_author_requests ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE co_author_requests
  ADD CONSTRAINT co_author_requests_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

CREATE POLICY co_author_requests_insert_authors ON co_author_requests FOR INSERT TO public
  WITH CHECK (((current_setting('request.jwt.claims'::text, true))::json ->> 'email'::text) IN (
    SELECT DISTINCT submissions.primary_author FROM submissions
    WHERE (submissions.submission_id)::text = (co_author_requests.submission_id)::text
  ));
CREATE POLICY co_author_requests_read_authors ON co_author_requests FOR SELECT TO public
  USING (((current_setting('request.jwt.claims'::text, true))::json ->> 'email'::text) IN (
    SELECT DISTINCT submissions.primary_author FROM submissions
    WHERE (submissions.submission_id)::text = (co_author_requests.submission_id)::text
  ));
CREATE POLICY co_author_requests_read_target ON co_author_requests FOR SELECT TO public
  USING (
    (co_author)::text = ((current_setting('request.jwt.claims'::text, true))::json ->> 'email'::text)
    OR ((current_setting('request.jwt.claims'::text, true))::json ->> 'email'::text) IN (
      SELECT DISTINCT submissions.primary_author FROM submissions
      WHERE (submissions.submission_id)::text = (co_author_requests.submission_id)::text
    )
  );

-- Same dead-RLS-policy situation as co_author_requests above.
DROP POLICY revised_submissions_read_authors ON revised_submissions;
DROP POLICY revised_submissions_update_authors ON revised_submissions;

ALTER TABLE revised_submissions ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE revised_submissions
  ADD CONSTRAINT revised_submissions_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

CREATE POLICY revised_submissions_read_authors ON revised_submissions FOR SELECT TO public
  USING (((current_setting('request.jwt.claims'::text, true))::json ->> 'email'::text) IN (
    SELECT DISTINCT submissions.primary_author FROM submissions
    WHERE (submissions.submission_id)::text = (revised_submissions.submission_id)::text
    UNION
    SELECT DISTINCT unnest(submissions.co_authors) FROM submissions
    WHERE (submissions.submission_id)::text = (revised_submissions.submission_id)::text
  ));
CREATE POLICY revised_submissions_update_authors ON revised_submissions FOR UPDATE TO public
  USING (((current_setting('request.jwt.claims'::text, true))::json ->> 'email'::text) IN (
    SELECT DISTINCT submissions.primary_author FROM submissions
    WHERE (submissions.submission_id)::text = (revised_submissions.submission_id)::text
    UNION
    SELECT DISTINCT unnest(submissions.co_authors) FROM submissions
    WHERE (submissions.submission_id)::text = (revised_submissions.submission_id)::text
  ))
  WITH CHECK (((current_setting('request.jwt.claims'::text, true))::json ->> 'email'::text) IN (
    SELECT DISTINCT submissions.primary_author FROM submissions
    WHERE (submissions.submission_id)::text = (revised_submissions.submission_id)::text
    UNION
    SELECT DISTINCT unnest(submissions.co_authors) FROM submissions
    WHERE (submissions.submission_id)::text = (revised_submissions.submission_id)::text
  ));

ALTER TABLE meta_reviewer_decision ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE meta_reviewer_decision
  ADD CONSTRAINT meta_reviewer_decision_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

ALTER TABLE poster_presentation_scores ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE poster_presentation_scores
  ADD CONSTRAINT poster_presentation_scores_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;
ALTER TABLE poster_presentation_scores ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE poster_presentation_scores
  ADD CONSTRAINT poster_presentation_scores_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

ALTER TABLE desk_review ALTER COLUMN paper_id TYPE uuid USING paper_id::uuid;
ALTER TABLE desk_review
  ADD CONSTRAINT desk_review_paper_id_fkey
  FOREIGN KEY (paper_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

ALTER TABLE poster_votes ALTER COLUMN submission_id TYPE uuid USING submission_id::uuid;
ALTER TABLE poster_votes
  ADD CONSTRAINT poster_votes_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions (submission_id) ON DELETE CASCADE;

-- final_camera_ready_submissions and invited_talk_submissions: RESTRICT on
-- track_id (same reasoning as submissions_track_id_fkey above - a track
-- with a camera-ready entry or invited talk against it shouldn't vanish
-- out from under them). invited_talk_submissions.track_id has no existing
-- application-level check at all before /chair/dashboard/delete-track/:id
-- deletes a track, so this specifically closes a real gap, not just adding
-- a backstop to an existing one.
ALTER TABLE final_camera_ready_submissions ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE final_camera_ready_submissions
  ADD CONSTRAINT final_camera_ready_submissions_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;
ALTER TABLE final_camera_ready_submissions ALTER COLUMN track_id TYPE uuid USING track_id::uuid;
ALTER TABLE final_camera_ready_submissions
  ADD CONSTRAINT final_camera_ready_submissions_track_id_fkey
  FOREIGN KEY (track_id) REFERENCES conference_tracks (track_id) ON DELETE RESTRICT;

ALTER TABLE invited_talk_submissions ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE invited_talk_submissions
  ADD CONSTRAINT invited_talk_submissions_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;
ALTER TABLE invited_talk_submissions ALTER COLUMN track_id TYPE uuid USING track_id::uuid;
ALTER TABLE invited_talk_submissions
  ADD CONSTRAINT invited_talk_submissions_track_id_fkey
  FOREIGN KEY (track_id) REFERENCES conference_tracks (track_id) ON DELETE RESTRICT;

ALTER TABLE invitees ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE invitees
  ADD CONSTRAINT invitees_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;

-- role_certificates.context_id is deliberately NOT given a foreign key:
-- it's polymorphic (a track_id for reviewer/session_chair roles, but
-- invited_talk_submissions.paper_id for the invited_speaker role - see
-- generateAndEmailRoleCertificate's callers) and a single column can't
-- carry a conditional foreign key to two different parent tables without
-- restructuring this table into separate nullable columns, which is out
-- of scope here. conference_id is unambiguous and gets a real FK.
ALTER TABLE role_certificates ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE role_certificates
  ADD CONSTRAINT role_certificates_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;

ALTER TABLE conference_roles ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE conference_roles
  ADD CONSTRAINT conference_roles_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;

ALTER TABLE conference_tracks ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE conference_tracks
  ADD CONSTRAINT conference_tracks_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;

ALTER TABLE conference_paper_counters ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE conference_paper_counters
  ADD CONSTRAINT conference_paper_counters_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;

ALTER TABLE poster_session ALTER COLUMN conference_id TYPE uuid USING conference_id::uuid;
ALTER TABLE poster_session
  ADD CONSTRAINT poster_session_conference_id_fkey
  FOREIGN KEY (conference_id) REFERENCES conferences (conference_id) ON DELETE CASCADE;

-- NOTE: this migration was written against, and applied only to, the
-- local development database used throughout this remediation session
-- (confirmed via DB_HOST/.env, never a production connection string).
-- Before running this against any other database - including this
-- project's real production database - re-run the same live checks this
-- migration's comments describe (non-null-value UUID-format check, then
-- an orphan check per column against its stated parent) and review
-- whatever the orphan-cleanup step would delete there, since production
-- data cannot be assumed to be test artifacts the way this dev database's
-- orphans were confirmed to be.
