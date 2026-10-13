-- FILE-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md), narrowed scope
-- per explicit instruction: only the paper itself (the manuscript the
-- author uploads, through every stage of its lifecycle - original,
-- edited, revised, and camera-ready) needs to stop being a plain public
-- Cloudinary URL. Certificates and invited-talk files are left as they
-- are. The public virtual-poster-presentation page that used to read
-- final_camera_ready_submissions.file_url with no login at all has
-- already been removed (migration 019), which is what makes locking that
-- table down here possible without breaking it.
--
-- Cloudinary's `type: "private"` upload type blocks direct delivery of a
-- file by URL, even if that URL is known/leaked - serving it at all
-- requires a signed, time-limited request (cloudinary.utils.private_download_url
-- in api/index.js), generated fresh only after the app's own existing
-- role/ownership checks have already run. That requires more than just
-- the delivery URL on hand: the request needs the asset's public_id,
-- resource_type (Cloudinary auto-detects "image" for PDFs, "raw" for
-- DOCX/DOC - it varies per upload, so it can't be assumed), and format.
-- Storing these at upload time, rather than trying to parse them back out
-- of a URL string later, is the reliable way to regenerate a correct
-- signed link on every page load.
--
-- file_url itself is left in place and still written at upload time
-- (now pointing at a private, unfetchable-as-is URL) purely as a
-- same-shape fallback/record; every route that shows it to a user
-- overwrites it with a freshly-signed link before rendering.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS file_public_id text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS file_resource_type text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS file_format text;

ALTER TABLE final_camera_ready_submissions ADD COLUMN IF NOT EXISTS file_public_id text;
ALTER TABLE final_camera_ready_submissions ADD COLUMN IF NOT EXISTS file_resource_type text;
ALTER TABLE final_camera_ready_submissions ADD COLUMN IF NOT EXISTS file_format text;
