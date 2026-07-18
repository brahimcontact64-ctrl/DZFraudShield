-- =============================================================================
-- Canonical Identity Resolution
-- Migration: 20260707000003
--
-- Depends on: 20260707000002_merchant_delivery_intelligence_constraints.sql
--
-- Purpose:
--   Prepares the identity layer for eager merge resolution without changing
--   any runtime behavior. No application code is modified by this migration.
--
--   Adds canonical_identity_id to customer_identity:
--     - For unmerged (canonical) identities: canonical_identity_id = id (self)
--     - For merged identities: canonical_identity_id = final canonical identity
--
--   The column is maintained automatically:
--     - Existing rows: backfilled to id via UPDATE
--     - New inserts:   a BEFORE INSERT trigger sets canonical_identity_id = id
--                      when the caller does not provide a value. This means
--                      existing application code (which does not know about this
--                      column) continues to work without modification.
--     - Merge writes:  application code (future Step 7) sets
--                      canonical_identity_id = targetId when recording a merge.
--
--   merged_into_identity_id (from migration 2) is kept as the audit trail.
--   canonical_identity_id is the operational O(1) pointer.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Add column (nullable so the UPDATE below can run before the FK exists)
-- ---------------------------------------------------------------------------

ALTER TABLE customer_identity
  ADD COLUMN IF NOT EXISTS canonical_identity_id uuid;


-- ---------------------------------------------------------------------------
-- 2. Backfill existing rows
--    Every existing identity is canonical: it points to itself.
--    Rows created before this migration were never merged, so self-pointing
--    is correct for all of them.
-- ---------------------------------------------------------------------------

UPDATE customer_identity
  SET canonical_identity_id = id
  WHERE canonical_identity_id IS NULL;


-- ---------------------------------------------------------------------------
-- 3. Trigger: auto-set canonical_identity_id = id for new inserts
--
--    Fires BEFORE INSERT so the value is in place when the FK is checked
--    at statement end. Application code that inserts without providing
--    canonical_identity_id gets the correct self-pointing value automatically.
--
--    Application code that provides an explicit canonical_identity_id
--    (i.e., the future merge writer) is not affected — the trigger only
--    fires when the value is NULL.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_customer_identity_canonical_default()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.canonical_identity_id IS NULL THEN
    NEW.canonical_identity_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_customer_identity_canonical_default
  BEFORE INSERT ON customer_identity
  FOR EACH ROW
  EXECUTE FUNCTION fn_customer_identity_canonical_default();


-- ---------------------------------------------------------------------------
-- 4. Foreign key: canonical_identity_id → customer_identity(id)
--
--    ON DELETE RESTRICT: prevents deletion of a canonical identity row
--    while other merged identities still point to it as their canonical.
--    A canonical identity can only be deleted once no merged identities
--    reference it (they must be re-pointed first, or deleted themselves).
--
--    Self-referencing inserts work without DEFERRABLE: PostgreSQL evaluates
--    FK constraints at statement end, by which time the self-referencing
--    row already exists in the table.
-- ---------------------------------------------------------------------------

ALTER TABLE customer_identity
  ADD CONSTRAINT customer_identity_canonical_fk
  FOREIGN KEY (canonical_identity_id) REFERENCES customer_identity (id)
  ON DELETE RESTRICT;


-- ---------------------------------------------------------------------------
-- 5. Index on canonical_identity_id
--
--    Two use cases:
--      a. Eager merge propagation: when identity B merges into C, a bulk
--         UPDATE sets canonical_identity_id = C for all rows where it was B.
--         Without this index, that UPDATE is a full table scan.
--      b. Audit / cleanup: find all merged identities that point to a given
--         canonical identity.
--
--    Not sparse (WHERE NOT NULL) because canonical identities (the majority)
--    also have this column set — all rows have a non-null value after backfill.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_customer_identity_canonical_id
  ON customer_identity (canonical_identity_id);
