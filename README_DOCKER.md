# 🐳 Running ConfEase with Docker

**Welcome!** This guide will help you run the ConfEase Conference Management Toolkit using Docker in just a few minutes.

## 🎯 What You'll Need

1. **Docker** installed on your computer ([Download here](https://www.docker.com/products/docker-desktop/))
2. **Credentials** for:
   - Google OAuth (for authentication)
   - Cloudinary (for file uploads)
   - Gmail (for email notifications)

## 🚀 Quick Start (3 Steps)

### Step 1: Setup Environment

```bash
# Copy the example file
cp .env.example .env

# Edit .env and fill in your credentials
# (Use any text editor like notepad, VS Code, etc.)
```

### Step 2: Start the Application

```bash
docker-compose up -d
```

This command will:
- Download required Docker images
- Set up PostgreSQL database
- Initialize database schema
- Start your application

### Step 3: Access the Application

Open your browser and go to:
```
http://localhost:3000
```

That's it! 🎉

## 📚 Documentation

- **Complete Setup Guide**: See [DOCKER_SETUP.md](DOCKER_SETUP.md)
- **Quick Commands**: See [DOCKER_QUICKSTART.md](DOCKER_QUICKSTART.md)
- **Checklist**: See [DOCKER_CHECKLIST.md](DOCKER_CHECKLIST.md)

## 🛠️ Common Commands

```bash
# Start the application
docker-compose up -d

# Stop the application
docker-compose down

# View logs
docker-compose logs -f

# Restart
docker-compose restart

# Check status
docker-compose ps
```

## ❓ Need Help?

1. **Can't connect?** 
   - Check if containers are running: `docker-compose ps`
   - View logs: `docker-compose logs -f`

2. **Database issues?**
   - Ensure `DB_HOST=postgres` in `.env`
   - Reset: `docker-compose down -v && docker-compose up -d`

3. **Port conflicts?**
   - Change port in `docker-compose.yml` from `3000` to another port

For detailed troubleshooting, see [DOCKER_SETUP.md](DOCKER_SETUP.md).

## 🔐 Getting Credentials

### Google OAuth
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create OAuth 2.0 credentials
3. Add redirect URIs: `http://localhost:3000/auth/google/dashboard` (and variants)

### Cloudinary
1. Sign up at [Cloudinary.com](https://cloudinary.com/)
2. Get your Cloud Name, API Key, and API Secret from dashboard

### Gmail App Password
1. Enable 2FA on your Gmail account
2. Generate app password at [Google Account](https://myaccount.google.com/apppasswords)

## 📦 What's Included

- ✅ Node.js application (Express)
- ✅ PostgreSQL database
- ✅ Automatic schema initialization
- ✅ Persistent data storage
- ✅ Environment-based configuration

## 💡 Tips

- Use `docker-compose logs -f app` to see real-time application logs
- Database data persists even if you stop the containers
- To start fresh: `docker-compose down -v` (⚠️ deletes all data)

## 📞 Support

Having issues? Check the full documentation in [DOCKER_SETUP.md](DOCKER_SETUP.md) or contact the project maintainer.

---

**Happy conferencing! 🎓**
