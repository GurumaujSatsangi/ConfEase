# 🚀 ConfEase - Quick Docker Commands

## For You (Project Owner)

### First Time Setup
```bash
# 1. Ensure you have .env file with all credentials
cp .env.example .env
# Edit .env with your actual credentials

# 2. Build and start
docker-compose up -d

# 3. Check if running
docker-compose ps

# 4. View logs
docker-compose logs -f
```

### Share Your Project

**Option 1: Via GitHub**
```bash
git add .
git commit -m "Add Docker support"
git push origin main
# Share repository link + DOCKER_SETUP.md
```

**Option 2: Via Docker Hub**
```bash
# Build image
docker build -t yourusername/confease:latest .

# Login to Docker Hub
docker login

# Push image
docker push yourusername/confease:latest

# Share: docker-compose.yml + .env.example + DOCKER_SETUP.md
```

**Option 3: ZIP Package**
```bash
# Include: All files EXCEPT .env, node_modules/, uploads/
# Must include: Dockerfile, docker-compose.yml, .env.example, DOCKER_SETUP.md
```

---

## For Users (Receiving Your Project)

### Setup (One-time)
```bash
# 1. Get project files
git clone <repo-url>
cd ConfEase

# 2. Create .env from example
cp .env.example .env

# 3. Edit .env with credentials
# (Use your favorite text editor)

# 4. Start everything
docker-compose up -d

# 5. Open browser
http://localhost:3000
```

### Daily Use
```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# View logs
docker-compose logs -f

# Restart
docker-compose restart
```

---

## Common Commands

| Task | Command |
|------|---------|
| **Start services** | `docker-compose up -d` |
| **Stop services** | `docker-compose down` |
| **View logs (live)** | `docker-compose logs -f` |
| **View logs (app only)** | `docker-compose logs -f app` |
| **Restart all** | `docker-compose restart` |
| **Restart app only** | `docker-compose restart app` |
| **Check status** | `docker-compose ps` |
| **Rebuild after changes** | `docker-compose up -d --build` |
| **Stop + remove data** | `docker-compose down -v` |
| **Access database** | `docker-compose exec postgres psql -U postgres -d confease` |

---

## Troubleshooting

**"Port already in use"**
```bash
# Change port in docker-compose.yml under app > ports
ports:
  - "3001:3000"  # Use 3001 instead of 3000
```

**"Can't connect to database"**
```bash
# In .env, ensure DB_HOST=postgres (not localhost)
# Restart: docker-compose restart
```

**"Application not starting"**
```bash
# View detailed logs
docker-compose logs app

# Check .env has all required variables
# Rebuild
docker-compose up -d --build
```

**"Tables not created"**
```bash
# Reset database
docker-compose down -v
docker-compose up -d
```

---

## Files Created for Docker

✅ `Dockerfile` - Defines the application container
✅ `docker-compose.yml` - Orchestrates app + database
✅ `.dockerignore` - Files to exclude from Docker image
✅ `.env.example` - Template for environment variables
✅ `DOCKER_SETUP.md` - Complete setup guide
✅ `DOCKER_QUICKSTART.md` - This quick reference

---

## Required Environment Variables

Before running, you MUST set these in `.env`:

```env
# Database
DB_PASSWORD=your_password

# Secrets (generate random strings)
SESSION_SECRET=min_32_characters_random_string
JWT_SECRET=another_random_string_32_chars

# Google OAuth (get from Google Cloud Console)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
# (+ same for CLIENT_ID2, CLIENT_ID3, CLIENT_ID4)

# Cloudinary (get from cloudinary.com)
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Email (Gmail app password)
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_app_password
```

---

## Support

📖 Full guide: See `DOCKER_SETUP.md`
🐛 Issues: Check logs with `docker-compose logs -f`
📧 Contact: Project maintainer
