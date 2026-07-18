-- =============================================================================
-- Marketing Intelligence
-- Migration: 20260711000001
--
-- Creates six tables for the DZ Fraud Shield Product Intelligence backend:
--
--   1. marketing_products               — canonical product per merchant+source
--   2. marketing_product_variants       — WooCommerce variation records
--   3. marketing_product_order_lines    — one immutable row per order line item
--   4. marketing_product_wilaya_statistics — per product+variant+wilaya aggregates
--   5. marketing_product_statistics     — per product+variant overall aggregates
--   6. marketing_ingestion_log          — per-merchant ingestion state
--
-- VISIBILITY: admin-only. No merchant-facing tables, routes, or UI.
--
-- PRODUCT FINGERPRINT FALLBACK:
--   When a WooCommerce product_id is unavailable, the plugin sends a
--   deterministic fingerprint as external_product_id:
--     'fp:' || sha256(lower(trim(product_name)))
--   This keeps the UNIQUE (merchant_id, commerce_source, external_product_id)
--   constraint stable across re-submissions of the same product by name.
--
-- STATISTICS FORMULAS:
--   delivery_success_rate =
--     delivered_orders::numeric /
--     NULLIF(delivered_orders + returned_orders + refused_orders
--            + cancelled_orders + no_answer_orders, 0)
--   Pending orders are excluded from the denominator.
--   gross_sales     = SUM(line_total) across all orders for the product
--   delivered_sales = SUM(line_total) WHERE delivery_outcome = 'DELIVERED'
--   returned_sales  = SUM(line_total) WHERE delivery_outcome IN ('RETURNED','REFUSED')
--
-- BEST/WORST WILAYA THRESHOLD:
--   A wilaya requires >= 3 terminal-outcome orders to qualify for ranking.
--   Wilayas below this threshold are excluded from best_wilaya / worst_wilaya.
--
-- NULL-SAFE UNIQUENESS FOR NULLABLE variant_id:
--   Tables 4 and 5 have a nullable variant_id. PostgreSQL treats two NULLs
--   as NOT DISTINCT in standard UNIQUE constraints since PG15, but expression-
--   based uniqueness (COALESCE sentinel) is more portable and explicit.
--
--   IMPORTANT: PostgreSQL does NOT allow function expressions (e.g. COALESCE)
--   inside a table-level UNIQUE constraint (CREATE TABLE ... UNIQUE(...)).
--   Only column names are permitted there.
--
--   The correct PostgreSQL way to express expression-based uniqueness is a
--   standalone:
--     CREATE UNIQUE INDEX name ON table (expression, column, ...);
--
--   Tables 4 and 5 therefore have NO inline UNIQUE constraint for variant_id.
--   Their uniqueness is enforced by UNIQUE INDEXes created after the table.
--   The application writer uses DELETE + INSERT (never ON CONFLICT) for these
--   tables, so the index does not need to be PostgREST-targetable.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. marketing_products
--    One canonical product record per (merchant_id, commerce_source, external_product_id).
--    Updated when new metadata arrives; does NOT rewrite historical order-line snapshots.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_products (
  id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id                 uuid        NOT NULL,
  commerce_source             text        NOT NULL DEFAULT 'woocommerce',
  external_product_id         text        NOT NULL,
  parent_external_product_id  text        NULL,
  sku                         text        NULL,
  product_name                text        NOT NULL,
  product_slug                text        NULL,
  category_id                 text        NULL,
  category_name               text        NULL,
  brand                       text        NULL,
  tags                        jsonb       NOT NULL DEFAULT '[]',
  product_type                text        NULL,
  primary_image_url           text        NULL,
  gallery_image_urls          jsonb       NOT NULL DEFAULT '[]',
  regular_price               numeric     NULL,
  sale_price                  numeric     NULL,
  currency                    text        NULL,
  attributes                  jsonb       NOT NULL DEFAULT '{}',
  active                      boolean     NOT NULL DEFAULT true,
  first_seen_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at                timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_products_pkey   PRIMARY KEY (id),
  -- Plain column-name UNIQUE: valid in table definition.
  CONSTRAINT marketing_products_unique UNIQUE (merchant_id, commerce_source, external_product_id)
);

