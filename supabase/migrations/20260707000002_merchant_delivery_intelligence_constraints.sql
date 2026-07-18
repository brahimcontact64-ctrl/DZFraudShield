-- =============================================================================
-- Merchant Delivery Intelligence — Constraints & Identity Merge
-- Migration: 20260707000002
--
-- Depends on: 20260707000001_merchant_delivery_intelligence.sql
--
-- Three concerns:
--
--   1. Foreign keys: the five MDI tables reference merchants(id) ON DELETE CASCADE.
--      The FK was omitted from the first migration because the merchant table name
--      was unconfirmed. It is confirmed as "merchants" from the codebase.
--
--   2. Performance: customer_reputation has no index on reputation_score.
--      Network overview queries sort and filter by reputation_score on what will
--      become a multi-million-row table once MDI historical sync runs.
--
--   3. Identity merge lifecycle: synthetic identities (created from masked-phone
--      seeds) must not be deleted when upgraded to real identities. Instead,
--      customer_identity gains three nullable columns to record the merge.
--      The columns are provider-agnostic: merge_reason uses vocabulary that does
--      not reference any specific delivery provider.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Foreign keys: five MDI tables → merchants(id)
--    CASCADE DELETE: when a merchant account is removed, all of their sync
--    state, shipment history, status events, and webhook audit rows go with
--    them. customer_identity_link is merchant-scoped (it maps their WC orders)
--    and should also cascade.
-- ---------------------------------------------------------------------------

ALTER TABLE customer_identity_link
  ADD CONSTRAINT cil_merchant_fk
  FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE;

ALTER TABLE merchant_history_sync_status
  ADD CONSTRAINT mhss_merchant_fk
  FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE;

ALTER TABLE merchant_shipment_history
  ADD CONSTRAINT msh_merchant_fk
  FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE;

ALTER TABLE shipment_status_events
  ADD CONSTRAINT sse_merchant_fk
  FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE;

ALTER TABLE webhook_event_log
  ADD CONSTRAINT wel_merchant_fk
  FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE;


-- ---------------------------------------------------------------------------
-- 2. Performance index: customer_reputation(reputation_score DESC)
--    Covers:
--      - admin network overview: .gte("reputation_score", 76)
--      - admin top-risk customers: .order("reputation_score", { ascending: false }).limit(20)
--      - dashboard: .order("reputation_score", { ascending: true }).limit(100)
--    Both sort directions are served by DESC index (forward = ASC, backward = DESC).
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_customer_reputation_score
  ON customer_reputation (reputation_score DESC);


-- ---------------------------------------------------------------------------
-- 3. Identity merge columns on customer_identity
--
--    When a provisional (synthetic-seed) identity is upgraded to a real
--    identity, the provisional record is NOT deleted. Instead, it is marked as
--    merged into the confirmed record via these three columns.
--
--    Rules enforced by application code (not by DB constraint here):
--      - merged_into_identity_id must point to a confirmed identity
--        (one where merged_into_identity_id IS NULL) to prevent cycles.
--      - All three columns are set atomically when a merge is recorded.
--
--    merge_reason vocabulary (provider-agnostic):
--      "PHONE_RESOLVED"        — real phone discovered after provisional creation
--      "FINGERPRINT_MATCH"     — stronger fingerprint determined same person
--      "CROSS_PROVIDER_MATCH"  — two providers independently confirmed same person
--      "MANUAL_MERGE"          — administrative merge
-- ---------------------------------------------------------------------------

ALTER TABLE customer_identity
  ADD COLUMN IF NOT EXISTS merged_into_identity_id uuid
    REFERENCES customer_identity (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at    timestamptz,
  ADD COLUMN IF NOT EXISTS merge_reason text;


-- ---------------------------------------------------------------------------
-- 4. Index on customer_identity(merged_into_identity_id)
--    Sparse (WHERE NOT NULL): only merged records need to be found by this
--    column, which is a small fraction of the total. Used when:
--      - Following the merge chain for a given synthetic identity
--      - Cleanup jobs that scan for all records merged into a target identity
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_customer_identity_merged_into
  ON customer_identity (merged_into_identity_id)
  WHERE merged_into_identity_id IS NOT NULL;
