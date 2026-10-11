-- The AI-generated-content detection feature (ai-text-detector package) has
-- been removed entirely - it was never surfaced anywhere in the UI that
-- wasn't already commented out, and the application does not use these
-- columns for anything else.
ALTER TABLE submissions DROP COLUMN IF EXISTS ai_score;
ALTER TABLE submissions DROP COLUMN IF EXISTS is_ai;
ALTER TABLE revised_submissions DROP COLUMN IF EXISTS ai_score;
ALTER TABLE revised_submissions DROP COLUMN IF EXISTS is_ai;
