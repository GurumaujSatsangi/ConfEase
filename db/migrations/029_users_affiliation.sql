-- users.address was replaced by users.affiliation directly on the
-- database at some point (same "added directly to the database" pattern
-- as invited_talk_submissions.profile_photo before migration 028) -
-- api/index.js has depended on `affiliation` ever since (POST
-- /user-registration, GET/POST /update-profile, GET /my-profile), but
-- neither the rename nor the new column were ever tracked by a migration,
-- so db/schema.sql still declared the old `address` column. A fresh
-- install from schema.sql alone would create `address` instead of
-- `affiliation` and the app would fail on registration and profile
-- updates with "column affiliation does not exist".
--
-- Backfills from the old column (in case any database still has data in
-- it) before dropping it, so no data is lost on a database that predates
-- this migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliation text;

-- Plain UPDATE ... SET affiliation = address would fail to even parse on
-- a database (like this project's own dev database) where `address` has
-- already been dropped - a bare SQL statement can't reference a column
-- conditionally, so the backfill is wrapped in a DO block that only runs
-- it when the column still exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'address'
  ) THEN
    UPDATE users SET affiliation = address WHERE affiliation IS NULL AND address IS NOT NULL;
    ALTER TABLE users DROP COLUMN address;
  END IF;
END $$;
