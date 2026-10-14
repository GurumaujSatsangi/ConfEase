<h4>Conference Management Toolkit</h4>

## Running the whole stack (recommended)

[`docker-compose.yml`](docker-compose.yml) runs the app, PostgreSQL, and Redis together as three containers - one command, nothing else to set up:

```bash
cp .env.example .env   # then fill it in - see the file's own comments
docker compose up -d
```

The database container ([`db/Dockerfile`](db/Dockerfile)) applies [`db/schema.sql`](db/schema.sql) automatically the first time it starts, so it's ready to use immediately - no separate setup step. Data persists in a named Docker volume across restarts and `docker compose up`/`down` (not `down -v`, which removes it intentionally).

## Running just the app

A pre-built image of the app alone is published at [`gurumaujsatsangi/confease`](https://hub.docker.com/r/gurumaujsatsangi/confease) on Docker Hub (tags: `latest`, `1.0.0`), for pointing at a database you already run elsewhere (a managed Postgres, an existing server, etc.):

```bash
docker pull gurumaujsatsangi/confease:latest
docker run -d -p 3000:3000 --env-file .env gurumaujsatsangi/confease:latest
```

See [.env.example](.env.example) for every variable the app reads (database connection, session/JWT secrets, Redis, Cloudinary, email, admin allow-list). Redis is optional - the app runs without it, just without caching.

To build either image yourself instead of pulling it:

```bash
docker build -t confease:latest .          # the app
docker build -t confease-db:latest ./db    # the database
```
