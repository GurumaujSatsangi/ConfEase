-- Certificates for Reviewers, Session Chairs, and Invited Speakers - a
-- separate table from `certificates` because those aren't tied to one
-- submission the way an author's certificate is:
--   - reviewer / session_chair: one per (conference, Subject Area, person) -
--     context_id is a conference_tracks.track_id.
--   - invited_speaker: one per (conference, invited talk, person) -
--     context_id is an invited_talk_submissions.paper_id.
-- Unlike author certificates (downloaded from "My Submissions"), these are
-- only ever emailed as a link - nothing in the app reads this table back
-- for display, it exists purely so re-clicking "Enable PDF Download" for a
-- conference doesn't re-email the same person twice.
CREATE TABLE IF NOT EXISTS role_certificates (
  conference_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('reviewer', 'session_chair', 'invited_speaker')),
  email text NOT NULL,
  context_id text NOT NULL,
  status text NOT NULL DEFAULT 'GENERATED',
  file_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conference_id, role, email, context_id)
);
