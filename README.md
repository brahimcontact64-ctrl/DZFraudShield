# Zaki

**Fraud prevention platform for Algerian WooCommerce merchants.**

Zaki evaluates COD (cash-on-delivery) orders in real time using a cross-merchant reputation network, delivery intelligence, and AI-powered risk scoring — reducing return rates and protecting merchant revenue.

---

## What's inside

| Package | Description |
|---------|-------------|
| `apps/saas` | Next.js 14 SaaS — merchant dashboard + REST API + background jobs |
| `wordpress-plugin/dz-fraud-shield` | WooCommerce plugin — hooks into checkout to call the SaaS |
| `supabase/migrations` | PostgreSQL schema and RLS policies |

---

## Quick start

### Prerequisites

- Node.js 20+, npm 10+
- A [Supabase](https://supabase.com) project
- A WordPress + WooCommerce installation (for plugin development)

### 1. Install

```bash
git clone <repo>
cd zaki
npm install
```

### 2. Configure environment

```bash
cp .env.example apps/saas/.env.local
# Fill in all values — see docs/Environment.md
```

### 3. Apply database migrations

```bash
supabase link --project-ref <your-ref>
npm run db:push
```

### 4. Start development

```bash
npm run dev          # → http://localhost:3000
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |
| `npm run test` | Run test suite |
| `npm run lint` | Lint |
| `npm run db:push` | Apply DB migrations |
| `npm run plugin:package` | Package WordPress plugin zip |

---

## Deployment

### Vercel (SaaS)

The SaaS deploys automatically to Vercel on push to `main` via GitHub Actions.

Manual deploy:
```bash
cd apps/saas
npx vercel --prod
```

See [docs/Deployment.md](docs/Deployment.md) for full configuration.

### Docker

```bash
docker compose up --build
```

See [docker/Dockerfile](docker/Dockerfile) and [docker-compose.yml](docker-compose.yml).

### WordPress Plugin

```bash
bash scripts/package-plugin.sh 1.8.0
# → wordpress-plugin/releases/dz-fraud-shield-1.8.0.zip
# Upload via WordPress Admin → Plugins → Add New → Upload Plugin
```

---

## Documentation

| Doc | Contents |
|-----|----------|
| [Architecture](docs/Architecture.md) | System overview, request flow, key systems |
| [Development](docs/Development.md) | Setup, workflow, conventions |
| [Environment](docs/Environment.md) | All environment variables |
| [API](docs/API.md) | All API routes with auth schemes |
| [Deployment](docs/Deployment.md) | Vercel, Docker, database, plugin |
| [Security](docs/Security.md) | Auth model, secrets rotation, checklist |
| [Plugin](docs/Plugin.md) | WordPress plugin guide |
| [FolderStructure](docs/FolderStructure.md) | Annotated directory tree |
| [Release](docs/Release.md) | Release process and checklist |
| [Troubleshooting](docs/Troubleshooting.md) | Common issues and fixes |

---

## Tech stack

- **SaaS:** Next.js 14, TypeScript, Tailwind CSS, Supabase (Postgres + Auth + RLS)
- **Delivery providers:** Yalidine, ZR Express
- **Push notifications:** Web Push API (VAPID)
- **Testing:** Vitest
- **Deployment:** Vercel + GitHub Actions
- **Plugin:** PHP 8+, WooCommerce 7+

---

## License

MIT — see [LICENSE](LICENSE).
