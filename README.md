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
- **Revision Submission**: Authors can upload revised papers after revision feedback
- **Co-Author Requests**: Invite co-authors to join submissions with accept/reject workflow

### 👥 Peer Review and Decision
- **Reviewer Dashboard**: View assigned papers by track
- **Comprehensive Evaluation**: Score papers on originality, relevance, technical quality, clarity, and impact
- **Detailed Feedback**: Provide remarks and recommendations (Accept/Reject/Revision Required)
- **Mean Score Calculation**: Automatic aggregation of review scores
- **Duplicate Prevention**: System prevents multiple reviews by the same reviewer
- **Revision Workflow**: Authors can submit revised papers if requested by reviewers
- **Re-Review System**: Reviewers can evaluate revised papers separately
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

### 🔒 Security & Row Level Security (RLS)

### RLS Implementation

The application implements **comprehensive Row Level Security (RLS)** across all 12 database tables to ensure:

✅ **Data Isolation**: Users can only access data they're authorized to view
✅ **Role-Based Access**: Automatic enforcement at the database level
✅ **JWT Authentication**: Policies validate JWT claims from auth token
✅ **Email-Based Identification**: Primary identifier across all policies
✅ **52+ Granular Policies**: Fine-tuned access control per table per role

### RLS Architecture

```
User Login (OAuth 2.0)
        ↓
Passport Strategy Assignment
        ↓
JWT Created with Claims:
  - email (user's email)
  - role (author/reviewer/chair/invitee)
  - sub (user ID)
        ↓
Database Query
        ↓
RLS Policy Evaluation (using JWT claims)
        ↓
Row-Level Filtering (automatically applied)
```

### User Roles & JWT Claims

| Role | Strategy | JWT Role Claim | Use Case |
|------|----------|----------------|----------|
| Author | `/auth/google` | `author` | Paper submission & revision |
| Reviewer | `/auth2/google` | `reviewer` | Peer review & re-review |
| Chair | `/auth3/google` | `chair` | Full administrative control |
| Invitee | `/auth4/google` | `invitee` | Invited talks & panelist duties |
| Anonymous | None | `anon` | Public conference viewing |

### RLS Policies by Table (52 Total)

**Conferences** (4 policies): Public read, chair write
**Conference Tracks** (4 policies): Public read, chair write
**Submissions** (7 policies): Author/reviewer/chair role-based access
**Users** (4 policies): Self-service + authenticated access
**Chair** (2 policies): Chair-only management
**Peer Review** (5 policies): Reviewer/chair access
**Final Camera Ready Submissions** (3 policies): Author/chair access
**Revised Submissions** (5 policies): Author/reviewer/chair access
**Co-Author Requests** (5 policies): Author/co-author/chair access
**Invitees** (3 policies): Invitee/chair access
**Invited Talk Submissions** (5 policies): Invitee/chair access
**Poster Sessions** (2 policies): Public read, chair write

### RLS Documentation Files

- **`RLS_MIGRATION.sql`** (22 KB)
  - Production-ready SQL with all 52 policies
  - Drop-safe with `DROP IF EXISTS` patterns
  - Ready to execute in Supabase SQL Editor
  - Deployment time: ~2 seconds

- **`RLS_QUICKSTART.md`** (8 KB)
  - 6-step deployment guide
  - Test procedures for each role
  - Common issues & fixes
  - Rollback instructions

- **`RLS_POLICIES_BY_TABLE.md`** (40+ KB)
  - Table-by-table policy breakdown
  - Policy conditions and logic
  - JWT claims reference
  - Type casting solutions

- **`RLS_POLICY_GUIDE.md`** (16 KB)
  - Comprehensive technical documentation
  - Architecture overview
  - SQL examples
  - Troubleshooting section

- **`RLS_ARCHITECTURE_DIAGRAMS.md`** (24 KB)
  - System architecture flow diagrams
  - RLS policy enforcement flow
  - Role-based access patterns
  - Defense-in-depth architecture

### Key Security Features

✅ **Email-Based Identification**: All policies use email as primary identifier
✅ **Type Safety**: Proper UUID/VARCHAR casting in all policies
✅ **Array Operations**: Safe co-author array checks using `@>` operator
✅ **Subquery Safety**: Foreign key joins with proper casting
✅ **Least Privilege**: Each role gets only required permissions
✅ **No Data Leakage**: Unauthenticated users limited to public tables only

### JWT Claims Extraction in Policies

