# Zaki — Development Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20.x | https://nodejs.org |
| npm | 10.x | bundled with Node |
| Supabase CLI | latest | `npm i -g supabase` |
| Git | any | https://git-scm.com |

---

## First-time setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd zaki

# 2. Install all dependencies
npm install

# 3. Set up environment variables
cp .env.example apps/saas/.env.local
# Edit apps/saas/.env.local — fill in all values
# See docs/Environment.md for the full reference

# 4. Start the development server
npm run dev
# App available at http://localhost:3000
```

---

## Project structure

```
/
├── apps/saas/              Next.js SaaS platform
├── wordpress-plugin/       WooCommerce plugin (PHP)
├── supabase/migrations/    Database migration files
├── scripts/                Operational scripts
├── docs/                   Documentation
├── docker/                 Dockerfile
├── .github/workflows/      GitHub Actions CI/CD
└── .vscode/                VS Code settings (committed)
```

---

## Daily development workflow

```bash
# Start the dev server
npm run dev

# In a separate terminal — run tests in watch mode
cd apps/saas && npm run test:watch

# TypeScript check on demand
npm run typecheck

# Lint
npm run lint
npm run lint:fix
```

---

## Adding a feature

### 1. New API endpoint

Place under `apps/saas/src/app/api/v1/<category>/`:

```typescript
// Every route must check auth first
export async function POST(req: NextRequest) {
  const { merchant, error } = await getAuthenticatedMerchant(req);
  if (error) return error;

  // ... business logic
}
```

Update `docs/API.md` with the new route.

### 2. New database table

Create a migration in `supabase/migrations/`:
```bash
# File naming: YYYYMMDDHHMMSS_description.sql
touch supabase/migrations/$(date +%Y%m%d%H%M%S)_add_something.sql
```

- Always enable RLS on new tables
- Add policies that scope data to `auth.uid()` or merchant ID
- Test with `supabase db push`

### 3. New environment variable

1. Add it to `.env.example` with a safe placeholder
2. Document it in `docs/Environment.md`
3. Add it to the Docker Compose `environment` section in `docker-compose.yml`
4. Add it to `.github/workflows/ci.yml` if needed for the build

---

## Running checks

All commands run from the repo root (they delegate to `apps/saas`):

```bash
npm run typecheck    # TypeScript — must pass with zero errors
npm run test         # Vitest tests
npm run lint         # ESLint
npm run build        # Production build
```

Or directly from `apps/saas/`:
```bash
cd apps/saas
npm run test:watch   # Watch mode
npm run test:coverage  # Coverage report
```

---

## Testing conventions

- Tests live in `apps/saas/tests/*.test.ts`
- Test runner: **Vitest** v2
- Mock strategy: `vi.hoisted` + `vi.mock` with `importOriginal` — mock specific exports, preserve the rest
- Always add `vi.clearAllMocks()` in `beforeEach`
- Date/time assertions: use substring matching, not full locale-formatted strings (ICU differs between Windows and Linux)

### Example: mocking a specific export

```typescript
const hoisted = vi.hoisted(() => ({
  myFn: vi.fn(async (): Promise<string> => "mocked-result"),
}));

vi.mock("@/lib/my-module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/my-module")>();
  return { ...actual, myFn: hoisted.myFn };
});
```

---

## Database migrations

```bash
# Link your local CLI to the Supabase project (one-time)
supabase link --project-ref <your-project-ref>

# Apply all pending migrations
supabase db push
# or:
npm run db:push
```

---

## WordPress plugin development

```bash
# Symlink the plugin into your local WordPress installation
ln -s "$(pwd)/wordpress-plugin/dz-fraud-shield" \
  /path/to/wordpress/wp-content/plugins/dz-fraud-shield

# Point plugin settings to local dev server
# WooCommerce → DZ Fraud Shield → Settings → SaaS URL: http://localhost:3000
```

---

## Building the WordPress plugin zip

```bash
bash scripts/package-plugin.sh 1.9.0
# Output: wordpress-plugin/releases/dz-fraud-shield-1.9.0.zip
```

---

## Docker (local)

```bash
# Build and run the production image locally
docker compose up --build

# Access at http://localhost:3000
```

Requires environment variables in a `.env` file at the repo root — see `docker-compose.yml` for the full list.
