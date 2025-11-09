# ConfEase - Docker Setup Guide

This guide will help you run the ConfEase Conference Management Toolkit using Docker.

## Prerequisites

Before you begin, ensure you have the following installed:
- **Docker Desktop** (Windows/Mac) or **Docker Engine** (Linux)
- **Docker Compose** (usually included with Docker Desktop)

### Install Docker

- **Windows/Mac**: Download and install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux**: Follow the [official Docker installation guide](https://docs.docker.com/engine/install/)

Verify installation:
```bash
docker --version
docker-compose --version
```

---

## Quick Start (For Users Receiving This Project)

### Step 1: Get the Project Files

Clone or download the project:
```bash
git clone <repository-url>
cd ConfEase
```

Or if you received a ZIP file, extract it and navigate to the folder.

### Step 2: Configure Environment Variables

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Open `.env` file and fill in your credentials:
   ```env
   # Database (you can keep these defaults)
   DB_USER=postgres
   DB_PASSWORD=your_secure_password
   DB_NAME=confease
   
   # REQUIRED: Generate random secrets (minimum 32 characters)
   SESSION_SECRET=your_random_string_here_minimum_32_chars
   JWT_SECRET=another_random_string_here_minimum_32_chars
   
   # REQUIRED: Google OAuth credentials (get from Google Cloud Console)
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   # ... (and other Google OAuth for different roles)
   
   # REQUIRED: Cloudinary credentials (for file uploads)
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret
   
   # REQUIRED: Email credentials (Gmail recommended)
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASSWORD=your_app_password
   ```

### Step 3: Run the Application

Start all services (PostgreSQL database + Node.js app):
```bash
docker-compose up -d
```

This will:
- Download necessary Docker images
- Create and start PostgreSQL database
- Initialize database with schema from `init-db.sql`
- Start the Node.js application

### Step 4: Access the Application

Open your browser and go to:
```
http://localhost:3000
```

### Step 5: Stop the Application

To stop all services:
```bash
docker-compose down
```

To stop and remove all data (including database):
```bash
docker-compose down -v
```

---

## For Project Owner (Sharing Instructions)

### Option 1: Share via Git Repository

1. Push your code to GitHub/GitLab:
   ```bash
   git add .
   git commit -m "Add Docker support"
   git push origin main
   ```

2. Share the repository URL with users along with:
   - This `DOCKER_SETUP.md` file
   - `.env.example` file (without actual credentials)

3. Users follow the "Quick Start" guide above

### Option 2: Share as Docker Image (Recommended)

1. Build and tag your image:
   ```bash
   docker build -t yourusername/confease:latest .
   ```

2. Push to Docker Hub:
   ```bash
   docker login
   docker push yourusername/confease:latest
   ```

3. Update `docker-compose.yml` to use your image:
   ```yaml
   app:
     image: yourusername/confease:latest
     # Remove the 'build: .' line
   ```

4. Share the modified `docker-compose.yml` and `.env.example` with users

### Option 3: Share as ZIP Package

1. Create a package with:
   - All project files
   - `Dockerfile`
   - `docker-compose.yml`
   - `.dockerignore`
   - `.env.example`
   - `DOCKER_SETUP.md`
   - `init-db.sql`

2. **Important**: Do NOT include:
   - `.env` (your actual credentials)
   - `node_modules/`
   - `uploads/` (user data)

---

## Useful Docker Commands

### View Running Containers
```bash
docker-compose ps
```

### View Application Logs
```bash
# All services
docker-compose logs -f

# Only app logs
docker-compose logs -f app

# Only database logs
docker-compose logs -f postgres
```

### Restart Services
```bash
# Restart all
docker-compose restart

# Restart only app
docker-compose restart app
```

### Access Database
```bash
docker-compose exec postgres psql -U postgres -d confease
```

### Rebuild After Code Changes
```bash
docker-compose up -d --build
```

### Clean Up Everything
```bash
# Stop and remove containers, networks
docker-compose down

# Also remove volumes (database data)
docker-compose down -v

# Remove Docker images
docker-compose down --rmi all
```

---

## Troubleshooting

### Port Already in Use
If port 3000 or 5432 is already in use, modify `docker-compose.yml`:
```yaml
services:
  app:
    ports:
      - "3001:3000"  # Use port 3001 instead
```

### Database Connection Issues
1. Check if PostgreSQL is running:
   ```bash
   docker-compose ps
   ```

2. View database logs:
   ```bash
   docker-compose logs postgres
   ```

3. Ensure `DB_HOST=postgres` in `.env` (not `localhost`)

### Application Won't Start
1. Check app logs:
   ```bash
   docker-compose logs app
   ```

2. Verify all required environment variables in `.env`

3. Rebuild the container:
   ```bash
   docker-compose up -d --build
   ```

### Database Schema Not Created
If tables are missing:
```bash
# Stop services
docker-compose down -v

# Start fresh (this will run init-db.sql)
docker-compose up -d
```

---

## Environment Variables Reference

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DB_PASSWORD` | PostgreSQL password | `secure_pass_123` |
| `SESSION_SECRET` | Express session secret | `random_32_char_string` |
| `JWT_SECRET` | JWT token secret | `another_random_string` |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | `123456-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Secret | `GOCSPX-xxx` |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account name | `your_cloud_name` |
| `CLOUDINARY_API_KEY` | Cloudinary API key | `123456789012345` |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret | `abcdefghijk` |
| `EMAIL_USER` | Email for sending notifications | `your@gmail.com` |
| `EMAIL_PASSWORD` | Email app password | `abcd efgh ijkl mnop` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_USER` | Database username | `postgres` |
| `DB_NAME` | Database name | `confease` |
| `NODE_ENV` | Node environment | `production` |
| `PORT` | Application port | `3000` |

---

## Getting Credentials

### Google OAuth Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URIs:
   - `http://localhost:3000/auth/google/dashboard`
   - `http://localhost:3000/auth2/google/dashboard2`
   - `http://localhost:3000/auth3/google/dashboard3`
   - `http://localhost:3000/auth4/google/dashboard4`

### Cloudinary Credentials
1. Sign up at [Cloudinary](https://cloudinary.com/)
2. Get credentials from Dashboard
3. Copy Cloud Name, API Key, and API Secret

### Gmail App Password
1. Enable 2-Factor Authentication on Gmail
2. Go to [App Passwords](https://myaccount.google.com/apppasswords)
3. Generate password for "Mail"
4. Use generated password in `EMAIL_PASSWORD`

---

## Production Deployment

For production deployment on a server:

1. Use environment-specific `.env` file
2. Set `NODE_ENV=production`
3. Use proper domain in OAuth callback URLs
4. Enable SSL/HTTPS (use reverse proxy like Nginx)
5. Set up regular database backups:
   ```bash
   docker-compose exec postgres pg_dump -U postgres confease > backup.sql
   ```

---

## Support

For issues or questions:
- Check the troubleshooting section above
- Review application logs: `docker-compose logs -f`
- Contact the project maintainer

---

## License

Copyright © 2025 Gurumauj Satsangi. All rights reserved.
