-- Adds the top-level Track layer above the existing subject-area rows (conference_tracks).
-- Conference -> Track (optional, conference_groups) -> Subject Area (conference_tracks).
-- Existing subject-area rows keep group_id = NULL, so conferences without tracks keep working.
-- Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS conference_groups (
  group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id uuid NOT NULL REFERENCES conferences(conference_id) ON DELETE RESTRICT,
  group_name text NOT NULL CHECK (length(btrim(group_name)) > 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT conference_groups_unique_name UNIQUE (conference_id, group_name)
);

ALTER TABLE conference_tracks ADD COLUMN IF NOT EXISTS group_id uuid
  REFERENCES conference_groups(group_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS conference_tracks_group_idx ON conference_tracks (group_id);

COMMIT;
