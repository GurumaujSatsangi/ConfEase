-- conference_roles had no uniqueness guard behind its check-then-insert
-- pattern in api/index.js (/add-invitee inserted an "invitee" row every time
-- it ran, only checking the `invitees` table for a prior invite - not
-- conference_roles itself). So inviting, removing, and re-inviting the same
-- person left behind one stale "invitee" row per attempt. Because the JWT's
-- roles claim is just this table's rows grouped by conference, a user with
-- leftover rows still showed as having a role (hiding the default-author
-- "Create New Submission" UI in conference.ejs's `!roleStr` check) even
-- after every real assignment backing that role was gone.
--
-- Deduplicate first (keep the lowest id per conference_id/email_id/role,
-- case-insensitively), then add a unique index so this can't recur. Other
-- grant sites already use ensureConferenceRole(), which checks-then-inserts
-- the same way /add-invitee did - this constraint is the backstop for all
-- of them, not just invitee.

DELETE FROM conference_roles a
USING conference_roles b
WHERE a.id > b.id
  AND a.conference_id = b.conference_id
  AND lower(a.email_id) = lower(b.email_id)
  AND a.role = b.role;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conference_roles_conference_email_role
  ON conference_roles (conference_id, lower(email_id), role);
