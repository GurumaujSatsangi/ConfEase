-- Registration gained a second Google Drive link field for the PPT used
-- in an Oral Presentation (Accepted for Oral Presentation submissions).
-- Optional at the DB level - the form only shows an advisory notice that
-- it's mandatory for Oral Presentation, it isn't enforced with NOT NULL,
-- matching link_to_video's existing nullable column.
ALTER TABLE registration
  ADD COLUMN IF NOT EXISTS ppt_link text;
