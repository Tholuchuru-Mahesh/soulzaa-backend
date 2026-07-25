# ---------- Base ----------
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---------- Dependencies ----------
FROM base AS deps
# pnpm-workspace.yaml carries onlyBuiltDependencies — without it pnpm 11 blocks
# every postinstall script (ERR_PNPM_IGNORED_BUILDS) and @prisma/engines never
# downloads its query engine.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- Build ----------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate
RUN pnpm build
# Prune dev dependencies to minimise runtime image size
RUN pnpm prune --prod

# ---------- Runtime ----------
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="soulzaa-backend"
LABEL org.opencontainers.image.description="Soulzaaa Backend API — Production Image"
LABEL org.opencontainers.image.vendor="Soulzaaa"

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Create a non-root OS user for security hardening
RUN addgroup -S app && adduser -S app -G app

# Copy only what the runtime needs (no dev tooling)
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --chown=app:app package.json ./

USER app
EXPOSE 3000

# Kubernetes/Docker healthcheck using the /health/live liveness probe
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health/live || exit 1

# Run Prisma migrations then start the API server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
