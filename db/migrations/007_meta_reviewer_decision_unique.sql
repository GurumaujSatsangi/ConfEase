-- A meta-reviewer resubmitting their recommendation should update their existing
-- decision, not pile up a new row each time. Dedupe first (keep one arbitrary
-- row per submission_id - the rows are otherwise identical in practice, since
-- the app never offered a way to tell them apart), then enforce uniqueness so
-- the app can upsert going forward.

DELETE FROM meta_reviewer_decision a
USING meta_reviewer_decision b
WHERE a.ctid < b.ctid
  AND a.submission_id = b.submission_id;

ALTER TABLE meta_reviewer_decision ADD CONSTRAINT meta_reviewer_decision_submission_id_key UNIQUE (submission_id);
