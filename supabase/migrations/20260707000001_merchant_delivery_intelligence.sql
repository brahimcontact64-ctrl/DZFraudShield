-- =============================================================================
-- Merchant Delivery Intelligence
-- Migration: 20260707000001
--
-- Creates five new tables for the DZ Fraud Shield Merchant Delivery
-- Intelligence pipeline:
--
--   1. customer_identity_link       — WooCommerce ↔ Yalidine tracking bridge
--   2. merchant_history_sync_status — full + incremental sync cursors / liveness
--   3. merchant_shipment_history    — per-parcel mutable snapshot (source of truth)
--   4. shipment_status_events       — append-only status event log from /v1/histories
--   5. webhook_event_log            — raw Yalidine webhook audit + deduplication
--
-- NOTE on customer_reputation:
--   The cross-merchant `customer_reputation` table already exists in the database
--   (written by recomputeIdentityReputation in reputation.ts, UNIQUE identity_id).
--   The new shipment data feeds into that existing table via the identity pipeline.
--   A new table is NOT created here to avoid a naming and constraint conflict.
--
-- NOTE on merchant_id foreign key:
--   merchant_id is NOT constrained with a REFERENCES clause because the merchants
--   table name differs between environments. Add the FK manually once confirmed.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. customer_identity_link
--    Created at WooCommerce order placement, before Yalidine knows about the
--    shipment. Stores the real (unmasked) customer phone hash so it can later
--    be linked to a Yalidine tracking number when the shipment is created.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_identity_link (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id     uuid        NOT NULL,
  wc_order_id     text        NOT NULL,
  provider        text        NOT NULL DEFAULT 'yalidine',
  tracking        text,                              -- null until shipment created
  real_phone_hash text        NOT NULL,              -- HMAC-SHA256 of normalized real phone
  normalized_name text,                              -- lowercased, stripped diacritics
  wilaya_id       integer,
  commune_name    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  linked_at       timestamptz,                       -- set when tracking is resolved

  CONSTRAINT customer_identity_link_pkey          PRIMARY KEY (id),
  CONSTRAINT customer_identity_link_order_unique  UNIQUE (merchant_id, wc_order_id)
);

-- Fast path: resolve tracking → real phone hash
CREATE INDEX IF NOT EXISTS customer_identity_link_tracking_idx
  ON customer_identity_link (merchant_id, tracking)
  WHERE tracking IS NOT NULL;

-- Fast path: reputation recompute lookup by real phone hash
CREATE INDEX IF NOT EXISTS customer_identity_link_phone_idx
  ON customer_identity_link (merchant_id, real_phone_hash);


-- ---------------------------------------------------------------------------
-- 2. merchant_history_sync_status
--    One row per (merchant_id, provider). Tracks the state and resume cursors
--    for both the one-time full historical sync and the recurring incremental
--    sync. Mirrors the heartbeat/stale-lock pattern from
--    merchant_delivery_sync_status.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS merchant_history_sync_status (
  id                            uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id                   uuid        NOT NULL,
  provider                      text        NOT NULL,

  -- Full historical parcel sync (GET /v1/parcels, list)
  full_parcels_status           text        NOT NULL DEFAULT 'pending',  -- pending/running/completed/failed
  full_parcels_cursor           text,                                    -- links.next URL, resume point
  full_parcels_started_at       timestamptz,
  full_parcels_completed_at     timestamptz,
  full_parcels_total            integer     NOT NULL DEFAULT 0,

  -- Full historical events sync (GET /v1/histories, list)
  full_histories_status         text        NOT NULL DEFAULT 'pending',
  full_histories_cursor         text,
  full_histories_started_at     timestamptz,
  full_histories_completed_at   timestamptz,
  full_histories_total          integer     NOT NULL DEFAULT 0,

  -- Incremental sync anchors (overlap window: anchor - 24h)
  last_parcels_synced_at        timestamptz,
  last_histories_synced_at      timestamptz,

  -- Liveness (heartbeat every 30 s; stale after 5 min)
  last_heartbeat_at             timestamptz,
  last_error                    text,

  CONSTRAINT merchant_history_sync_status_pkey   PRIMARY KEY (id),
  CONSTRAINT merchant_history_sync_status_unique UNIQUE (merchant_id, provider)
);


