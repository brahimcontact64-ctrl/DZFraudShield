-- Migration: Index to support dead-job recovery queries (Step C)
--
-- recoverStuckJobs() queries:
--   SELECT id, type, merchant_id, attempts
--   FROM background_jobs
--   WHERE status = 'processing'
--   AND   updated_at < <cutoff>
--
-- Without this index the query scans the entire background_jobs table every
-- tick. The partial index on status = 'processing' keeps it small — in a
-- healthy system only a handful of rows are in this state.

CREATE INDEX IF NOT EXISTS idx_background_jobs_processing_updated
  ON background_jobs (updated_at)
  WHERE status = 'processing';
