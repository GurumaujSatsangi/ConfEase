-- One certificates row per submission, mirroring 008's pattern for
-- registration: the "Enable PDF Download" bulk-insert runs ON CONFLICT DO
-- NOTHING keyed on this, so re-clicking the button for a conference doesn't
-- create duplicate rows.
ALTER TABLE certificates ADD CONSTRAINT certificates_submission_id_key UNIQUE (submission_id);
