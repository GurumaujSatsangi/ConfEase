-- Sequential, per-conference, human-facing paper number - independent of the
-- unique paper_code used for co-author linking. Formatted as a zero-padded
-- 4-digit string in the app (0001, 0002, ...), growing past 4 digits instead
-- of truncating once a conference passes 9999 submissions.

-- No FK to conferences(conference_id): that column is uuid while
-- submissions.conference_id (and this table) is varchar, matching the
-- rest of the schema's loose conference_id typing (see conference_roles).
CREATE TABLE IF NOT EXISTS conference_paper_counters (
  conference_id varchar PRIMARY KEY,
  last_number integer NOT NULL DEFAULT 0
);

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS paper_number integer;

-- Backfill existing submissions in creation order, numbered from 1 within each conference.
WITH numbered AS (
  SELECT submission_id,
         ROW_NUMBER() OVER (PARTITION BY conference_id ORDER BY created_at, submission_id) AS rn
  FROM submissions
  WHERE paper_number IS NULL
)
UPDATE submissions s
SET paper_number = numbered.rn
FROM numbered
WHERE s.submission_id = numbered.submission_id;

-- Seed/advance each conference's counter to match the highest paper_number already in use,
-- so the next generated number continues the sequence instead of restarting at 1.
INSERT INTO conference_paper_counters (conference_id, last_number)
SELECT conference_id, MAX(paper_number)
FROM submissions
WHERE paper_number IS NOT NULL
GROUP BY conference_id
ON CONFLICT (conference_id) DO UPDATE
  SET last_number = GREATEST(conference_paper_counters.last_number, EXCLUDED.last_number);