-- ---------------------------------------------------------------------------
-- 3. merchant_shipment_history
--    One row per (merchant_id, provider, tracking). Mutable snapshot of the
--    latest known state of a Yalidine parcel. Updated on every poll cycle.
--    Immutable columns: first_seen_at (set on INSERT, excluded from upsert).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS merchant_shipment_history (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id           uuid        NOT NULL,
  provider              text        NOT NULL,
  tracking              text        NOT NULL,
  order_id              text,                        -- Yalidine order_id (often = wc_order_id)
  wc_order_id           text,                        -- WooCommerce order ID, set when linked

  -- Customer identity: dual-track (WooCommerce real vs Yalidine masked)
  identity_id           uuid        REFERENCES customer_identity (id) ON DELETE SET NULL,
  phone_hash            text,                        -- HMAC of real phone (WC) or masked string
  phone_source          text        NOT NULL DEFAULT 'unknown',
  --   'woocommerce'     — real phone from customer_identity_link
  --   'yalidine_masked' — masked string hashed as-is ("0*****5")
  --   'yalidine_real'   — unmasked from GET /v1/parcels/:tracking (if confirmed available)
  --   'unknown'         — not yet determined
  phone_masked          text,                        -- "0*****5" display value from API
  customer_name_masked  text,                        -- "B***h" display value from API

  -- Destination
  wilaya_id             integer,
  wilaya_name           text,
  commune_name          text,
  is_stopdesk           boolean,
  stopdesk_id           integer,

  -- Financials
  cod_amount            numeric(12, 2),
  delivery_fee          numeric(12, 2),
  has_recouvrement      boolean,

  -- Current status (snapshot of latest known state)
  last_status           text,                        -- raw French string from API
  normalized_status     text,                        -- DELIVERED/RETURNED/REFUSED/PENDING/etc.
  normalized_outcome    text,                        -- DELIVERED/REFUSED/NO_ANSWER/RETURNED/etc.
  parcel_sub_type       text,                        -- "exchange" or null
  has_exchange          boolean,

  -- Provider timestamps
  date_creation         timestamptz,
  date_expedition       timestamptz,
  date_last_status      timestamptz,

  -- Payment
  payment_status        text,                        -- "not-ready" / "ready" / "payed"
  payment_id            text,

  -- Record metadata
  raw_payload           jsonb       NOT NULL DEFAULT '{}',
  first_seen_at         timestamptz NOT NULL DEFAULT now(),  -- set on INSERT; never updated
  last_synced_at        timestamptz NOT NULL DEFAULT now(),  -- updated on every upsert
  deleted_at            timestamptz,                         -- soft-delete from parcel_deleted webhook

  CONSTRAINT merchant_shipment_history_pkey    PRIMARY KEY (id),
  CONSTRAINT merchant_shipment_history_unique  UNIQUE (merchant_id, provider, tracking)
);

-- Aggregation path: all shipments for an identity (used by reputation recompute)
CREATE INDEX IF NOT EXISTS msh_identity_idx
  ON merchant_shipment_history (merchant_id, identity_id)
  WHERE identity_id IS NOT NULL;

-- Reputation lookup: join to customer_identity_link by phone hash
CREATE INDEX IF NOT EXISTS msh_phone_hash_idx
  ON merchant_shipment_history (merchant_id, phone_hash)
  WHERE phone_hash IS NOT NULL;

-- Incremental sync: WHERE date_last_status >= anchor - 24h
CREATE INDEX IF NOT EXISTS msh_date_last_status_idx
  ON merchant_shipment_history (merchant_id, date_last_status);

-- Identity link resolution: match Yalidine order_id → wc_order_id
CREATE INDEX IF NOT EXISTS msh_wc_order_idx
  ON merchant_shipment_history (merchant_id, wc_order_id)
  WHERE wc_order_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 4. shipment_status_events
--    Append-only log of every status transition from GET /v1/histories.
--    Never updated. Unique constraint makes every insert idempotent.
--    The event timeline enables delivery attempt counting, time-to-delivery
--    analytics, and detailed fraud investigation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shipment_status_events (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id           uuid        NOT NULL,
  provider              text        NOT NULL,
  tracking              text        NOT NULL,
  status                text        NOT NULL,        -- raw string from /v1/histories
  normalized_status     text        NOT NULL,        -- DELIVERED/RETURNED/REFUSED/PENDING/etc.
  normalized_outcome    text,                        -- specific failure reason
  reason                text,                        -- raw reason field from histories API
  date_status           timestamptz NOT NULL,        -- when this status transition occurred
  source                text        NOT NULL,
  --   'history_api_bulk'     — written by full or incremental bulk sync
  --   'history_api_targeted' — written by a webhook-triggered targeted sync
  --   'parcel_snapshot'      — inferred from parcel snapshot when histories lags
  synced_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shipment_status_events_pkey   PRIMARY KEY (id),
  CONSTRAINT shipment_status_events_unique UNIQUE (merchant_id, provider, tracking, date_status, status)
);

-- Fast lookup: all events for a tracking (targeted sync, investigation)
CREATE INDEX IF NOT EXISTS sse_tracking_idx
  ON shipment_status_events (merchant_id, tracking);

-- Incremental events sync: WHERE date_status >= anchor - 24h
CREATE INDEX IF NOT EXISTS sse_date_status_idx
  ON shipment_status_events (merchant_id, date_status);


-- ---------------------------------------------------------------------------
-- 5. webhook_event_log
--    Raw audit log for every inbound Yalidine webhook event.
--    Written synchronously in the webhook handler (before the job is enqueued).
--    The unique constraint on event_id prevents duplicate processing.
--    skip_reason records why an event was not acted on immediately.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_event_log (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id     uuid        NOT NULL,
  provider        text        NOT NULL,
  event_type      text        NOT NULL,              -- "parcel_created" / "parcel_status_updated" / etc.
  event_id        text        NOT NULL,              -- derived: HMAC(tracking|event_type|date_last_status)
  tracking        text,
  raw_payload     jsonb       NOT NULL DEFAULT '{}',
  signature_valid boolean     NOT NULL DEFAULT false,
  processed       boolean     NOT NULL DEFAULT false,
  processed_at    timestamptz,
  skip_reason     text,                              -- "duplicate_event_id" | "targeted_sync_already_queued" | null
  error           text,
  received_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_event_log_pkey   PRIMARY KEY (id),
  CONSTRAINT webhook_event_log_unique UNIQUE (merchant_id, provider, event_id)
);

-- Job queue scan: find unprocessed events (not currently used — jobs are the queue)
CREATE INDEX IF NOT EXISTS wel_processed_received_idx
  ON webhook_event_log (merchant_id, processed, received_at);
