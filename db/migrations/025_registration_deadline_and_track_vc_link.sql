-- conferences.registration_deadline (enforced by loadRegistrationEligibleSubmission
-- in api/index.js, displayed on views/chair/edit-conference.ejs and the
-- Important Dates table in views/conference.ejs) and conference_tracks.vc_link
-- (the chair-set "Link for Online Attendees" for oral sessions, mirroring
-- poster_session.vc_link from migration 023) were both added directly to the
-- database without a tracked migration, so a fresh install from
-- db/schema.sql would be missing both columns these routes/views already
-- assume exist.

ALTER TABLE conferences ADD COLUMN IF NOT EXISTS registration_deadline date;
ALTER TABLE conference_tracks ADD COLUMN IF NOT EXISTS vc_link text;
