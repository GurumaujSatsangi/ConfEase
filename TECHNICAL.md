# ConfEase — Technical Reference

Primary technical reference for the DEI Conference Management Toolkit (ConfEase): technology stack and Docker usage. For a project overview, see [README.md](README.md).

## A. Technology Stack

| Layer | Technology | Version |
| --- | --- | --- |
| Backend runtime | Node.js | **20** (`node:20-slim`, pinned in [`Dockerfile`](Dockerfile)). Local development has been run on Node v22; any current LTS works. |
| Backend framework | Express | 5.1.0 (`package.json`) |
| Language | JavaScript, ES modules (`"type": "module"` in `package.json`) | — |
| Frontend | Server-rendered EJS templates (`views/`) | ejs 3.1.10 |
| Frontend styling/JS | Bootstrap 5 + Bootstrap Icons (loaded from the jsDelivr CDN), plain JavaScript (`public/script.js`) | No frontend build step/bundler — `public/` is served as static files as-is |
| Database | PostgreSQL | **17** in the published Docker DB image (`postgres:17-alpine`, see [`db/Dockerfile`](db/Dockerfile)). Local development was verified against PostgreSQL 17.2. **A managed/external production database's exact version must be confirmed in that hosting environment** — it is not fixed by this repository. |
| Caching / sessions | Redis (optional — the app runs without it, with reduced caching/rate-limiting) via the `redis` client; `express-session` (+ `connect-redis` when Redis is configured) backs login sessions, OAuth state, and the CSRF token | redis 7-alpine in `docker-compose.yml`; `redis` npm client ^5.12.1 |
| File storage | Cloudinary (uploaded papers, certificates, profile-adjacent assets) | `cloudinary` ^2.6.1 |
| Email | **Gmail SMTP via nodemailer** (`mailer.js`) — all transactional email (password resets, notifications, certificates) is sent through Gmail, authenticated as `EMAIL_USER` either with an App Password (`EMAIL_PASSWORD`) or OAuth2 (`GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET`/`GMAIL_OAUTH_REFRESH_TOKEN` — used automatically once all three are set; needed on Workspace accounts where an admin has disabled app-password generation) | `nodemailer` ^10.1.7 |
| Certificate generation | Canva Connect API (OAuth2 + PKCE), via `canva.js` | — |
| Authentication | JWT access tokens (15 min) + JWT refresh tokens (7 days), both in `httpOnly` cookies; bcrypt password hashing; `express-session` separately backs Canva's OAuth flow and the CSRF synchronizer token | `jsonwebtoken` ^9.0.0, `bcrypt` ^6.0.0 |
| Security headers | Helmet (Content-Security-Policy, HSTS in production, standard headers) | `helmet` ^8.3.0 |
| File uploads | Multer (in-memory, size/type-validated before forwarding to Cloudinary) | `multer` ^2.0.1 |
| Excel export | ExcelJS | `exceljs` ^4.4.0 |

## B. Docker Image Details

