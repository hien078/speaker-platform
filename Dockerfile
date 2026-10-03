# LoaViet — production image (Next.js standalone)
# Build:  docker build -t loaviet .
# Chạy:   docker run -p 3000:3000 --env-file .env loaviet

FROM node:22-alpine AS base
WORKDIR /app

# ─── 1. Dependencies ───
FROM base AS deps
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
# npm install (không ci) — tương thích npm 10/12 giữa local và Docker
RUN npm install --no-audit --no-fund

# ─── 2. Build ───
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# cần DATABASE_URL cho Prisma generate lúc build
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV AUTH_SECRET="build-placeholder"
# prebuild (package.json) chạy 'prisma contract emit' trước next build
RUN npm run build

# ─── 3. Migration runner — Prisma CLI + graph migrations để db migrate ───
# Chạy qua compose service 'migrate' (docker-compose.prod.yml):
#   docker compose -f docker-compose.prod.yml run --rm migrate
# Áp migrations theo graph (migrations/app/) tới ref 'production'.
# KHÔNG dùng 'prisma db update' trên DB production — không để lại lịch sử.
FROM base AS migrate
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/prisma ./src/prisma
COPY --from=builder /app/migrations ./migrations
WORKDIR /app
CMD ["npx", "prisma", "db", "migrate", "--to", "production"]

# ─── 4. Runtime — chỉ copy standalone + static ───
FROM base AS runner
RUN apk add --no-cache postgresql-client
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# user không root
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# (migration chạy từ stage 'migrate' — app runtime không cần Prisma CLI / src/prisma)

# thư mục upload ghi được
RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads

USER nextjs
EXPOSE 3000

# healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
