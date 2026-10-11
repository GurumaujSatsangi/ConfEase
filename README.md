<h4>Conference Management Toolkit</h4>

## Running with Docker

A pre-built image is published at [`gurumaujsatsangi/confease`](https://hub.docker.com/r/gurumaujsatsangi/confease) on Docker Hub (tags: `latest`, `1.0.0`). It bundles the app only - you still need your own PostgreSQL database and, optionally, Redis.

```bash
docker pull gurumaujsatsangi/confease:latest
docker run -d -p 3000:3000 --env-file .env gurumaujsatsangi/confease:latest
```

See [.env.example](.env.example) for every variable the app reads (database connection, session/JWT secrets, Redis, Cloudinary, email, admin allow-list). Redis is optional - the app runs without it, just without caching.

To build the image yourself instead of pulling it:

```bash
docker build -t confease:latest .
```
