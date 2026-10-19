<h4>Conference Management Toolkit</h4>

DEI CMT (ConfEase) is a conference management system: submissions, peer review, scheduling, registration, and certificate generation.

## Quick start

```bash
cp .env.example .env   # then fill it in - see the file's own comments
docker compose up -d
```

That's the whole stack - app, PostgreSQL, and Redis - in one command.

**For the full technology stack, Docker image details (registry, tags, ports, environment variables), and every other way to build/run the image, see [TECHNICAL.md](TECHNICAL.md).**
