-- invited_talk_submissions.profile_photo (the invited speaker's photo,
-- now required on the submission form alongside the already-optional
-- paper and subject area) was added directly to the database, same
-- pattern as earlier user-added columns - this tracks it for a fresh
-- install and for any database that predates it.

ALTER TABLE invited_talk_submissions ADD COLUMN IF NOT EXISTS profile_photo character varying;
