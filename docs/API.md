# Zaki — API Reference

All routes are under `https://<app-url>/api/`.

## Authentication schemes

| Scheme | Used by |
|--------|---------|
| Supabase session cookie | Merchant dashboard routes (browser) |
| `Authorization: Bearer <api-key>` | WordPress plugin → SaaS routes |
| HTTP Basic Auth | `/admin/*` routes (owner only) |
| `Authorization: Bearer <CRON_SECRET>` | Vercel cron routes |

---

## Plugin API (`/api/v1/plugin/`)

Called by the WordPress plugin. Authenticated via HMAC-signed API key.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/plugin/ping` | Heartbeat — verify connectivity |
| POST | `/api/v1/plugin/activate` | Activate plugin / register merchant |
| POST | `/api/v1/plugin/onboarding-connect` | Complete onboarding connection |
| POST | `/api/v1/check-order` | Evaluate order risk (core endpoint) |
| POST | `/api/v1/plugin/delivery-price` | Fetch delivery fee for checkout |
| POST | `/api/v1/plugin/delivery-cache` | Query cached delivery data |
| POST | `/api/v1/category/sync` | Sync WooCommerce product categories |
| POST | `/api/v1/plugin/sync-fees` | Sync delivery fee schedules |
| POST | `/api/v1/plugin/sync-departure-center` | Sync departure center ID |
| POST | `/api/v1/plugin/merchant-decision-sync` | Pull merchant decisions to plugin |
| POST | `/api/v1/plugin/merchant-decision-actions` | Push decision actions to SaaS |
| POST | `/api/v1/plugin/product-intel` | Push product intelligence data |
| POST | `/api/v1/report-outcome` | Report actual order outcome (delivered/returned) |

---

## Merchant Dashboard API (`/api/v1/merchant/` and `/api/v1/orders/`)

Authenticated via Supabase session. All responses are merchant-scoped.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/orders/[checkId]/action` | Get available actions for an order |
| POST | `/api/v1/orders/[checkId]/action` | Execute action on an order |
| GET/POST | `/api/v1/merchant-decisions` | List / create merchant decisions |
| GET | `/api/v1/merchant-decisions/[id]` | Get a specific decision |
| GET | `/api/v1/merchant/notifications` | List notifications |
| GET | `/api/v1/merchant/notifications/[id]` | Get a notification |
| GET/POST | `/api/v1/merchant/notification-settings` | Get / update notification preferences |
| GET | `/api/v1/merchant/payment-requests` | List payment requests |
| GET | `/api/v1/stats` | Dashboard statistics |

---

## Delivery API (`/api/v1/delivery/`)

Authenticated via Supabase session.

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/v1/delivery/accounts` | List / connect delivery accounts |
| POST | `/api/v1/delivery/accounts/disconnect` | Disconnect a delivery account |
| POST | `/api/v1/delivery/accounts/reconnect` | Reconnect a delivery account |
| GET | `/api/v1/delivery/providers` | List available delivery providers |
| GET | `/api/v1/delivery/summary` | Delivery KPI summary |
| GET/POST | `/api/v1/delivery/shipments` | List / create shipments |
| GET | `/api/v1/delivery/shipments/[id]/events` | Shipment tracking events |
| POST | `/api/v1/delivery/test-connection` | Test delivery account credentials |
| POST | `/api/v1/delivery/audit` | Audit delivery account state |
| GET | `/api/v1/delivery/merchant-sync/status` | Current sync status |
| POST | `/api/v1/delivery/merchant-sync/start` | Start merchant delivery sync |
| POST | `/api/v1/delivery/merchant-sync/stop` | Stop merchant delivery sync |
| POST | `/api/v1/delivery/merchant-sync/retry` | Retry failed sync |
| GET | `/api/v1/delivery/schedule` | Delivery fee schedule |
| GET/POST | `/api/v1/delivery/yalidine/shipping-origins` | Manage Yalidine shipping origins |
| GET | `/api/v1/delivery/yalidine/origin-options` | Yalidine origin options |

---

## PWA Push API (`/api/v1/pwa/push/`)

Authenticated via Supabase session.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/pwa/push/config` | Get VAPID public key |
| POST | `/api/v1/pwa/push/subscribe` | Register a push subscription |
| POST | `/api/v1/pwa/push/unsubscribe` | Remove a push subscription |
| GET | `/api/v1/pwa/push/verify` | Check subscription status |
| POST | `/api/v1/pwa/push/test` | Send a test notification (rate-limited: 3/hour) |
| POST | `/api/v1/pwa/push/events/click` | Record notification click telemetry |

---

## Background Job Routes (`/api/v1/jobs/`)

Authenticated via `Authorization: Bearer <CRON_SECRET>`. Called by Vercel cron.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/jobs/delivery-sync` | Run delivery status sync for all merchants |
| POST | `/api/v1/jobs/process-background` | Process pending background jobs queue |

---

## Admin API (`/api/v1/admin/`)

Authenticated via HTTP Basic Auth. Owner access only.

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/v1/admin/delivery-cache/*` | Global delivery cache management |
| GET/POST | `/api/v1/admin/delivery-intelligence/*` | MDI sync and health |
| GET/POST | `/api/v1/admin/marketing-intelligence/*` | Marketing intelligence pipeline |
| GET/POST | `/api/v1/admin/merchants/[id]/actions` | Merchant admin actions |
| GET/POST | `/api/v1/admin/network/*` | Network sync and monitoring |
| GET/POST | `/api/v1/admin/payment-requests/*/review` | Payment request review |
| GET/POST | `/api/v1/admin/payment-settings` | Platform payment settings |
| POST | `/api/v1/admin/early-adopter` | Early adopter management |

---

## Webhooks (`/api/webhooks/`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks/yalidine` | Inbound Yalidine status webhook |
| POST | `/api/v1/delivery/webhooks/[provider]` | Generic provider webhook |

---

## Internal / Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/internal/health` | Service health check |
| GET | `/api/v1/internal/diagnostics` | Diagnostics (admin-only) |
| GET | `/api/auth/session` | Current session info |

---

## Response conventions

All endpoints return JSON. Error responses follow:

```json
{ "error": "Human-readable message" }
```

Success responses include an `ok: true` field or the requested data object.
HTTP status codes: 200 (success), 400 (validation), 401 (auth), 403 (forbidden),
429 (rate limit), 500 (server error), 503 (service unavailable).
