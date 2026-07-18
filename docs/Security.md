# Zaki — Security Reference

## Secrets inventory

| Secret | Where stored | Impact if compromised |
|--------|-------------|----------------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env / `.env.local` | Full database access, bypasses RLS |
| `VAPID_PRIVATE_KEY` | Vercel env / `.env.local` | Can impersonate push sender; rotate + re-subscribe users |
| `API_KEY_SIGNING_SECRET` | Vercel env / `.env.local` | Can forge merchant API keys; rotate immediately |
| `PHONE_HASH_SECRET` | Vercel env / `.env.local` | Reputation matching broken until re-hash migration |
| `DELIVERY_ACCOUNT_ENCRYPTION_KEY` | Vercel env / `.env.local` | All stored delivery credentials unreadable |
| `CRON_SECRET` | Vercel env / `.env.local` | Attacker can trigger cron endpoints |
| `ADMIN_NETWORK_PASSWORD` | Vercel env / `.env.local` | Access to admin panel |

**Never commit any of these to version control.**

---

## Authentication model

### Merchant-facing routes
- Supabase Auth session cookie (HTTP-only, sameSite=lax)
- Row Level Security (RLS) enforced at DB layer — merchants can only read their own data
- Session validated server-side on every API route using `createServerClient`

### WordPress plugin → SaaS
- HMAC-SHA256 signed API keys stored in `merchant_api_keys`
- Keys are verified using `API_KEY_SIGNING_SECRET`
- Each request must include `Authorization: Bearer <key>`
- Keys are merchant-scoped: wrong key → 401

### Admin routes (`/api/v1/admin/*`, `/admin/*`)
- HTTP Basic Auth with `ADMIN_NETWORK_USER` / `ADMIN_NETWORK_PASSWORD`
- Separate from merchant auth
- Used only by the platform operator

### Cron routes (`/api/v1/jobs/*`)
- `Authorization: Bearer <CRON_SECRET>`
- Vercel sends this header automatically; third parties cannot trigger cron endpoints without the secret

---

## Input validation

- All inbound payloads parsed with type guards before use
- Phone numbers normalized then hashed — raw numbers never stored in network reputation tables
- Delivery account credentials AES-256 encrypted before DB storage using `DELIVERY_ACCOUNT_ENCRYPTION_KEY`
- Open-redirect guard in Service Worker: only root-relative paths allowed (`/path`, not `//evil.com`)

---

## Rate limiting

- Push notification test endpoint: 3 requests per hour per merchant
- Rate limiting implemented via `lib/security/rate-limit.ts` using Supabase as backing store

---

## Security checklist for PRs

Before merging any PR:

- [ ] No secrets, API keys, or credentials in source code or `.env.example`
- [ ] No `console.log` in client-side code (leaks state to browser console)
- [ ] New API routes check auth before doing anything
- [ ] New DB tables have RLS policies defined
- [ ] User-supplied input is validated before use
- [ ] No SQL string concatenation (use Supabase query builder)

---

## Rotating secrets

See [Environment.md](./Environment.md) for rotation commands and impact table.

If `VAPID_PRIVATE_KEY` is rotated:
1. Generate new key pair: `bash scripts/generate-vapid.sh`
2. Update Vercel env vars
3. Redeploy
4. All push subscriptions are now invalid — notify users to re-enable notifications

If `API_KEY_SIGNING_SECRET` is rotated:
1. Update Vercel env var
2. Redeploy
3. All existing merchant API keys are invalidated
4. Each merchant must regenerate their key from the dashboard

---

## Known non-vulnerabilities (intentional design)

- `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` are intentionally public — they are designed to be exposed to the browser
- `NEXT_PUBLIC_SUPABASE_URL` is intentionally public — it's just the project URL
