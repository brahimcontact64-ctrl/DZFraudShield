-- Migration: MDI performance indexes
--
-- H2: reputation engine queries merchant_shipment_history filtered on
--     identity_id alone (no merchant_id predicate — intentional for
--     cross-merchant reputation aggregation). The existing composite index
--     (merchant_id, identity_id) cannot satisfy this efficiently; a
--     standalone identity_id index is required to avoid full table scans
--     during reputation recompute.
--
-- H3: background_jobs dedup gates use JSONB containment (.contains "payload")
--     which requires a GIN index to avoid O(n) sequential scans. Without this
--     index, every call to enqueueReputationRecompute and
--     enqueueTargetedSyncIfNeeded scans the entire background_jobs table.

-- H2 — standalone identity_id index for reputation queries
CREATE INDEX IF NOT EXISTS idx_msh_identity_id
  ON merchant_shipment_history (identity_id)
  WHERE identity_id IS NOT NULL;

-- H3 — GIN index for JSONB containment dedup on background_jobs
CREATE INDEX IF NOT EXISTS idx_background_jobs_payload_gin
  ON background_jobs USING gin (payload);

-- Supporting composite for type+status filtering before JSONB containment
-- (lets the planner narrow to relevant rows before evaluating the GIN predicate)
CREATE INDEX IF NOT EXISTS idx_background_jobs_merchant_type_status
  ON background_jobs (merchant_id, type, status);
