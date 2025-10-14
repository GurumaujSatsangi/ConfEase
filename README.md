# DEI Conference Management Toolkit

<div align="center">

![Conference Management](https://img.shields.io/badge/Conference-Management-blue)
![Node.js](https://img.shields.io/badge/Node.js-v18+-green)
![Express](https://img.shields.io/badge/Express-v4.x-lightgrey)
![Bootstrap](https://img.shields.io/badge/Bootstrap-v5.3-purple)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-success)
![License](https://img.shields.io/badge/License-MIT-yellow)

**An Integrated Toolkit for End-to-End Conference Management**

[Features](#features) • [Tech Stack](#tech-stack) • [Installation](#installation) • [Usage](#usage) • [Architecture](#architecture) • [Contributing](#contributing)

</div>

---

## 📋 Table of Contents

- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [System Architecture](#system-architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [User Roles](#user-roles)
- [Database Schema](#database-schema)
- [API Documentation](#api-documentation)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

---

## 🎯 About

The **DEI Conference Management Toolkit** is a comprehensive web-based platform designed to streamline the entire conference management lifecycle. Built around a role-based access system, it caters to the specific needs of each user group—conference chairs, authors, reviewers, and panelists—ensuring a seamless and intuitive workflow from paper submission to final evaluation.

### Why ConfEase?

- ✅ **Complete Lifecycle Management**: From paper submission to final results
- ✅ **Role-Based Access Control**: Tailored experiences for chairs, authors, reviewers, and panelists
- ✅ **Real-Time Collaboration**: Co-authors can join and contribute seamlessly
- ✅ **Automated Workflows**: Email notifications and automated result generation
- ✅ **Live Evaluation**: Real-time scoring during conference presentations
- ✅ **Responsive Design**: Works flawlessly on desktop, tablet, and mobile devices

---

## ✨ Features

### 🎪 Conference Hosting
- **Create & Configure Conferences**: Define submission deadlines, acceptance dates, and camera-ready deadlines
- **Track Management**: Organize papers into multiple tracks with assigned reviewers
- **Session Scheduling**: Schedule presentation dates, times, and assign panelists
- **Submission Overview**: View all submissions with advanced search and filtering capabilities
- **Leaderboard System**: Automatic ranking based on reviewer and panelist scores

### 📝 Submission and Collaboration

- **Unique Paper Codes**: Generate shareable codes for co-author access
- **Edit Capabilities**: Primary authors can edit submissions before review deadline
- **Track Selection**: Choose appropriate tracks for paper categorization
- **Multi-Author Support**: Primary and co-author role management

### 👥 Peer Review and Decision
- **Reviewer Dashboard**: View assigned papers by track
- **Comprehensive Evaluation**: Score papers on originality, relevance, technical quality, clarity, and impact
- **Detailed Feedback**: Provide remarks and recommendations (Accept/Minor Revisions/Major Revisions/Reject)
- **Mean Score Calculation**: Automatic aggregation of review scores
- **Duplicate Prevention**: System prevents multiple reviews by the same reviewer
- **Result Publication**: Automated email notifications to authors upon acceptance decision

### 📅 Scheduling and Presentation
- **Automated Scheduling**: Session dates and times assigned to tracks
- **Real-Time Updates**: Authors see presentation schedules on their dashboard
- **Session Links**: Direct access links for panelists to active sessions
- **Email Notifications**: Automatic reminders to panelists and authors

### 🏆 Live Evaluation and Result Generation
- **Digital Evaluation Forms**: Panelists score presentations in real-time
- **Score Aggregation**: Combines reviewer mean scores with panelist scores
- **Average Calculation**: Automatic computation of final scores
- **Leaderboard Generation**: Ranked display of papers by track with visual indicators (gold, silver, bronze)
- **Status Tracking**: Complete transparency on submission progress
- **Final Results**: Automated calculation and display of conference outcomes

### 📧 Communication System
- **Automated Email Notifications**: 
  - Paper submission confirmations
  - Co-author join notifications
  - Review completion alerts
  - Acceptance/rejection notifications
  - Reviewer assignment notifications
  - Panelist schedule notifications
  - Session reminders

### 🔒 Security Features
- **OAuth 2.0 Authentication**: Secure Google Sign-In integration
- **Role-Based Authorization**: Separate authentication flows for each user role
- **Session Management**: Passport.js-based secure sessions
- **Data Validation**: Server-side validation for all inputs
- **Secure File Uploads**: Cloudinary integration with access control

---

## 🛠 Tech Stack

### Backend
- **Runtime**: Node.js (v18+)
- **Framework**: Express.js v4.x
- **Authentication**: Passport.js with Google OAuth 2.0
- **Session Management**: Express-session with secure cookies
- **File Upload**: Multer + Cloudinary
- **Email Service**: Nodemailer with SMTP

### Frontend
- **Templating Engine**: EJS (Embedded JavaScript)
- **CSS Framework**: Bootstrap 5.3.8
- **Icons**: Bootstrap Icons
- **JavaScript**: Vanilla JS for dynamic interactions
- **Alerts**: SweetAlert2

### Database
- **Database**: Supabase (PostgreSQL)
- **ORM**: Supabase JavaScript Client
- **Tables**: 
  - `users` - User profiles
  - `conferences` - Conference details
  - `conference_tracks` - Track management
  - `submissions` - Paper submissions
  - `peer_review` - Review scores and feedback
  - `final_camera_ready_submissions` - Final submissions
  - `chair` - Conference chair credentials

### External Services
- **Cloud Storage**: Cloudinary for document management
- **Authentication**: Google OAuth 2.0

### DevOps & Deployment
- **Version Control**: Git & GitHub
- **Environment Management**: dotenv
- **Process Manager**: PM2 (recommended)
- **Deployment Platform**: Render/Heroku/DigitalOcean

---

## 🏗 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Layer (Browser)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Author UI  │  │  Reviewer UI │  │   Chair UI   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS / OAuth 2.0
┌────────────────────────┴────────────────────────────────────┐
│                   Application Layer (Node.js)                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Express.js Application                   │   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────┐   │   │
│  │  │   Routes   │  │Middleware  │  │ Controllers  │   │   │
│  │  └────────────┘  └────────────┘  └──────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Authentication Layer                     │   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────┐   │   │
│  │  │ Passport.js│  │Google OAuth│  │Session Store │   │   │
│  │  └────────────┘  └────────────┘  └──────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
┌────────────────────────┴────────────────────────────────────┐
│                    External Services                         │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │   Supabase   │  │  Cloudinary  │                         │
│  │  (Database)  │  │ (File Store) │                         │
│  └──────────────┘  └──────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Installation

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Supabase account
- Google Cloud Console account (for OAuth)
- Cloudinary account

### Step 1: Clone the Repository

```bash
git clone https://github.com/GurumaujSatsangi/ConfEase.git
cd ConfEase
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Set Up Environment Variables

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=3000
NODE_ENV=development

# Supabase Configuration
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_key

# Google OAuth - Author
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Google OAuth - Reviewer
GOOGLE_CLIENT_ID2=your_google_reviewer_client_id
GOOGLE_CLIENT_SECRET2=your_google_reviewer_client_secret

# Google OAuth - Chair
GOOGLE_CLIENT_ID3=your_google_chair_client_id
GOOGLE_CLIENT_SECRET3=your_google_chair_client_secret

# Session Secret
SESSION_SECRET=your_random_session_secret

# Cloudinary Configuration
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret


# Email Configuration (Nodemailer)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_app_password
```

### Step 4: Set Up Supabase Database

Run the following SQL in your Supabase SQL editor:

```sql
-- Create users table
CREATE TABLE users (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  profile_picture TEXT,
  role TEXT DEFAULT 'author',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create chair table
CREATE TABLE chair (
  email_id TEXT PRIMARY KEY,
  name TEXT,
  uid TEXT,
  profile_picture TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create conferences table
CREATE TABLE conferences (
  conference_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  conference_start_date DATE,
  conference_end_date DATE,
  full_paper_submission DATE,
  acceptance_notification DATE,
  camera_ready_paper_submission DATE,
  brochure TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create conference_tracks table
CREATE TABLE conference_tracks (
  track_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conference_id UUID REFERENCES conferences(conference_id) ON DELETE CASCADE,
  track_name TEXT NOT NULL,
  track_reviewers TEXT[],
  presentation_date DATE,
  presentation_start_time TIME,
  presentation_end_time TIME,
  panelists TEXT[],
  session_code TEXT,
  status TEXT DEFAULT 'Not Scheduled',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create submissions table
CREATE TABLE submissions (
  submission_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conference_id UUID REFERENCES conferences(conference_id) ON DELETE CASCADE,
  track_id UUID REFERENCES conference_tracks(track_id),
  paper_code UUID UNIQUE,
  primary_author TEXT NOT NULL,
  co_authors TEXT[],
  title TEXT NOT NULL,
  abstract TEXT,
  file_url TEXT,
  submission_status TEXT DEFAULT 'Submitted for Review',
  score NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create peer_review table
CREATE TABLE peer_review (
  review_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  submission_id UUID REFERENCES submissions(submission_id) ON DELETE CASCADE,
  conference_id UUID REFERENCES conferences(conference_id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  review_status TEXT DEFAULT 'Pending',
  originality_score NUMERIC,
  relevance_score NUMERIC,
  technical_quality_score NUMERIC,
  clarity_score NUMERIC,
  impact_score NUMERIC,
  mean_score NUMERIC,
  remarks TEXT,
  acceptance_status TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create final_camera_ready_submissions table
CREATE TABLE final_camera_ready_submissions (
  final_submission_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  submission_id UUID REFERENCES submissions(submission_id) ON DELETE CASCADE,
  conference_id UUID REFERENCES conferences(conference_id) ON DELETE CASCADE,
  track_id UUID REFERENCES conference_tracks(track_id),
  primary_author TEXT,
  co_authors TEXT[],
  title TEXT,
  abstract TEXT,
  file_url TEXT,
  panelist_score NUMERIC,
  status TEXT DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_submissions_conference ON submissions(conference_id);
CREATE INDEX idx_submissions_track ON submissions(track_id);
CREATE INDEX idx_tracks_conference ON conference_tracks(conference_id);
CREATE INDEX idx_reviews_submission ON peer_review(submission_id);
```

### Step 5: Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create three separate OAuth 2.0 clients (Author, Reviewer, Chair)
3. Add authorized redirect URIs:
   - `http://localhost:3000/auth/google/dashboard` (Author)
   - `http://localhost:3000/auth2/google/dashboard2` (Reviewer)
   - `http://localhost:3000/auth3/google/dashboard3` (Chair)
4. Add your production URLs when deploying

### Step 6: Run the Application

#### Development Mode
```bash
npm start
```

#### Production Mode (with PM2)
```bash
npm install -g pm2
pm2 start index.js --name confease
pm2 save
pm2 startup
```

The application will be available at `http://localhost:3000`

---

## ⚙️ Configuration

### Cloudinary Setup
1. Sign up at [Cloudinary](https://cloudinary.com/)
2. Get your cloud name, API key, and API secret
3. Add to `.env` file

### Email Configuration (Gmail)
1. Enable 2-factor authentication on your Gmail account
2. Generate an [App Password](https://myaccount.google.com/apppasswords)
3. Use the app password in `EMAIL_PASSWORD` env variable



---

## 📖 Usage

### For Conference Chairs

1. **Login**: Use the Chair login portal with authorized Google account
2. **Create Conference**: 
   - Navigate to "Create New Conference"
   - Fill in conference details, deadlines, and tracks
   - Assign reviewers to each track
3. **Manage Submissions**: View all submissions with filtering and search
4. **Publish Results**: Click "Publish Review Results" after review deadline
5. **Schedule Sessions**: Set presentation dates, times, and panelists
6. **View Leaderboard**: Check ranked submissions by track

### For Authors

1. **Login**: Sign in with Google (Author portal)
2. **Submit Paper**:
   - Select conference and track
   - Upload PDF/DOCX file
   - Fill in title and abstract
   - Submit to receive unique paper code
3. **Share with Co-Authors**: Provide paper code to collaborators
4. **Track Progress**: Monitor submission status on dashboard
5. **Submit Final Version**: Upload camera-ready paper after acceptance
6. **View Presentation Schedule**: Check date and time on dashboard

### For Co-Authors

1. **Login**: Sign in with Google
2. **Join Paper**: Enter paper code received from primary author
3. **View Submission**: Access paper details and status
4. **Edit Submission**: Collaborate on edits (if permitted)

### For Reviewers

1. **Login**: Use Reviewer login portal
2. **View Assigned Papers**: See submissions in your assigned tracks
3. **Review Papers**:
   - Download and read submission
   - Score on 5 criteria (1-5 scale)
   - Provide detailed remarks
   - Submit recommendation
4. **Track Reviews**: See completed reviews on dashboard

### For Panelists

1. **Enter Session**: Use session link or code
2. **Validate Timing**: System checks if within scheduled time
3. **Score Presentations**: Rate each paper during presentation
4. **Submit Scores**: Contribute to final ranking

---

## 👥 User Roles

### 🎩 Conference Chair
- Full administrative access
- Create and manage conferences
- Assign reviewers and panelists
- View all submissions and reviews
- Publish results
- Schedule sessions

### ✍️ Primary Author
- Submit papers
- Generate paper codes
- Edit submissions (before deadline)
- View review feedback
- Submit final camera-ready versions
- View presentation schedules

### 🤝 Co-Author
- Join papers using paper code
- View submission details
- Collaborate on edits (with primary author)
- Receive notifications

### 🔍 Reviewer
- View assigned papers by track
- Submit detailed reviews and scores
- Provide acceptance recommendations
- Track review progress

### 👨‍⚖️ Panelist
- Access live session evaluations
- Score presentations in real-time
- Submit qualitative feedback

---

## 🗄️ Database Schema

### Core Tables

#### `users`
- uid (PK)
- name
- email (unique)
- profile_picture
- role

#### `conferences`
- conference_id (PK)
- title
- description
- Important dates (submission, acceptance, camera-ready)

#### `conference_tracks`
- track_id (PK)
- conference_id (FK)
- track_name
- track_reviewers (array)
- presentation details
- panelists (array)

#### `submissions`
- submission_id (PK)
- conference_id (FK)
- track_id (FK)
- paper_code (unique)
- authors
- content details
- status

#### `peer_review`
- review_id (PK)
- submission_id (FK)
- reviewer
- scores (5 criteria)
- mean_score
- remarks

#### `final_camera_ready_submissions`
- final_submission_id (PK)
- submission_id (FK)
- panelist_score
- status

---

## 📡 API Documentation

### Authentication Endpoints

```
GET  /auth/google                        - Initiate Author OAuth
GET  /auth/google/dashboard              - Author OAuth callback
GET  /auth2/google                       - Initiate Reviewer OAuth
GET  /auth2/google/dashboard2            - Reviewer OAuth callback
GET  /auth3/google                       - Initiate Chair OAuth
GET  /auth3/google/dashboard3            - Chair OAuth callback
GET  /logout                             - Logout user
```

### Public Endpoints

```
GET  /                                   - Home page with active conferences
GET  /login                              - Login selection page
```

### Author Endpoints

```
GET  /dashboard                          - Author dashboard
GET  /submission/primary-author/:id      - Submit paper form
POST /submit                             - Submit new paper
GET  /submission/edit/primary-author/:id - Edit submission form
POST /edit-submission                    - Update submission
GET  /submission/delete/primary-author/:id - Delete submission
GET  /submission/co-author/:id           - Join as co-author form
POST /join                               - Join paper as co-author
GET  /submission/final-camera-ready/primary-author/:id - Final submission form
POST /final-camera-ready-submission      - Submit final version
```

### Chair Endpoints

```
GET  /chair/dashboard                                - Chair dashboard
GET  /chair/create-new-conference                    - Create conference form
POST /create-new-conference                          - Create conference
GET  /chair/dashboard/edit-conference/:id            - Edit conference form
POST /chair/dashboard/update-conference/:id          - Update conference
GET  /chair/dashboard/delete-conference/:id          - Delete conference
GET  /chair/dashboard/view-submissions/:id           - View submissions
POST /publish/review-results                         - Publish results
GET  /chair/dashboard/manage-sessions/:id            - Manage sessions
GET  /chair/dashboard/edit-sessions/:id              - Edit session
POST /chair/dashboard/set-session/:id                - Set session details
```

### Reviewer Endpoints

```
GET  /reviewer/dashboard                 - Reviewer dashboard
GET  /reviewer/dashboard/review/:id      - Review paper form
POST /mark-as-reviewed                   - Submit review
```

### Panelist Endpoints

```
GET  /panelist/dashboard                 - Panelist dashboard
GET  /panelist/active-session/:id        - Active session view
POST /start-session                      - Start session
POST /mark-presentation-as-complete      - Submit panelist score
```

---



---

## 🤝 Contributing

We welcome contributions! Please follow these steps:

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```
3. **Commit your changes**
   ```bash
   git commit -m 'Add some amazing feature'
   ```
4. **Push to the branch**
   ```bash
   git push origin feature/amazing-feature
   ```
5. **Open a Pull Request**

### Code Style Guidelines
- Use ES6+ syntax
- Follow consistent indentation (2 spaces)
- Add comments for complex logic
- Write descriptive commit messages
- Test your changes locally

---

## 🐛 Bug Reports

Found a bug? Please open an issue with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Screenshots (if applicable)
- Environment details (Node version, browser, etc.)

---



## 📊 Project Statistics

![GitHub stars](https://img.shields.io/github/stars/GurumaujSatsangi/ConfEase?style=social)
![GitHub forks](https://img.shields.io/github/forks/GurumaujSatsangi/ConfEase?style=social)
![GitHub issues](https://img.shields.io/github/issues/GurumaujSatsangi/ConfEase)
![GitHub pull requests](https://img.shields.io/github/issues-pr/GurumaujSatsangi/ConfEase)

---

<div align="center">

**Made with ❤️ by Gurumauj Satsangi**

[⬆ Back to Top](#dei-conference-management-toolkit-confease)

</div>
