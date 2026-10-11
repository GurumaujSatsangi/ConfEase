# DEI Conference Management Toolkit (DEI CMT)
#
# Runtime image only - this does not bundle PostgreSQL or Redis. Point it at
# an existing Postgres database (required) and, optionally, a Redis instance
# (the app runs without one, just without caching) via environment variables.
# See .env.example for the full list of variables the app reads.

FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so this layer is cached across source-only
# changes. --omit=dev skips puppeteer (only used by docs/build-pdf.mjs,
# never at runtime).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Run as a non-root user.
RUN groupadd --system app && useradd --system --gid app --home-dir /app app \
    && chown -R app:app /app
USER app

EXPOSE 3000

# "/" renders even when the database is unreachable (it catches the error
# and still returns 200 with an empty conference list), so it's a safe,
# dependency-light liveness/readiness check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "api/index.js"]
