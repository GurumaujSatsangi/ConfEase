-- poster_session.instructions (the poster coordinator's instructions for
-- participants, shown to a registered author once their submission has
-- "Submitted Final Camera Ready Paper for Poster Presentation" status) was
-- added directly to the database, same pattern as earlier user-added
-- columns - this tracks it for a fresh install and for any database that
-- predates it. views/score-posters.ejs already read this column before
-- this migration existed.
ALTER TABLE poster_session ADD COLUMN IF NOT EXISTS instructions text;

-- poster_session_booth_details: one row per submission once the poster
-- coordinator runs the (one-time, irreversible) board-number allotment.
-- Also added directly to the database first (as `submission_id text, booth
-- text`, no constraints) - normalized here to match this app's other
-- submission-keyed tables (uuid FK with cascade delete, so a deleted
-- submission can't leave an orphaned board-number row) now that proper
-- types can be established. Safe to do as a clean recreate: the table was
-- created only minutes before this migration, for this exact feature, and
-- has never held a row.
DROP TABLE IF EXISTS poster_session_booth_details;
CREATE TABLE poster_session_booth_details (
  submission_id uuid PRIMARY KEY REFERENCES submissions(submission_id) ON DELETE CASCADE,
  booth integer NOT NULL,
  allotted_at timestamptz NOT NULL DEFAULT now()
);
