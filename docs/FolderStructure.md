# Zaki — Folder Structure

```
zaki/
├── apps/
│   └── saas/                          Next.js SaaS platform
│       ├── locales/                   i18n translation files (ar, fr, en)
│       ├── public/                    Static assets
│       │   ├── sw.js                  Service Worker (PWA + push)
│       │   └── *.svg / *.png         App icons and favicons
│       ├── scripts/                   Operational scripts (not deployed)
│       │   ├── audit-*.mjs            Audit / verification scripts
│       │   ├── verify-*.mjs           Production verification scripts
│       │   ├── rebuild-*.mjs          One-time repair scripts
│       │   └── backfill-*.mjs         Data backfill scripts
│       ├── src/
│       │   ├── app/                   Next.js App Router
│       │   │   ├── (dashboard)/       Merchant-facing dashboard pages
│       │   │   │   └── dashboard/     All merchant dashboard routes
│       │   │   ├── (marketing)/       Public marketing / landing pages
│       │   │   ├── admin/             Owner-only admin UI pages
│       │   │   ├── api/               API routes
│       │   │   │   ├── auth/          Auth endpoints
│       │   │   │   ├── v1/            Versioned REST API
│       │   │   │   │   ├── admin/     Admin-only API routes
│       │   │   │   │   ├── check-order/  Core order risk evaluation
│       │   │   │   │   ├── delivery/  Delivery account & sync APIs
│       │   │   │   │   ├── jobs/      Cron job endpoints
│       │   │   │   │   ├── merchant/  Merchant self-service APIs
│       │   │   │   │   ├── plugin/    WooCommerce plugin API
│       │   │   │   │   └── pwa/       PWA push notification APIs
│       │   │   │   └── webhooks/      Inbound webhooks
│       │   │   ├── auth/              Auth pages (login, signup)
│       │   │   ├── dashboard/         Legacy redirect stubs
│       │   │   ├── offline/           PWA offline fallback page
│       │   │   ├── layout.tsx         Root layout (viewport, PWA meta)
│       │   │   └── manifest.ts        PWA web manifest
│       │   ├── components/
│       │   │   ├── admin/             Admin-only UI components
│       │   │   ├── i18n/             i18n provider / language switcher
│       │   │   ├── merchant/          Merchant dashboard components
│       │   │   ├── notifications/     Notification center + settings
│       │   │   ├── orders/            Order card + operations
│       │   │   ├── pwa/               PWA install prompt + update banner
│       │   │   └── ui/                Shared UI primitives (shell, cards)
│       │   ├── lib/
│       │   │   ├── admin/             Admin data access layer
│       │   │   ├── analytics-ai/      AI-powered analytics engine
│       │   │   ├── api/               API context helpers
│       │   │   ├── auth/              Auth session helpers
│       │   │   ├── automation/        Automation engine
│       │   │   ├── delivery-intelligence/  Delivery provider layer
│       │   │   │   └── adapters/      Yalidine + ZR Express adapters
│       │   │   ├── i18n/              i18n config + client/server hooks
│       │   │   ├── marketing-intelligence/ Product & market analytics
│       │   │   ├── merchant/          Merchant data helpers
│       │   │   ├── merchant-intelligence/ MDI pipeline
│       │   │   ├── network-intelligence/  Cross-merchant network
│       │   │   ├── notifications/     Push notification settings + templates
│       │   │   ├── order-decision/    Decision recording + sync
│       │   │   ├── payments/          Payment request management
│       │   │   ├── pwa/               PWA version + push delivery
│       │   │   ├── recommendation-engine/ Merchant recommendations
│       │   │   ├── risk/              Risk scoring engine
│       │   │   ├── security/          API key auth, rate limiting, crypto
│       │   │   ├── strategy-engine/   Strategy Engine
│       │   │   ├── supabase/          Supabase client (server + browser)
│       │   │   ├── background-jobs.ts Async job queue
│       │   │   ├── dashboard-data.ts  Dashboard data helpers
│       │   │   └── format-date.ts     Deterministic date/number formatting
│       │   ├── pages/                 Next.js Pages Router (legacy — error pages only)
│       │   └── types/                 Shared TypeScript types
│       ├── tests/                     Vitest test suite
│       ├── supabase/                  Database migrations
│       ├── next.config.mjs
│       ├── tailwind.config.ts
│       ├── tsconfig.json
│       ├── vercel.json
│       └── vitest.config.ts
├── wordpress-plugin/
│   └── dz-fraud-shield/               Installable WooCommerce plugin (PHP)
├── supabase/
│   └── migrations/                    SQL migration files
├── docs/                              Project documentation (this folder)
├── .env.example                       Environment variable reference
├── .gitignore
├── package.json                       Root workspace package
├── tsconfig.base.json                 Shared TypeScript base config
└── README.md
```
