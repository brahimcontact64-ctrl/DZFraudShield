# Zaki — Architecture

## Overview

Zaki is a fraud prevention platform for Algerian WooCommerce merchants.
It consists of two deployable units:

| Unit | Location | Technology |
|------|----------|------------|
| SaaS Platform | `apps/saas/` | Next.js 14, TypeScript, Supabase |
| WordPress Plugin | `wordpress-plugin/dz-fraud-shield/` | PHP 8+, WooCommerce hooks |

---

## SaaS Platform (`apps/saas/`)

### Request flow

```
WooCommerce Checkout
  → WordPress Plugin (PHP)
    → POST /api/v1/check-order          (order risk evaluation)
    → POST /api/v1/plugin/delivery-price (COD delivery fee lookup)
    → POST /api/v1/category/sync         (product category sync)
    → POST /api/v1/plugin/ping           (heartbeat)
```

### Key systems

#### Risk Engine (`src/lib/risk/`)
Evaluates each order using multi-signal scoring:
- Phone reputation (cross-merchant network)
- IP / device fingerprint frequency
- Merchant-specific delivery history
- Global network signal aggregation

#### Delivery Intelligence (`src/lib/delivery-intelligence/`)
Manages integration with two delivery providers:
- **Yalidine** — fee cache, geo data, parcel creation, tracking
- **ZR Express** — same surface, separate adapter

Both adapters share the same interface via the delivery cache layer
(`delivery-cache.ts`, `global-delivery-cache.ts`).

#### Merchant Dashboard (`src/app/(dashboard)/dashboard/`)
Mobile-first PWA dashboard for merchants:
- Order check feed with risk decisions
- Shipment tracking and status
- Delivery provider management
- Call-center view
- Push notification settings

#### Admin Panel (`src/app/admin/`)
Internal owner-only tools:
- Merchant management
- Network intelligence
- Delivery cache admin
- Analytics AI / Strategy Engine
- Marketing Intelligence

#### Background Jobs (`src/lib/background-jobs.ts`)
Async jobs queued in `background_jobs` table, executed by the
`/api/v1/jobs/process-background` cron route (every minute on Vercel Pro).

Job types include: push notifications, reputation recomputation,
delivery sync, history sync, marketing enrichment.

### Authentication

- Merchants authenticate via Supabase Auth (magic link / email+password)
- Plugin → SaaS API uses HMAC-signed API keys stored in `merchant_api_keys`
- Admin routes protected by HTTP Basic Auth (`ADMIN_NETWORK_USER` / `ADMIN_NETWORK_PASSWORD`)
- Cron routes authenticated by `Authorization: Bearer <CRON_SECRET>`

### Database

Supabase Postgres with Row Level Security (RLS).
Schema defined in `supabase/migrations/`.

Key tables:
- `merchants`, `merchant_api_keys`
- `order_checks`, `order_decisions`, `merchant_decisions`
- `merchant_delivery_accounts`, `delivery_price_cache`
- `background_jobs`
- `merchant_push_subscriptions`, `merchant_notification_settings`
- `merchant_shipments`, `merchant_shipment_history`
- `customer_identities` (cross-merchant reputation network)

---

## WordPress Plugin (`wordpress-plugin/dz-fraud-shield/`)

Hooks into WooCommerce checkout to:
1. Call `/api/v1/check-order` before order placement
2. Fetch delivery fees from `/api/v1/plugin/delivery-price`
3. Block or flag high-risk orders
4. Sync product categories

---

## Data Flow Diagram

```
Browser / PWA
    │
    │  HTTPS
    ▼
Next.js API Routes (Vercel Edge / Node)
    │
    ├── Supabase (Postgres + Auth + RLS)
    │
    ├── Yalidine API    (delivery provider)
    ├── ZR Express API  (delivery provider)
    │
    └── Web Push (VAPID) → Browser / iOS Push Service
```
