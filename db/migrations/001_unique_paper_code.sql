-- Guarantees paper_code uniqueness under concurrency (the application retries on 23505).
-- This repository has no migration runner: review and run these statements manually.
--
-- Step 1 (read-only): check for existing duplicates. Resolve any rows returned before step 2.
--   SELECT paper_code, COUNT(*) FROM submissions WHERE paper_code IS NOT NULL GROUP BY paper_code HAVING COUNT(*) > 1;
--
-- Step 2: add the constraint (NULLs remain allowed).
ALTER TABLE submissions ADD CONSTRAINT submissions_paper_code_key UNIQUE (paper_code);
