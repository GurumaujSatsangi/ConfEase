-- poster_session.vc_link (the chair-set meeting link shown to the chair,
-- the poster coordinator, and - once an author's registered submission has
-- mode_of_presentation = 'Online' - the author on their My Submissions
-- table) was added directly to the database and to
-- views/chair/manage-poster-sessions.ejs / views/score-posters.ejs without
-- a tracked migration, so a fresh install from db/schema.sql would be
-- missing the column these views already assume exists.

ALTER TABLE poster_session ADD COLUMN IF NOT EXISTS vc_link text;
