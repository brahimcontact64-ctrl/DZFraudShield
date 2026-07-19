# Zaki — Deployment Guide

## SaaS Platform — Vercel

The SaaS app (`apps/saas/`) is deployed on **Vercel**.

### Prerequisites

- Vercel account with **Pro plan** (required for cron jobs running every minute)
- Supabase project with migrations applied
- VAPID key pair generated

### Environment variables

Set all variables from [Environment.md](./Environment.md) in:
`Vercel Dashboard → Project → Settings → Environment Variables`

### Deploy

```bash
# From apps/saas/
npm run build   # Verify build passes locally first
# Push to main branch → Vercel auto-deploys
```

Or via Vercel CLI:
```bash
npx vercel --prod
```

### Cron jobs (vercel.json)

```json
{
  "crons": [
    { "path": "/api/v1/jobs/delivery-sync",      "schedule": "*/15 * * * *" },
    { "path": "/api/v1/jobs/process-background", "schedule": "* * * * *" }
  ]
}
```

- `delivery-sync` — runs every 15 minutes, syncs delivery status for active shipments
- `process-background` — runs every minute, processes the `background_jobs` queue

> **Vercel Pro required** — the `* * * * *` (every minute) schedule requires
> Vercel Pro. On the free tier, minimum interval is 60 minutes.

Vercel authenticates cron invocations with `Authorization: Bearer <CRON_SECRET>`.

### Build settings (Vercel dashboard)

| Setting | Value |
|---------|-------|
| Framework preset | Next.js |
| Root directory | `apps/saas` |
| Build command | `npm run build` |
| Output directory | *(leave default — do not override)* |
| Install command | `npm install` |
| Node.js version | 20.x |

> **Do not set a custom `distDir`** in `next.config.mjs` and do not override
> "Output Directory" in the Vercel dashboard. Vercel's Next.js Runtime always
> looks for build output in `.next` and ignores a custom Output Directory
> setting for the Next.js framework preset — a non-default `distDir` will
> build successfully but fail at deploy time with "output directory '.next'
> was not found". The Docker build (`docker/Dockerfile`) uses its own
> `BUILD_STANDALONE=1` standalone output under `.next/standalone`, which is
> unaffected by this.

---

## Database — Supabase

Apply migrations in order:

```bash
# Using Supabase CLI
supabase db push

# Or manually in the Supabase SQL editor:
# Execute each file in supabase/migrations/ in filename order
```

Enable Row Level Security (RLS) on all tables — enforced by the migrations.

---

## WordPress Plugin

1. Build the plugin zip: run the packaging script from `scripts/` or zip
   `wordpress-plugin/dz-fraud-shield/` directly.
2. Upload via WooCommerce → Plugins → Add New → Upload Plugin.
3. Activate the plugin.
4. Navigate to WooCommerce → DZ Fraud Shield → Settings.
5. Enter the SaaS API URL and the merchant's API key.

---

## Health checks

After deployment, verify:

```bash
# SaaS health
curl https://your-app.vercel.app/api/v1/internal/health

# Plugin connectivity (from WP admin → DZ Fraud Shield → Settings → Test connection)
curl -X POST https://your-app.vercel.app/api/v1/plugin/ping \
  -H "Authorization: Bearer <api-key>"
```

---

## Rollback

- **Vercel:** use the Deployments tab to instantly promote a previous deployment.
- **Database:** Supabase does not auto-rollback migrations. Keep migration files
  additive; use separate down-migration scripts if needed.