- **Image (app):** [`gurumaujsatsangi/confease`](https://hub.docker.com/r/gurumaujsatsangi/confease) on **Docker Hub**. Tags: `latest`, `1.0.0`.
- **Image (database):** `gurumaujsatsangi/confease-db` on Docker Hub (referenced in `docker-compose.yml`; build it yourself from [`db/Dockerfile`](db/Dockerfile) if you'd rather not pull it).
- **Platforms/architecture:** not explicitly declared (no documented multi-arch manifest in this repository) — not verified here.
- **Container port:** `3000` (`EXPOSE 3000` in `Dockerfile`), mapped to the host via the `PORT` environment variable (defaults to `3000`).
- **Required external services:** PostgreSQL (required), Redis (optional — the app degrades gracefully without it), Cloudinary (required for file uploads), Gmail SMTP (required to send any email), Canva (required only for certificate generation), Drillbit (optional — AI/plagiarism check on first-time full paper submissions; disabled entirely until configured).
- **Required environment variables** (see [`.env.example`](.env.example) for the authoritative, fully-commented list — names only, no values, here):
  `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, `DB_PORT`, `DB_SSL`, `SESSION_SECRET`, `JWT_SECRET` (or `JWT_ACCESS_TOKEN_SECRET`/`JWT_REFRESH_TOKEN_SECRET`), `REDIS_HOST`/`REDIS_PORT`/`REDIS_USERNAME`/`REDIS_PASSWORD` (optional), `CLOUDINARY_CLOUD_NAME`/`CLOUDINARY_API_KEY`/`CLOUDINARY_API_SECRET`, `EMAIL_USER`, `EMAIL_PASSWORD`, `DRILLBIT_EMAIL`/`DRILLBIT_PASSWORD` (optional), `CANVA_CLIENT_ID`/`CANVA_CLIENT_SECRET`/`BRAND_TEMPLATE_ID_*`, `ADMIN_EMAILS`, `APP_URL`, `NODE_ENV`, `PORT`.
- **Persistent storage:** none inside the app container itself. The database container uses a named Docker volume (`confease_pgdata` in `docker-compose.yml`) so data survives container restarts/redeploys.
- **Health check:** `Dockerfile` defines `HEALTHCHECK` against `GET /healthz/ready`, which checks the database (and Redis, if configured) are actually reachable — not just that the Node process is alive.
- **Frontend:** served by the same container as the backend (EJS rendered server-side, static assets served from the same Express process) — there is no separate frontend container or build.

## C. How to Pull and Run the Docker Image

A published image exists (see Section B), so this works as written.

```bash
# 1. Pull the image
docker pull gurumaujsatsangi/confease:latest

# 2. Configure required environment variables
cp .env.example .env
# edit .env and fill in real values - see .env.example's own comments
# (never commit this file; use placeholders like <your-value> only when sharing it)

# 3. Run the container, mapping the app's port
docker run -d \
  --name confease \
  -p 3000:3000 \
  --env-file .env \
  gurumaujsatsangi/confease:latest

# 4. Point it at your external PostgreSQL (and, optionally, Redis) via the
#    DB_*/REDIS_* variables in .env - this image does not bundle a database.

# 5. Verify it's running
curl http://localhost:3000/healthz/ready

# 6. Stop and remove the container when needed
docker stop confease && docker rm confease
```

The image is public on Docker Hub, so no registry authentication is required to pull it.

## D. Build the Docker Image Locally

```bash
# Build
docker build -t confease:latest .

# Run it (same env-file/port pattern as above)
docker run -d --name confease -p 3000:3000 --env-file .env confease:latest

# View logs
docker logs -f confease

# Stop it
docker stop confease
```

**To run the whole stack at once** (app + PostgreSQL + Redis, nothing else to set up) use the existing `docker-compose.yml` instead:

```bash
cp .env.example .env   # fill it in
docker compose up -d
```

This builds/pulls all three services, applies [`db/schema.sql`](db/schema.sql) automatically the first time the database container starts against an empty volume, and wires the app to the other two containers by service name.

## E. Essential Configuration Notes

- **Database connectivity:** PostgreSQL is required; the app will not start correctly without a reachable one. `DB_SSL=true` enables TLS for a remote database (leave `false` for a local/same-network Postgres).
- **Redis connectivity:** optional. If `REDIS_HOST`/`REDIS_PORT` are unset, the app runs with in-memory fallbacks for rate limiting and no response caching — it does not crash or refuse to start.
- **Email:** `EMAIL_USER`/`EMAIL_PASSWORD` (a Gmail account and App Password) are required to send any email (password resets, notifications, certificates) — sent via Gmail's own SMTP, authenticated as that account.
- **Database migrations:** there is no automated migration runner. [`db/schema.sql`](db/schema.sql) is the complete, from-scratch schema (applied automatically by the database Docker image on first start). [`db/migrations/`](db/migrations) holds the incremental SQL history for evolving an **existing** database — each file is reviewed and run manually, in order, against a database that predates it.
- **Startup order:** the app depends on PostgreSQL being reachable at boot; `docker-compose.yml` enforces this with `depends_on: ... condition: service_healthy` for both the database and Redis containers. The app itself also fails closed at startup (logs a clear error and, in production, exits) if required secrets (database credentials, JWT secrets) are missing.
- **Health check:** use `GET /healthz/ready` (not `GET /`) for any readiness/liveness probe that should actually detect a database outage — `/` is a deliberately dependency-light liveness check that stays "healthy" even if the database is down.
