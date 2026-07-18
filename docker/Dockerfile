FROM node:20-alpine AS base

# ─────────────────────────────────────────────
# Stage 1: Install dependencies
# ─────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/saas/package.json ./apps/saas/
RUN npm ci --workspace=apps/saas --include-workspace-root

# ─────────────────────────────────────────────
# Stage 2: Build
# ─────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/saas/node_modules ./apps/saas/node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

WORKDIR /app/apps/saas
RUN npm run build

# ─────────────────────────────────────────────
# Stage 3: Production runtime
# ─────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

COPY --from=builder /app/apps/saas/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/saas/.next-clean/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/saas/.next-clean/static ./.next-clean/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
