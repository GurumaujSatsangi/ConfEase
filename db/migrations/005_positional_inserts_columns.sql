-- The app inserts into these tables by position (no column list), so they must not have a leading id column.
-- Migration 002 added one by mistake. Idempotent.
BEGIN;
ALTER TABLE conference_roles DROP COLUMN IF EXISTS id;
ALTER TABLE meta_reviewer_decision DROP COLUMN IF EXISTS id;
COMMIT;
