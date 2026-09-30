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
RUN npx prisma contract emit && npm run build

# ─── 3. Runtime — chỉ copy standalone + static ───
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
# Prisma contract + client để chạy migration từ container
COPY --from=builder --chown=nextjs:nodejs /app/src/prisma ./src/prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# thư mục upload ghi được
RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads

USER nextjs
EXPOSE 3000

# healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
