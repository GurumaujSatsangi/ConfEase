-- The poster-voting feature (POST /upvote-poster/:id) and the public
-- virtual-poster-presentation page it fed into were removed at the
-- user's request, together with the page's anonymous, unauthenticated
-- public access to final_camera_ready_submissions' file - that page was
-- the one place in the app serving an uploaded paper/poster to anyone
-- with the link, no login required, which was blocking the FILE-04
-- fix (locking submission files down to authenticated roles only).
-- poster_votes (migration 015) has no remaining reader anywhere in the
-- codebase now that the feature is gone.
DROP TABLE IF EXISTS poster_votes;
