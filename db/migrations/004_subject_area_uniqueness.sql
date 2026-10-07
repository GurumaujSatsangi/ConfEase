-- Subject-area names are unique within their track, or within the conference when they have no track.
-- Track names are unique within a conference (conference_groups_unique_name, migration 003).
-- Idempotent. Check for duplicate names before running on a database with data:
--   SELECT conference_id, track_name, group_id, COUNT(*) FROM conference_tracks GROUP BY 1,2,3 HAVING COUNT(*) > 1;
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS conference_tracks_name_no_track
  ON conference_tracks (conference_id, track_name) WHERE group_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conference_tracks_name_in_track
  ON conference_tracks (group_id, track_name) WHERE group_id IS NOT NULL;
COMMIT;
