-- Lets a chair restrict which final decisions are available to reviewers
-- and meta-reviewers for every subject area under a given Track (not
-- individual subject areas - the restriction is at the Track/group
-- level, so it applies uniformly to everything grouped under it).
-- Revision Required and Rejected are never restricted - only the two
-- acceptance outcomes are togglable, and at least one of them must always
-- stay enabled (a Track can't end up with zero acceptance routes).
ALTER TABLE conference_groups
  ADD COLUMN IF NOT EXISTS allow_oral_decision boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_poster_decision boolean NOT NULL DEFAULT true;

ALTER TABLE conference_groups
  DROP CONSTRAINT IF EXISTS conference_groups_at_least_one_decision_check;
ALTER TABLE conference_groups
  ADD CONSTRAINT conference_groups_at_least_one_decision_check
  CHECK (allow_oral_decision OR allow_poster_decision);
