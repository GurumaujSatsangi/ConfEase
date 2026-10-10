-- One registration row per submission. The app also checks for an existing
-- row before inserting, but this is the backstop against a race (two
-- concurrent submits) actually producing two rows.
ALTER TABLE registration ADD CONSTRAINT registration_submission_id_key UNIQUE (submission_id);
