-- Chair-uploaded DrillBit AI & Plagiarism Report (PDF) for a submission -
-- a manual alternative to the never-finished automated Drillbit API
-- integration (027_drillbit_integration.sql, still unused anywhere in the
-- app). Uploaded from the chair's Desk Review page, same Cloudinary
-- public_id/resource_type/format pattern as submissions.file_*. Visible to
-- the primary author and co-authors once the submission has been
-- desk-accepted or desk-rejected (see views/conference.ejs).
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS plagiarism_report_public_id text,
  ADD COLUMN IF NOT EXISTS plagiarism_report_resource_type text,
  ADD COLUMN IF NOT EXISTS plagiarism_report_format text;
