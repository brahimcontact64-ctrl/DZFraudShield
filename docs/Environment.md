# Zaki — Environment Variables

All environment variables are set in `.env.local` for local development and
in the Vercel project settings for production. Never commit secrets.

## Quick setup

```bash
cp .env.example apps/saas/.env.local
# Fill in values from your Supabase project and generate secrets below
```

---

## Variables Reference

### Supabase

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Full Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Same URL — exposed to browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key — server-only, never expose to browser |

### Security & Signing

| Variable | Required | Description |
|----------|----------|-------------|
| `API_KEY_SIGNING_SECRET` | ✅ | HMAC secret for signing merchant API keys. Generate: `openssl rand -hex 32` |
| `PHONE_HASH_SECRET` | ✅ | Salt for hashing phone numbers in the reputation network. Generate: `openssl rand -hex 32` |
| `DELIVERY_ACCOUNT_ENCRYPTION_KEY` | ✅ | AES-256 key (64 hex chars) for encrypting delivery provider credentials. Generate: `openssl rand -hex 32` |
| `CRON_SECRET` | ✅ | Bearer token Vercel sends to authenticate cron invocations. Generate: `openssl rand -hex 32` |
| `DELIVERY_SYNC_CRON_SECRET` | ⬜ | Alias for `CRON_SECRET`. Falls back to `CRON_SECRET` if unset. |
| `DELIVERY_WEBHOOK_SECRET` | ✅ | Shared secret for validating inbound delivery provider webhooks. |
| `BACKGROUND_JOBS_SECRET` | ✅ | Auth secret for the background job processing endpoint. |

### Web Push (VAPID)

| Variable | Required | Description |
|----------|----------|-------------|
| `VAPID_PUBLIC_KEY` | ✅ | VAPID public key — used server-side to sign push requests. |
| `VAPID_PRIVATE_KEY` | ✅ | VAPID private key — **server-only, never expose to browser**. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | ⬜ | Optional: expose public key directly to browser. If unset, the browser fetches it from `/api/v1/pwa/push/config`. |

Generate a VAPID key pair:
```bash
npx web-push generate-vapid-keys
```

> **Important:** If you rotate VAPID keys, all existing push subscriptions become invalid.
> All subscribed devices must re-subscribe.

### Admin

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_NETWORK_USER` | ✅ | HTTP Basic Auth username for `/admin/*` routes |
| `ADMIN_NETWORK_PASSWORD` | ✅ | HTTP Basic Auth password for `/admin/*` routes |

### Application

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_APP_URL` | ✅ | Public base URL of the app (e.g. `https://app.zaki.dz`) |

---

## Secrets rotation

| Secret | Impact of rotation |
|--------|--------------------|
| `VAPID_PRIVATE_KEY` | All push subscriptions invalidated — users must re-subscribe |
| `API_KEY_SIGNING_SECRET` | All merchant plugin API keys invalidated — merchants must regenerate |
| `PHONE_HASH_SECRET` | Phone-based reputation matching broken until re-hash migration runs |
| `DELIVERY_ACCOUNT_ENCRYPTION_KEY` | All stored delivery credentials unreadable — merchants must reconnect accounts |

Rotate secrets with caution and plan migrations accordingly.
