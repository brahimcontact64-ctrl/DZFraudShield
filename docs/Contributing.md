# Zaki — Contributing Guide

## Development setup

### Prerequisites

- Node.js 20.x
- npm 10.x
- A Supabase project (or use the hosted dev instance)

### First-time setup

```bash
# 1. Clone and install
git clone <repo>
cd zaki
npm install

# 2. Set environment variables
cp .env.example apps/saas/.env.local
# Fill in values — see docs/Environment.md

# 3. Start the dev server
cd apps/saas
npm run dev
# App is at http://localhost:3000
```

---

## Running checks

All commands run from `apps/saas/`:

```bash
npm run typecheck       # TypeScript — must pass with zero errors
npm run test            # Vitest — must pass before merging
npm run build           # Production build — must succeed before merging
npm run lint            # ESLint
npm run lint:fix        # ESLint with auto-fix
```

Run all three checks before opening a PR:
```bash
npm run typecheck && npm run test && npm run build
```

---

## Adding a feature

1. **API route** — add under `src/app/api/v1/<category>/`. Do not invent a new top-level path without discussion.
2. **Database change** — add a new migration file in `supabase/migrations/`. Never edit existing migrations; always add forward-only migrations.
3. **Tests** — add Vitest tests in `tests/`. Cover the happy path and at least one error case.
4. **Environment variable** — if the feature needs a new secret, add it to `.env.example` with a safe placeholder and document it in `docs/Environment.md`.
5. **API documentation** — update `docs/API.md` if you add or remove routes.

---

## Code standards

- **TypeScript strict** — the project uses `strict: true`. No `any` without a comment explaining why.
- **No `console.log` in production code** — use structured logging where needed; debug statements must be removed before merge.
- **No secrets in source** — never commit `.env.local`, real keys, or passwords.
- **No feature flags** — implement the feature directly.
- **Minimal comments** — only comment WHY when the reason is non-obvious. Don't comment WHAT the code does.
- **No backwards-compat shims** — if something is unused, delete it.
- **Auth on every API route** — every route in `src/app/api/` must check auth before doing anything. Use the helpers in `src/lib/auth/` and `src/lib/security/`.

---

## Testing guidelines

- Tests live in `apps/saas/tests/`.
- Use **Vitest** (`npm run test`).
- Use `vi.hoisted` + `vi.mock` with `importOriginal` to mock only specific exports; never replace entire modules unless necessary.
- Add `vi.clearAllMocks()` in `beforeEach`.
- Platform-agnostic date assertions: test for substrings (e.g., `"28"` for minute) rather than full locale-formatted strings — ICU output varies between Windows and Linux.

---

## PR workflow

1. Branch off `main` — use `feature/<short-name>` or `fix/<short-name>`.
2. Make your change; run `typecheck + test + build`.
3. Open a PR against `main`.
4. PR description must include:
   - What changed and why
   - How to test it
   - Any env var additions or DB migrations required
5. At least one approval required before merging.
6. Squash merge — one clean commit per feature/fix.

---

## Migrations

- All migrations go in `supabase/migrations/`.
- Filename format: `YYYYMMDDHHMMSS_short_description.sql`
- Migrations run automatically via `supabase db push` — keep them idempotent where possible.
- Never modify an already-applied migration. If you need to undo something, add a new migration.

---

## WordPress plugin

The plugin lives in `wordpress-plugin/dz-fraud-shield/`.
It is a standard WooCommerce plugin (PHP 8+). To test locally:
1. Install WordPress + WooCommerce locally (Local, DDEV, etc.).
2. Symlink or copy `wordpress-plugin/dz-fraud-shield/` into `wp-content/plugins/`.
3. Activate via WP Admin → Plugins.
4. Point the plugin's SaaS URL to `http://localhost:3000`.