```sql
-- Extract role from JWT
(current_setting('request.jwt.claims', true)::json ->> 'role') = 'author'

-- Extract email from JWT
(current_setting('request.jwt.claims', true)::json ->> 'email')

-- Check if authenticated
auth.role() = 'authenticated'
```

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
- **Database**: Supabase (PostgreSQL) with **Row Level Security (RLS)**
- **ORM**: Supabase JavaScript Client
- **Security**: JWT-based RLS policies for role-based access control
- **Tables (12 total, all RLS-enabled)**: 
  - `conferences` - Conference details (public read, chair write)
  - `conference_tracks` - Track management (public read, chair write)
  - `submissions` - Paper submissions (author/reviewer/chair role-based)
  - `users` - User profiles (authenticated users only)
  - `chair` - Conference chair credentials (chair only)
  - `peer_review` - Review scores and feedback (reviewer/chair access)
  - `final_camera_ready_submissions` - Final submissions (author/chair)
  - `revised_submissions` - Revised papers (author/reviewer/chair)
  - `co_author_requests` - Co-author collaboration requests (author/co-author)
  - `invitees` - Invited speakers/panelists (invitee/chair)
  - `invited_talk_submissions` - Invited talk submissions (invitee/chair)
  - `poster_session` - Poster sessions (public read, chair write)

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

#### Option A: Run RLS Migration Script (Recommended)

1. **Enable RLS on all tables** using the provided migration script:
   - Copy the contents of `RLS_MIGRATION.sql`
   - Paste into your Supabase SQL Editor
   - Execute to enable RLS with 52+ granular policies
   - **⚠️ Important**: Use the `service_role` key with Admin privileges

2. **RLS Policy Documentation**:
   - See `RLS_POLICIES_BY_TABLE.md` for detailed policy reference
   - See `RLS_QUICKSTART.md` for deployment guide
   - See `RLS_POLICY_GUIDE.md` for comprehensive technical documentation
   - See `RLS_ARCHITECTURE_DIAGRAMS.md` for visual architecture

#### Option B: Manual Table Creation

Run the following SQL in your Supabase SQL editor:

```sql
-- Create users table
CREATE TABLE users (
  id INT8 PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  uid VARCHAR UNIQUE,
  email VARCHAR UNIQUE NOT NULL,
  name TEXT,
  contact_number INT8,
  organization TEXT,
  profile_picture VARCHAR
);

-- Create chair table
CREATE TABLE chair (
  id INT8 PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email_id VARCHAR UNIQUE NOT NULL,
  name TEXT,
  uid VARCHAR,
  profile_picture VARCHAR
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
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create conference_tracks table
CREATE TABLE conference_tracks (
  track_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conference_id VARCHAR,
  track_name TEXT,
  track_reviewers TEXT[],
  presentation_date DATE,
  presentation_start_time TIME,
  presentation_end_time TIME,
  panelists VARCHAR,
  status TEXT DEFAULT 'Not Scheduled'
);

-- Create submissions table
CREATE TABLE submissions (
  submission_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conference_id VARCHAR,
  track_id TEXT,
  paper_code VARCHAR,
  primary_author VARCHAR NOT NULL,
  co_authors TEXT[],
  title TEXT NOT NULL,
  abstract TEXT,
  file_url VARCHAR,
  submission_status TEXT DEFAULT 'Submitted for Review',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create peer_review table
CREATE TABLE peer_review (
  id INT8 PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  conference_id VARCHAR,
  submission_id VARCHAR NOT NULL,
  reviewer TEXT NOT NULL,
  originality_score FLOAT4,
  relevance_score FLOAT4,
  technical_quality_score FLOAT4,
  clarity_score FLOAT4,
  impact_score FLOAT4,
  mean_score FLOAT4,
  acceptance_status TEXT,
  remarks TEXT,
  review_status TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create final_camera_ready_submissions table
CREATE TABLE final_camera_ready_submissions (
  submission_id UUID PRIMARY KEY,
  conference_id VARCHAR,
  title TEXT,
  abstract TEXT,
  track_id TEXT,
  co_authors TEXT,
  file_url VARCHAR,
  status TEXT,
  panelist_score FLOAT4,
  primary_author TEXT
);

-- Create revised_submissions table
CREATE TABLE revised_submissions (
  submission_id VARCHAR PRIMARY KEY,
  file_url VARCHAR,
  originally_score FLOAT4,
  relevance_score FLOAT4,
  technical_quality_score FLOAT4,
  clarity_score FLOAT4,
  impact_score FLOAT4,
  mean_score FLOAT4,
  acceptance_status TEXT,
  review_status TEXT
);

-- Create co_author_requests table
CREATE TABLE co_author_requests (
  request_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conference_id VARCHAR,
  submission_id VARCHAR NOT NULL,
  primary_author VARCHAR,
  co_author VARCHAR,
  status TEXT
);

-- Create invitees table
CREATE TABLE invitees (
  invite_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT,
  email VARCHAR,
  conference_id VARCHAR
);

-- Create invited_talk_submissions table
CREATE TABLE invited_talk_submissions (
  paper_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invitee_email VARCHAR,
  conference_id VARCHAR,
  title TEXT,
  abstract TEXT,
  file_url VARCHAR,
  track_id TEXT
);

-- Create poster_session table
CREATE TABLE poster_session (
  poster_session_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conference_id VARCHAR,
  date DATE,
  start_time TIME,
  end_time TIME
);

-- Create indexes for better performance
CREATE INDEX idx_submissions_primary_author ON submissions(primary_author);
CREATE INDEX idx_submissions_conference ON submissions(conference_id);
CREATE INDEX idx_submissions_track ON submissions(track_id);
CREATE INDEX idx_peer_review_submission ON peer_review(submission_id);
CREATE INDEX idx_peer_review_reviewer ON peer_review(reviewer);
CREATE INDEX idx_tracks_conference ON conference_tracks(conference_id);
CREATE INDEX idx_co_author_requests_submission ON co_author_requests(submission_id);
CREATE INDEX idx_invitees_email ON invitees(email);
CREATE INDEX idx_invited_talks_email ON invited_talk_submissions(invitee_email);

-- After creating tables, enable RLS and apply policies from RLS_MIGRATION.sql
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

### Supabase Configuration

#### Enable RLS Policies

1. **Go to SQL Editor** in Supabase Dashboard
2. **Copy entire contents** of `RLS_MIGRATION.sql`
3. **Paste into SQL Editor**
4. **Execute the script**
   - ⚠️ **Important**: Use the `service_role` key (not anon key)
   - Must have Admin privileges
5. **Verify policies** were created:
   ```sql
   SELECT schemaname, tablename, policyname, cmd, qual 
   FROM pg_policies 
   ORDER BY tablename;
   ```

#### JWT Configuration (Automatic)

Supabase automatically adds JWT claims when using authenticated clients:
- `current_setting('request.jwt.claims')` extracts the JWT payload
- Policies parse email and role from these claims
- No additional configuration needed

#### Verify RLS is Working

Test in your application:
1. Login as **Author** → Can see only own submissions
2. Login as **Reviewer** → Can see all submissions
3. Login as **Chair** → Can see/edit all data
4. Logout → Can see only public conferences/tracks



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
5. **Revision Submission** (if requested):
   - Navigate to "Submit Revised Paper" link on dashboard
   - Upload revised version
   - Resubmit for re-review
6. **Submit Final Version**: Upload camera-ready paper after acceptance
7. **View Presentation Schedule**: Check date and time on dashboard
8. **View All Feedback**: See both initial review and re-review scores on camera-ready submission page

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
   - Provide recommendation (Accept/Reject/Revision Required)
   - Submit review
4. **Re-Review Revised Papers** (if applicable):
   - View "Revised Submissions" section on dashboard
   - Click "Review Revised Paper" for papers requiring revision
   - Re-evaluate the revised version with same scoring criteria
   - Make final decision (Accept/Reject - no revision option)
5. **Track Reviews**: See completed reviews on dashboard

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

#### `revised_submissions`
- revised_submission_id (PK)
- submission_id (FK)
- file_url
- review_status
- scores (5 criteria)
- mean_score
- acceptance_status

#### `co_author_requests`
- request_id (PK)
- submission_id (FK)
- co_author_email
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
GET  /submission/revised/primary-author/:id - Submit revised paper form
POST /submit-revised-paper               - Submit revised paper
GET  /submission/final-camera-ready/primary-author/:id - Final submission form
POST /final-camera-ready-submission      - Submit final version
POST /co-author-request/accept/:request_id - Accept co-author request
POST /co-author-request/reject/:request_id - Reject co-author request
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
GET  /reviewer/dashboard                 - Reviewer dashboard with Review & Revised Submissions sections
GET  /reviewer/dashboard/review/:id      - Review paper form
POST /mark-as-reviewed                   - Submit initial review
GET  /reviewer/dashboard/re-review/:id   - Re-review revised paper form
POST /mark-as-re-reviewed                - Submit re-review
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

## 🔧 Troubleshooting RLS Issues

### Problem: "User cannot see their own submissions"

**Solution**:
1. Verify `primary_author` is stored as **exact email** (case-sensitive)
2. Check JWT contains correct email in claims
3. Verify `submissions_read_authors` policy is enabled:
   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'submissions' AND policyname = 'submissions_read_authors';
   ```
4. Test with browser DevTools:
   - Network tab → Authorization header
   - Decode JWT to verify `email` claim

### Problem: "operator does not exist: uuid = text"

**Solution**:
- Check table schema for submission_id type
- Use proper type casting: `submissions.submission_id::text`
- Verify `RLS_MIGRATION.sql` includes type casts

### Problem: "Reviewer cannot see all submissions"

**Solution**:
1. Verify reviewer role is set correctly in JWT (should be `reviewer`)
2. Check `submissions_read_reviewers` policy exists
3. Verify reviewer email is in track_reviewers array
4. Test: SELECT with chair role (should always work)

### Problem: "RLS policy not working after deployment"

**Solution**:
1. Confirm RLS is **ENABLED** on table:
   ```sql
   SELECT relrowsecurity FROM pg_class WHERE relname = 'submissions';
   ```
   Should return `true`

2. Check service_role key was used during deployment
3. Verify all policies have `DROP IF EXISTS` before `CREATE POLICY`
4. Run entire `RLS_MIGRATION.sql` script in order

### Problem: "Anonymous users see no data"

**Expected behavior**: RLS properly restricts anonymous users to public tables only:
- ✅ Can see: conferences, conference_tracks, poster_session
- ❌ Cannot see: submissions, peer_review, user data, etc.

Use authenticated client for non-public data access.

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