-- Query: products by merchant
CREATE INDEX IF NOT EXISTS marketing_products_merchant_idx
  ON marketing_products (merchant_id);

-- Query: products by category within merchant
CREATE INDEX IF NOT EXISTS marketing_products_category_idx
  ON marketing_products (merchant_id, category_name)
  WHERE category_name IS NOT NULL;

-- Query: products by brand within merchant
CREATE INDEX IF NOT EXISTS marketing_products_brand_idx
  ON marketing_products (merchant_id, brand)
  WHERE brand IS NOT NULL;

-- Query: products by SKU within merchant
CREATE INDEX IF NOT EXISTS marketing_products_sku_idx
  ON marketing_products (merchant_id, sku)
  WHERE sku IS NOT NULL;

-- Query: GIN index for attribute lookups (jsonb containment operators)
CREATE INDEX IF NOT EXISTS marketing_products_attributes_gin
  ON marketing_products USING GIN (attributes);


-- ---------------------------------------------------------------------------
-- 2. marketing_product_variants
--    One record per WooCommerce variation. References a parent product.
--    Tracks variation-specific price, image, and attribute metadata.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_product_variants (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  product_id              uuid        NULL,        -- SET NULL on product delete
  merchant_id             uuid        NOT NULL,
  commerce_source         text        NOT NULL DEFAULT 'woocommerce',
  external_variation_id   text        NOT NULL,
  sku                     text        NULL,
  variation_name          text        NULL,
  color                   text        NULL,
  size                    text        NULL,
  material                text        NULL,
  attributes              jsonb       NOT NULL DEFAULT '{}',
  regular_price           numeric     NULL,
  sale_price              numeric     NULL,
  primary_image_url       text        NULL,
  active                  boolean     NOT NULL DEFAULT true,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_product_variants_pkey   PRIMARY KEY (id),
  -- Plain column-name UNIQUE: valid in table definition.
  CONSTRAINT marketing_product_variants_unique UNIQUE (merchant_id, commerce_source, external_variation_id),

  -- Variant loses its product reference if the product is deleted, but is NOT deleted itself.
  CONSTRAINT marketing_product_variants_product_fk
    FOREIGN KEY (product_id) REFERENCES marketing_products (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS marketing_product_variants_product_idx
  ON marketing_product_variants (product_id)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS marketing_product_variants_merchant_idx
  ON marketing_product_variants (merchant_id);

CREATE INDEX IF NOT EXISTS marketing_product_variants_attributes_gin
  ON marketing_product_variants USING GIN (attributes);


-- ---------------------------------------------------------------------------
-- 3. marketing_product_order_lines
--    One IMMUTABLE record per order line item.
--    Preserves product metadata snapshot at order time.
--    Delivery outcome fields are enriched later via the MDI pipeline.
--
--    IDEMPOTENCY: UNIQUE (merchant_id, commerce_source, external_order_id, external_line_item_id)
--    Re-running ingestion for the same order never creates duplicate rows.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_product_order_lines (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id             uuid        NOT NULL,
  commerce_source         text        NOT NULL DEFAULT 'woocommerce',
  external_order_id       text        NOT NULL,
  external_line_item_id   text        NOT NULL,

  -- References to canonical tables (nullable: ON DELETE SET NULL preserves history)
  product_id              uuid        NULL,
  variant_id              uuid        NULL,
  shipment_history_id     uuid        NULL,
  delivery_order_id       uuid        NULL,

  -- Product snapshot (captured at order time, never rewritten)
  external_product_id     text        NULL,
  external_variation_id   text        NULL,
  sku_snapshot            text        NULL,
  product_name_snapshot   text        NOT NULL,
  category_snapshot       text        NULL,
  brand_snapshot          text        NULL,
  image_url_snapshot      text        NULL,
  attributes_snapshot     jsonb       NOT NULL DEFAULT '{}',

  -- Commercial snapshot (captured at order time)
  quantity                integer     NOT NULL DEFAULT 1,
  unit_price              numeric     NULL,
  regular_price_snapshot  numeric     NULL,
  sale_price_snapshot     numeric     NULL,
  line_subtotal           numeric     NULL,
  line_total              numeric     NULL,
  discount_amount         numeric     NULL,
  currency                text        NULL,

  -- Regional and delivery context (enriched by MDI pipeline)
  delivery_provider       text        NULL,
  tracking                text        NULL,
  wilaya                  text        NULL,
  commune                 text        NULL,
  delivery_type           text        NULL,
  is_stopdesk             boolean     NULL,
  delivery_status         text        NULL,
  delivery_outcome        text        NULL,

  -- Dates
  order_date              timestamptz NULL,
  shipment_date           timestamptz NULL,
  delivery_date           timestamptz NULL,
  last_status_date        timestamptz NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_product_order_lines_pkey   PRIMARY KEY (id),
  -- Plain column-name UNIQUE: valid in table definition.
  -- The application upserts with onConflict targeting exactly these four columns.
  CONSTRAINT marketing_product_order_lines_unique UNIQUE (
    merchant_id, commerce_source, external_order_id, external_line_item_id
  ),

  -- Order-line history is preserved even if canonical product/variant is removed.
  CONSTRAINT marketing_product_order_lines_product_fk
    FOREIGN KEY (product_id) REFERENCES marketing_products (id) ON DELETE SET NULL,
  CONSTRAINT marketing_product_order_lines_variant_fk
    FOREIGN KEY (variant_id) REFERENCES marketing_product_variants (id) ON DELETE SET NULL
);

-- Query: order lines by merchant + order
CREATE INDEX IF NOT EXISTS marketing_pol_merchant_order_idx
  ON marketing_product_order_lines (merchant_id, external_order_id);

-- Query: order lines by product (for statistics recompute)
CREATE INDEX IF NOT EXISTS marketing_pol_product_idx
  ON marketing_product_order_lines (product_id)
  WHERE product_id IS NOT NULL;

-- Query: order lines by shipment history (for delivery enrichment)
CREATE INDEX IF NOT EXISTS marketing_pol_shipment_history_idx
  ON marketing_product_order_lines (shipment_history_id)
  WHERE shipment_history_id IS NOT NULL;

-- Query: order lines by tracking (delivery enrichment path)
CREATE INDEX IF NOT EXISTS marketing_pol_tracking_idx
  ON marketing_product_order_lines (merchant_id, tracking)
  WHERE tracking IS NOT NULL;

-- Query: order lines by wilaya (regional analytics)
CREATE INDEX IF NOT EXISTS marketing_pol_wilaya_idx
  ON marketing_product_order_lines (merchant_id, wilaya)
  WHERE wilaya IS NOT NULL;

-- Query: order lines by delivery outcome (success rate, returned sales)
CREATE INDEX IF NOT EXISTS marketing_pol_outcome_idx
  ON marketing_product_order_lines (merchant_id, delivery_outcome)
  WHERE delivery_outcome IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 4. marketing_product_wilaya_statistics
--    Full-rebuild recomputed per (merchant_id, product_id, variant_id, wilaya).
--
--    NULL-SAFE UNIQUENESS — WHY NO INLINE UNIQUE CONSTRAINT HERE:
--    variant_id is nullable. A table-level UNIQUE(...) in PostgreSQL only accepts
--    column names, NOT expressions. Writing:
--      CONSTRAINT x UNIQUE (col, COALESCE(variant_id, sentinel_uuid), col)
--    produces: ERROR 42601: syntax error at or near "("
--
--    The correct approach is a standalone CREATE UNIQUE INDEX that CAN contain
--    expressions. It is created immediately after this CREATE TABLE statement.
--
--    The sentinel UUID '00000000-0000-0000-0000-000000000000' is used in the
--    COALESCE so that every row produces a non-NULL key value, guaranteeing
--    that two rows with variant_id IS NULL are still treated as duplicates for
--    the same (merchant_id, product_id, wilaya) combination.
--
--    ON CONFLICT compatibility:
--    Expression-based unique indexes cannot be targeted by PostgREST / Supabase
--    JS onConflict (which requires plain column names matching a table constraint).
--    The application writer uses DELETE + INSERT (full rebuild) for this table,
--    so ON CONFLICT is not needed. The unique index still enforces data integrity
--    at the database level.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_product_wilaya_statistics (
  merchant_id             uuid        NOT NULL,
  product_id              uuid        NOT NULL,
  variant_id              uuid        NULL,
  wilaya                  text        NOT NULL,
  total_orders            integer     NOT NULL DEFAULT 0,
  total_units             integer     NOT NULL DEFAULT 0,
  delivered_orders        integer     NOT NULL DEFAULT 0,
  returned_orders         integer     NOT NULL DEFAULT 0,
  refused_orders          integer     NOT NULL DEFAULT 0,
  cancelled_orders        integer     NOT NULL DEFAULT 0,
  no_answer_orders        integer     NOT NULL DEFAULT 0,
  pending_orders          integer     NOT NULL DEFAULT 0,
  delivery_success_rate   numeric     NOT NULL DEFAULT 0,
  gross_sales             numeric     NOT NULL DEFAULT 0,
  delivered_sales         numeric     NOT NULL DEFAULT 0,
  returned_sales          numeric     NOT NULL DEFAULT 0,
  average_unit_price      numeric     NULL,
  first_order_at          timestamptz NULL,
  last_order_at           timestamptz NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Foreign keys only — NO inline UNIQUE here (see comment above).
  CONSTRAINT marketing_pwstat_product_fk
    FOREIGN KEY (product_id) REFERENCES marketing_products (id) ON DELETE CASCADE,
  CONSTRAINT marketing_pwstat_variant_fk
    FOREIGN KEY (variant_id) REFERENCES marketing_product_variants (id) ON DELETE SET NULL
);

-- NULL-safe uniqueness via COALESCE expression.
-- COALESCE maps NULL variant_id to a sentinel UUID so that two rows with
-- variant_id IS NULL produce the same key value and are correctly rejected
-- as duplicates.
-- CREATE UNIQUE INDEX (unlike table UNIQUE constraint) accepts full expressions.
CREATE UNIQUE INDEX IF NOT EXISTS marketing_pwstat_unique
  ON marketing_product_wilaya_statistics (
    merchant_id,
    product_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    wilaya
  );

-- Query: statistics by product+wilaya (main analytics query)
CREATE INDEX IF NOT EXISTS marketing_pwstat_product_wilaya_idx
  ON marketing_product_wilaya_statistics (product_id, wilaya);

-- Query: best/worst wilaya (ranked by success rate)
CREATE INDEX IF NOT EXISTS marketing_pwstat_success_rate_idx
  ON marketing_product_wilaya_statistics (merchant_id, delivery_success_rate DESC);

-- Query: gross sales ranking
CREATE INDEX IF NOT EXISTS marketing_pwstat_gross_sales_idx
  ON marketing_product_wilaya_statistics (merchant_id, gross_sales DESC);


-- ---------------------------------------------------------------------------
-- 5. marketing_product_statistics
--    One aggregate row per (merchant_id, product_id, variant_id).
--    Full-rebuild recomputed; never blindly incremented to ensure idempotency.
--
--    Same NULL-safe uniqueness pattern as table 4: expression-based
--    CREATE UNIQUE INDEX replaces the invalid inline UNIQUE(...COALESCE...).
--
--    best_wilaya:  wilaya with highest delivery_success_rate AND >= 3 terminal orders
--    worst_wilaya: wilaya with lowest  delivery_success_rate AND >= 3 terminal orders
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_product_statistics (
  merchant_id             uuid        NOT NULL,
  product_id              uuid        NOT NULL,
  variant_id              uuid        NULL,
  total_orders            integer     NOT NULL DEFAULT 0,
  total_units             integer     NOT NULL DEFAULT 0,
  delivered_orders        integer     NOT NULL DEFAULT 0,
  returned_orders         integer     NOT NULL DEFAULT 0,
  refused_orders          integer     NOT NULL DEFAULT 0,
  cancelled_orders        integer     NOT NULL DEFAULT 0,
  no_answer_orders        integer     NOT NULL DEFAULT 0,
  pending_orders          integer     NOT NULL DEFAULT 0,
  delivery_success_rate   numeric     NOT NULL DEFAULT 0,
  gross_sales             numeric     NOT NULL DEFAULT 0,
  delivered_sales         numeric     NOT NULL DEFAULT 0,
  returned_sales          numeric     NOT NULL DEFAULT 0,
  average_unit_price      numeric     NULL,
  best_wilaya             text        NULL,
  worst_wilaya            text        NULL,
  top_wilayas             jsonb       NOT NULL DEFAULT '[]',
  first_order_at          timestamptz NULL,
  last_order_at           timestamptz NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Foreign keys only — NO inline UNIQUE here (see comment above).
  CONSTRAINT marketing_pstat_product_fk
    FOREIGN KEY (product_id) REFERENCES marketing_products (id) ON DELETE CASCADE,
  CONSTRAINT marketing_pstat_variant_fk
    FOREIGN KEY (variant_id) REFERENCES marketing_product_variants (id) ON DELETE SET NULL
);

-- NULL-safe uniqueness via COALESCE expression (same pattern as table 4).
CREATE UNIQUE INDEX IF NOT EXISTS marketing_pstat_unique
  ON marketing_product_statistics (
    merchant_id,
    product_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Query: statistics by product
CREATE INDEX IF NOT EXISTS marketing_pstat_product_idx
  ON marketing_product_statistics (product_id);

-- Query: ranked by success rate (admin analytics)
CREATE INDEX IF NOT EXISTS marketing_pstat_success_rate_idx
  ON marketing_product_statistics (merchant_id, delivery_success_rate DESC);

-- Query: ranked by gross sales
CREATE INDEX IF NOT EXISTS marketing_pstat_gross_sales_idx
  ON marketing_product_statistics (merchant_id, gross_sales DESC);


-- ---------------------------------------------------------------------------
-- 6. marketing_ingestion_log
--    One row per merchant+source. Tracks last ingestion time, counts, errors.
--    Used by the Ingestion Health admin tab.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_ingestion_log (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid(),
  merchant_id             uuid        NOT NULL,
  commerce_source         text        NOT NULL DEFAULT 'woocommerce',
  last_ingestion_at       timestamptz NULL,
  products_imported       integer     NOT NULL DEFAULT 0,
  order_lines_imported    integer     NOT NULL DEFAULT 0,
  last_backfill_at        timestamptz NULL,
  backfill_status         text        NULL,        -- 'pending' | 'running' | 'completed' | 'failed'
  backfill_cursor         text        NULL,        -- created_at cursor for resumable backfill
  last_error              text        NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_ingestion_log_pkey   PRIMARY KEY (id),
  -- Plain column-name UNIQUE: valid in table definition.
  -- The application upserts with onConflict: "merchant_id,commerce_source".
  CONSTRAINT marketing_ingestion_log_unique UNIQUE (merchant_id, commerce_source)
);

CREATE INDEX IF NOT EXISTS marketing_ingestion_log_merchant_idx
  ON marketing_ingestion_log (merchant_id);
