# Zaki — Release Process

## Versioning

Zaki uses **Semantic Versioning** (`MAJOR.MINOR.PATCH`):

| Bump | When |
|------|------|
| `PATCH` | Bug fixes, security patches, minor improvements |
| `MINOR` | New features, backwards-compatible changes |
| `MAJOR` | Breaking API changes, major architecture changes |

---

## Pre-release checklist

Before cutting a release:

- [ ] `npm run typecheck` passes (zero TypeScript errors)
- [ ] `npm run test` passes (no regressions)
- [ ] `npm run build` passes (clean production build)
- [ ] `npm run lint` passes (no lint errors)
- [ ] Environment variables documented in `docs/Environment.md`
- [ ] New API routes documented in `docs/API.md`
- [ ] DB migrations applied to production via `supabase db push`
- [ ] No secrets in source code or `.env.example`
- [ ] `CHANGELOG.md` updated in `wordpress-plugin/dz-fraud-shield/`

---

## SaaS release (Vercel)

```bash
# 1. Merge PR into main
git checkout main && git pull

# 2. Verify
npm run typecheck && npm run test && npm run build

# 3. Push to main triggers auto-deploy via GitHub Actions
git push origin main

# 4. Monitor Vercel deployment dashboard
# 5. Run production health check
curl https://your-app.vercel.app/api/v1/internal/health
```

### Rollback

In the Vercel dashboard → Deployments → select a previous deployment → **Promote to Production**.

---

## WordPress plugin release

```bash
# 1. Update version in dz-fraud-shield.php header
# 2. Update CHANGELOG.md

# 3. Package the plugin
bash scripts/package-plugin.sh 1.9.0

# 4. The zip is at: wordpress-plugin/releases/dz-fraud-shield-1.9.0.zip
# 5. Upload to WordPress admin or distribute to merchants
```

### Plugin compatibility table

| Plugin version | SaaS API version | WooCommerce |
|---------------|-----------------|-------------|
| 1.8.x | v1 | 7.x+ |
| 1.7.x | v1 | 7.x+ |

---

## Database migrations

Migrations are in `supabase/migrations/` and run with:

```bash
supabase db push
# or via npm script:
npm run db:push
```

**Rules:**
- Migrations are forward-only — never edit applied migrations
- Keep migrations additive (add columns/tables, avoid dropping)
- If you must drop something, create a separate down-migration script

---

## Hotfix process

1. Branch off `main`: `git checkout -b fix/issue-description`
2. Apply the minimal fix
3. Run `npm run typecheck && npm run test && npm run build`
4. Open PR → merge to `main`
5. Vercel auto-deploys
6. If the issue is in the WordPress plugin: package a new version and distribute

---

## Secrets rotation (during incident)

If a secret is compromised:
1. Rotate the secret in Vercel environment variables
2. Redeploy
3. See `docs/Security.md` for per-secret impact and recovery steps
