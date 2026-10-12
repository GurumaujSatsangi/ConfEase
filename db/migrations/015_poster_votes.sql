-- CACHE-03 (security-audit/COMPLETE_FINDINGS_REGISTER.md): poster upvotes
-- previously existed only in Redis (a Set for one-vote-per-IP dedup, plus
-- an INCR counter) - genuinely ephemeral primary data with no database
-- backing at all. A Redis restart without persistence, a key eviction
-- under memory pressure, or a managed-Redis plan change would silently and
-- permanently lose every vote with no way to reconstruct them.
--
-- Postgres is now the source of truth: the (submission_id, voter_ip)
-- primary key makes "one vote per IP per submission" an atomic,
-- database-enforced guarantee (via INSERT ... ON CONFLICT DO NOTHING)
-- rather than relying on Redis set-membership alone. Redis is still
-- touched afterward as a non-authoritative fast-path cache (see
-- api/index.js), but a Redis failure can no longer lose a committed vote.

CREATE TABLE IF NOT EXISTS poster_votes (
  submission_id text NOT NULL,
  voter_ip text NOT NULL,
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, voter_ip)
);
