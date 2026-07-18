# Zaki — Troubleshooting Guide

## SaaS platform issues

### Build fails with "Missing required env var"

The Next.js build requires `NEXT_PUBLIC_*` variables at build time. Ensure these are set in Vercel project settings or your `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_APP_URL
```

---

### API returns 401 (Unauthorized)

**Merchant dashboard routes:** Session cookie has expired. The user needs to log in again.

**Plugin routes:** The merchant's API key is invalid or has been revoked. Steps:
1. In the Zaki dashboard → Settings → regenerate the API key
2. Paste the new key into WooCommerce → DZ Fraud Shield → Settings

---

### Cron jobs not running

**Symptom:** Delivery sync not updating; push notifications not sending.

**Diagnosis:**
```bash
curl -X POST https://your-app.vercel.app/api/v1/jobs/process-background \
  -H "Authorization: Bearer <CRON_SECRET>"
```

**Causes:**
- Vercel free tier: cron minimum interval is 60 minutes; `* * * * *` schedule requires Vercel Pro
- Wrong `CRON_SECRET` in environment variables
- Route error — check Vercel function logs

---

### Push notifications not arriving

1. Check that `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set and match (same key pair)
2. The browser subscription must use the same VAPID public key — if you rotated keys, users must re-subscribe
3. Test the pipeline: Dashboard → Settings → Notifications → Send test notification
4. Check background jobs queue: look for failed jobs in `background_jobs` table in Supabase

---

### Delivery prices showing as 0 or N/A

**Symptom:** Checkout shows no delivery price or incorrect price.

**Diagnosis:**
1. WooCommerce → DZ Fraud Shield → Test Connection — verify the SaaS is reachable
2. Check that the merchant has connected a delivery account (Dashboard → Delivery Providers)
3. Verify the delivery cache was populated: Dashboard → Delivery → Sync Now
4. Check `delivery_price_cache` table in Supabase for the merchant's wilaya

---

### `DELIVERY_ACCOUNT_ENCRYPTION_KEY` changed — all credentials unreadable

If this key was rotated unintentionally:
1. Revert the key to the previous value
2. Merchants can reconnect their delivery accounts from the dashboard
3. There is no automatic recovery — the encryption is one-way

---

## WordPress plugin issues

### Plugin settings page shows "Connection failed"

1. Verify the SaaS API URL has no trailing slash
2. Verify the API key is correct (copy from Zaki dashboard)
3. Check that the SaaS is deployed and healthy: `curl https://your-app.vercel.app/api/v1/internal/health`
4. Check WordPress error logs (`wp-content/debug.log` if `WP_DEBUG_LOG` is enabled)

---

### Checkout delivery price not updating

1. Clear the WordPress object cache (if using a caching plugin like WP Rocket or W3 Total Cache)
2. Clear the plugin's local delivery cache: WooCommerce → DZ Fraud Shield → Clear Cache
3. Force a fresh sync: Dashboard → Delivery → Sync All Communes

---

### Orders being blocked incorrectly (false positives)

1. Check the order's risk details in WooCommerce → Orders → [order] → DZ Fraud Shield panel
2. Review the risk signals shown (phone reputation, frequency, etc.)
3. Adjust risk thresholds in Dashboard → Settings → Risk Engine
4. Override individual orders: Dashboard → Orders → [order] → Approve

---

## Database issues

### Supabase migration fails

```bash
# Check current migration state
supabase migration list

# Apply pending migrations
supabase db push

# If a migration is stuck, check for locks:
# In Supabase SQL editor:
SELECT * FROM pg_locks pl JOIN pg_stat_activity psa ON pl.pid = psa.pid WHERE NOT granted;
```

---

### RLS blocking a query

If you see `permission denied for table` in server logs:

1. This is expected behavior — confirm the user is authenticated
2. If it's a server-side query with the service role key, ensure you're using `createServiceClient()` not `createBrowserClient()`
3. Check that the service role key is set in `SUPABASE_SERVICE_ROLE_KEY` (not the anon key)

---

## Local development issues

### `npm run dev` fails with "port 3000 already in use"

```bash
# Kill the process on port 3000
npx kill-port 3000
# Then retry
npm run dev
```

### TypeScript errors after pulling

```bash
cd apps/saas
rm -f tsconfig.tsbuildinfo
npm run typecheck
```

### Tests failing locally but passing in CI

Most common cause: ICU locale differences between Windows and Linux.
Date/time format tests use platform-agnostic assertions (check for substrings like `"28"` not full formatted strings). If you add new date format tests, follow this pattern.
