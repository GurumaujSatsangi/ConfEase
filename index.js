import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import passport from "passport";
import { v4 as uuidv4 } from "uuid";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import bcrypt from "bcrypt";
import pool from "./config/db.js";
import {PDFParse} from 'pdf-parse';
import {
  detectAIText,
  isAIGenerated,
  getConfidenceScore,
} from "ai-text-detector";

import { Strategy as LocalStrategy } from "passport-local";
import jwt from "jsonwebtoken";
import session from "express-session";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { fileURLToPath } from "url";
import path from "path";
import multer from "multer";
import fs from "fs/promises";
import { name } from "ejs";
import crypto from "crypto";
import { sendMail } from "./mailer.js"
import events from 'events';
// Increase EventEmitter default listener limit to avoid MaxListenersExceededWarning in long-running dev flow
events.defaultMaxListeners = 20;

const app = express();





dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB limit to match UI hint and handling
});

// Multer error handler middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const referer = req.get('referer') || '';

    if (err.code === 'LIMIT_FILE_SIZE') {
      if (referer.includes('/invitee')) {
        return res.redirect('/invitee/dashboard?message=Error: File size exceeds 4MB limit. Please upload a smaller file.');
      } else {
        return res.redirect('/dashboard?message=Error: File size exceeds 4MB limit. Please upload a smaller file.');
      }
    } else if (err.code === 'LIMIT_PART_COUNT') {
      if (referer.includes('/invitee')) {
        return res.redirect('/invitee/dashboard?message=Error: Too many file parts. Please try again.');
      } else {
        return res.redirect('/dashboard?message=Error: Too many file parts. Please try again.');
      }
    }

    if (referer.includes('/invitee')) {
      return res.redirect(`/invitee/dashboard?message=Error: ${err.message}`);
    } else {
      return res.redirect(`/dashboard?message=Error: ${err.message}`);
    }
  }

  next(err);
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});


const port = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${port}`;
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static("public"));
app.set("view engine", "ejs");
app.use("/static", express.static(path.join(__dirname, "public")));

app.set("views", path.join(__dirname, "views"));
// Session middleware must be registered before passport.session()
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Middleware functions for authentication
function checkAuth(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) {
      return res.redirect("/login");
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret");
      req.user = decoded;
      next();
    } catch (err) {
      return res.redirect("/login");
    }
  } catch (err) {
    console.error("checkAuth error:", err);
    return res.redirect("/login");
  }
}

function checkChairAuth(req, res, next) {
  try {
    const chairToken = req.cookies.ChairToken;
    if (!chairToken) {
      return res.redirect("/login");
    }
    try {
      const decoded = jwt.verify(chairToken, process.env.JWT_SECRET || "dev_jwt_secret");
      req.user = decoded;
      next();
    } catch (err) {
      return res.redirect("/login");
    }
  } catch (err) {
    console.error("checkChairAuth error:", err);
    return res.redirect("/login");
  }
}

function checkAuthOrChair(req, res, next) {
  try {
    const token = req.cookies.token;
    const chairToken = req.cookies.ChairToken;
    
    if (!token && !chairToken) {
      return res.redirect("/login");
    }
    
    const tokenToUse = token || chairToken;
    try {
      const decoded = jwt.verify(tokenToUse, process.env.JWT_SECRET || "dev_jwt_secret");
      req.user = decoded;
      next();
    } catch (err) {
      return res.redirect("/login");
    }
  } catch (err) {
    console.error("checkAuthOrChair error:", err);
    return res.redirect("/login");
  }
}

// Middleware: accept either Passport session or a JWT (Authorization header or jwt cookie)
function ensureAuthenticatedOrToken(req, res, next) {
  try {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return next();
    }

    // Try Authorization: Bearer <token>
    const authHeader = req.headers && req.headers.authorization;
    if (authHeader) {
      const parts = authHeader.split(" ");
      if (parts.length === 2 && parts[0] === "Bearer") {
        try {
          req.user = jwt.verify(parts[1], process.env.JWT_SECRET || "dev_jwt_secret");
          return next();
        } catch (err) {
          // invalid token
          return res.redirect("/");
        }
      }
    }

    // Try jwt cookie from header (no cookie-parser dependency required)
    const cookieHeader = req.headers && req.headers.cookie;
    if (cookieHeader) {
      const jwtCookie = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith("jwt="));
      if (jwtCookie) {
        const token = jwtCookie.split("=")[1];
        try {
          req.user = jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret");
          return next();
        } catch (err) {
          return res.redirect("/");
        }
      }
    }

    return res.redirect("/");
  } catch (err) {
    console.error("ensureAuthenticatedOrToken error:", err);
    return res.redirect("/");
  }
}



// Login: use passport local strategy and return JWT
app.get('/auth4/google/dashboard4', (req, res, next) => {
  passport.authenticate('google4', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      const msg = info && info.message ? info.message : 'Authentication failed';
      return res.redirect('/?message=' + encodeURIComponent(msg));
    }
    req.logIn(user, (err) => {
      if (err) return next(err);
      return res.redirect('/invitee/dashboard');
    });
  })(req, res, next);
});


// Health check endpoint for Docker
app.get("/health", async (req, res) => {
  try {
    // Check database connection
    await pool.query("SELECT 1");
    res.status(200).json({ 
      status: "healthy", 
      timestamp: new Date().toISOString(),
      database: "connected"
    });
  } catch (error) {
    res.status(503).json({ 
      status: "unhealthy", 
      timestamp: new Date().toISOString(),
      database: "disconnected",
      error: error.message
    });
  }
});


app.get("/", async (req, res) => {
 
  const message = req.query.message || null;
  const result = await pool.query("SELECT * FROM conferences");
  const data = result.rows;
  
  // Format dates to dd-mm-yyyy
  const formattedData = data.map(conference => {
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    return {
      ...conference,
      conference_start_date: formatDate(conference.conference_start_date),
      conference_end_date: formatDate(conference.conference_end_date),
      full_paper_submission: formatDate(conference.full_paper_submission),
      acceptance_notification: formatDate(conference.acceptance_notification),
      camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission)
    };
  });
  
  res.render("home.ejs", { conferences: formattedData, message: message });
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

app.get(
  "/auth2/google",
  passport.authenticate("google2", {
    scope: ["profile", "email"],
  })
);

app.get(
  "/auth3/google",
  passport.authenticate("google3", {
    scope: ["profile", "email"],
  })
);

app.get(
  "/auth4/google",
  passport.authenticate("google4", {
    scope: ["profile", "email"],
  })
);


app.get(
  "/auth2/google/dashboard2",
  passport.authenticate("google2", {
    failureRedirect:
      "/?message=You have not been assigned any tracks. Please contact the conference organizers for more information.",
    successRedirect: "/reviewer/dashboard",
  })
);

app.get("/reviewer/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "reviewer") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    // Fetch all tracks
    const trackResult = await pool.query(`SELECT * FROM conference_tracks`);
    const tracks = trackResult.rows;

    // Filter reviewer tracks
    const reviewerTracks = tracks.filter(
      (track) =>
        Array.isArray(track.track_reviewers) &&
        track.track_reviewers.includes(req.user.email)
    ).map(track => ({
      ...track,
      presentation_date: formatDate(track.presentation_date)
    }));

    if (reviewerTracks.length === 0) {
      return res.redirect(
        "/?message=You are not authorized as a reviewer for any track."
      );
    }

    // Fetch submissions for assigned tracks
    const trackIds = reviewerTracks.map((t) => t.track_id);

    let submissiondata = [];
    if (trackIds.length > 0) {
      const placeholders = trackIds.map((_, i) => `$${i + 1}`).join(",");
      const submissionQuery = `SELECT * FROM submissions WHERE track_id IN (${placeholders})`;
      const submissionResult = await pool.query(submissionQuery, trackIds);
      submissiondata = submissionResult.rows;
    }

    // Fetch revised submissions for these tracks
    let revisedSubmissions = [];
    if (trackIds.length > 0) {
      const placeholders = trackIds.map((_, i) => `$${i + 1}`).join(",");
      const revisedQuery = `SELECT * FROM submissions WHERE track_id IN (${placeholders}) AND submission_status = $${trackIds.length + 1}`;
      const revisedResult = await pool.query(revisedQuery, [...trackIds, "Submitted Revised Paper"]);
      revisedSubmissions = revisedResult.rows;
    }

    // Fetch conference information for tracks
    const conferenceIds = [...new Set(reviewerTracks.map(track => track.conference_id))];
    let conferences = [];
    if (conferenceIds.length > 0) {
      const confPlaceholders = conferenceIds.map((_, i) => `$${i + 1}`).join(",");
      const confQuery = `SELECT * FROM conferences WHERE conference_id IN (${confPlaceholders})`;
      const confResult = await pool.query(confQuery, conferenceIds);
      conferences = confResult.rows.map(conference => ({
        ...conference,
        conference_start_date: formatDate(conference.conference_start_date),
        conference_end_date: formatDate(conference.conference_end_date),
        full_paper_submission: formatDate(conference.full_paper_submission),
        acceptance_notification: formatDate(conference.acceptance_notification),
        camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission)
      }));
    }

    // Create conference map for easy lookup
    const conferenceMap = {};
    conferences.forEach(conf => {
      conferenceMap[conf.conference_id] = conf;
    });

    // Add conference info to tracks
    const tracksWithConferences = reviewerTracks.map(track => ({
      ...track,
      conference: conferenceMap[track.conference_id] || {}
    }));

    return res.render("reviewer/dashboard", {
      user: req.user,
      tracks: tracksWithConferences,
      userSubmissions: submissiondata,
      revisedSubmissions: revisedSubmissions,
    });
  } catch (err) {
    console.error("Error loading reviewer dashboard:", err);
    return res.redirect(
      "/?message=We are facing some issues. Please try again later."
    );
  }
});


app.get(
  "/auth3/google/dashboard3",
  passport.authenticate("google3", {
    failureRedirect: "/?message=You are not authorized to access this page.",
    successRedirect: "/chair/dashboard",
  }),
  async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/");

    try {
      // Fetch all tracks
      const trackResult = await pool.query(`SELECT * FROM conference_tracks`);
      const tracks = trackResult.rows;

      // Filter reviewer tracks
      const reviewerTracks = tracks.filter(
        (track) =>
          Array.isArray(track.track_reviewers) &&
          track.track_reviewers.includes(req.user.email)
      );

      if (reviewerTracks.length === 0) {
        return res.render("error.ejs", {
          message:
            "You are not assigned to any tracks. Please contact the conference organizers for more information.",
        });
      }

      // Get all track IDs assigned to the reviewer
      const trackIds = reviewerTracks.map((t) => t.track_id);

      // Fetch submissions for these tracks
      let submissiondata = [];
      if (trackIds.length > 0) {
        const placeholders = trackIds.map((_, i) => `$${i + 1}`).join(",");
        const submissionQuery = `SELECT * FROM submissions WHERE track_id IN (${placeholders})`;
        const submissionResult = await pool.query(submissionQuery, trackIds);
        submissiondata = submissionResult.rows;
      }

      return res.render("reviewer/dashboard", {
        user: req.user,
        tracks: reviewerTracks,
        userSubmissions: submissiondata,
      });
    } catch (err) {
      console.error("Error loading chair-backed reviewer dashboard:", err);
      return res.render("error.ejs", {
        message:
          "We are facing some issues in fetching your assigned tracks. Please try again later.",
      });
    }
  }
);


app.get("/error", (req, res) => {
  res.render("error.ejs", { message });
});

app.get("/panelist/dashboard", checkAuth, (req, res) => {
  res.render("panelist/dashboard.ejs", { message: req.query.message || null });
});

app.get("/invitee/dashboard", checkAuth, async (req, res) => {
 

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    //
    // 0. Look up conference_id from the invitees table
    //
    const inviteeResult = await pool.query(
      `SELECT conference_id FROM invitees WHERE email = $1 LIMIT 1`,
      [req.user.email]
    );
    const conferenceId = inviteeResult.rows[0]?.conference_id || null;

    //
    // 1. Fetch conference details
    //
    let conference = null;
    if (conferenceId) {
      const conferenceResult = await pool.query(
        `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1`,
        [conferenceId]
      );
      conference = conferenceResult.rows[0] || null;
    }

    if (conference) {
      // Format conference dates
      conference.conference_start_date = formatDate(conference.conference_start_date);
      conference.conference_end_date = formatDate(conference.conference_end_date);
      conference.full_paper_submission = formatDate(conference.full_paper_submission);
      conference.acceptance_notification = formatDate(conference.acceptance_notification);
      conference.camera_ready_paper_submission = formatDate(conference.camera_ready_paper_submission);
    }

    //
    // 2. Fetch invitee's submissions
    //
    let submissionsWithTrackNames = [];
    if (conferenceId) {
      const submissionsResult = await pool.query(
        `SELECT * FROM invited_talk_submissions 
         WHERE conference_id = $1 AND invitee_email = $2`,
        [conferenceId, req.user.email]
      );
      const submissions = submissionsResult.rows;

      //
      // 3. Fetch tracks for this conference
      //
      const tracksResult = await pool.query(
        `SELECT track_id, track_name
         FROM conference_tracks
         WHERE conference_id = $1`,
        [conferenceId]
      );
      const tracks = tracksResult.rows;

      // Create a map of track_id → track_name
      const trackMap = {};
      tracks.forEach(track => {
        trackMap[track.track_id] = track.track_name;
      });

      // Enrich submissions with track names
      submissionsWithTrackNames = submissions.map(submission => ({
        ...submission,
        track_name: trackMap[submission.track_id] || submission.track_id || "N/A",
      }));
    }

    //
    // 4. Render dashboard
    //
    res.render("invitee/dashboard.ejs", {
      user: req.user,
      conference,
      submissions: submissionsWithTrackNames,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Error loading invitee dashboard:", err);
    return res.status(500).send("Server error loading dashboard.");
  }
});


app.get('/auth/google/dashboard', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      const msg = info && info.message ? info.message : 'Authentication failed';
      return res.redirect('/?message=' + encodeURIComponent(msg));
    }
    req.logIn(user, (err) => {
      if (err) return next(err);
      return res.redirect('/dashboard');
    });
  })(req, res, next);
});



app.get(
  "/auth4/google/dashboard4",
  passport.authenticate("google4", {
    failureRedirect: "/?message=You are not authorized as an invited speaker.",
    successRedirect: "/invitee/dashboard",
  }),
  (req, res) => {
    // This handler will be called after successful login
    res.redirect("/invitee/dashboard");
  }
);

// =====================
// Utilities
// =====================
function formatDateISO(dateString) {
  if (!dateString) return dateString;
  // DB dates are already 'YYYY-MM-DD' strings thanks to pg type parser
  if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateString)) {
    return dateString.slice(0, 10);
  }
  // Fallback for Date objects (e.g. new Date())
  const date = new Date(dateString);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentDateIST() {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istTime.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// =====================
// Data Fetch Functions
// =====================
async function fetchAllConferences() {
  const result = await pool.query("SELECT * FROM conferences");
  return result.rows.map(c => ({
    ...c,
    conference_start_date: formatDateISO(c.conference_start_date),
    conference_end_date: formatDateISO(c.conference_end_date),
    full_paper_submission: formatDateISO(c.full_paper_submission),
    acceptance_notification: formatDateISO(c.acceptance_notification),
    camera_ready_paper_submission: formatDateISO(c.camera_ready_paper_submission),
  }));
}

async function fetchUserSubmissions(email) {
  const result = await pool.query(
    `SELECT * FROM submissions
     WHERE primary_author = $1
     OR $1 = ANY(co_authors);`,
    [email]
  );
  return result.rows;
}

async function fetchTrackIds(email) {
  const result = await pool.query(
    `SELECT track_id
     FROM submissions
     WHERE primary_author = $1
     OR $1 = ANY(co_authors);`,
    [email]
  );
  return [...new Set(result.rows.map(r => r.track_id).filter(Boolean))];
}

async function fetchPresentationTracks(trackIds) {
  if (!trackIds.length) return [];
  const result = await pool.query(
    `SELECT * FROM conference_tracks WHERE track_id = ANY($1);`,
    [trackIds]
  );
  return result.rows.map(t => ({
    ...t,
    presentation_date: formatDateISO(t.presentation_date),
  }));
}

async function fetchUserNamesByEmails(emails) {
  if (!emails.length) return {};
  const result = await pool.query(
    `SELECT email, name FROM users WHERE email = ANY($1);`,
    [emails]
  );
  const map = {};
  result.rows.forEach(u => (map[u.email] = u.name));
  return map;
}

function enrichSubmissions(submissions, tracks, emailToNameMap) {
  const trackMap = {};
  tracks.forEach(t => (trackMap[t.track_id] = t.track_name));

  const formatNameEmail = email => {
    const name = emailToNameMap[email];
    return name ? `${name} (${email})` : email;
  };

  return submissions.map(sub => ({
    ...sub,
    track_name: trackMap[sub.track_id] || "Track name not available",
    primary_author_formatted: formatNameEmail(sub.primary_author),
    co_authors_formatted: Array.isArray(sub.co_authors)
      ? sub.co_authors.map(formatNameEmail).join(", ")
      : "",
  }));
}

async function fetchCoAuthorRequests(submissionIds) {
  if (!submissionIds.length) return [];
  const result = await pool.query(
    `SELECT * FROM co_author_requests WHERE submission_id = ANY($1);`,
    [submissionIds]
  );
  return result.rows;
}

async function fetchRevisedSubmissions(submissionIds) {
  if (!submissionIds.length) return {};
  const result = await pool.query(
    `SELECT submission_id, file_url
     FROM revised_submissions
     WHERE submission_id = ANY($1);`,
    [submissionIds]
  );
  const map = {};
  result.rows.forEach(r => (map[r.submission_id] = r.file_url));
  return map;
}

async function fetchPosterSessions(submissions) {
  const conferenceIds = [
    ...new Set(
      submissions
        .filter(s =>
          s.submission_status === "Accepted for Poster Presentation" ||
          s.submission_status === "Submitted Final Camera Ready Paper for Poster Presentation"
        )
        .map(s => s.conference_id)
    ),
  ];

  if (!conferenceIds.length) return {};
  const result = await pool.query(
    `SELECT * FROM poster_session WHERE conference_id = ANY($1);`,
    [conferenceIds]
  );

  const map = {};
  result.rows.forEach(ps => (map[ps.conference_id] = ps));
  return map;
}

function buildTrackDetailsMap(tracks) {
  const map = {};
  tracks.forEach(t => (map[t.track_id] = t));
  return map;
}

async function isReviewer(email){
const data = await pool.query("select * from conference_tracks where $1=ANY(track_reviewers)",[email]);
let result;
if(data.rows.length>0){
  result = true;
}
else{
  result = false;
}
return result;
}


async function isInvitee(email){
const data = await pool.query("select * from invitees where email=$1",[email]);
let result;
if(data.rows.length>0){
  result = true;
}
else{
  result = false;
}
return result;
}


async function isSessionChair(email){
const data = await pool.query("select * from conference_tracks where $1=any(panelists)",[email]);
let result;
if(data.rows.length>0){
  result = true;
}
else{
  result = false;
}
return result;
}

app.get("/score-posters/:id",checkAuth,async(req,res)=>{

  const data = await pool.query("select * from submissions where conference_id = $1 and submission_status=$2",[req.params.id,"Submitted Final Camera Ready Paper for Poster Presentation"]);
 const  result = data.rows;
  res.render("score-posters.ejs",{result, user:req.user})

})

app.post("/submit-poster-score/:conference_id/:submission_id",checkAuth, async(req,res)=>{

  const score = Number.parseInt(req.body.score, 10);
  const conference_id = req.params.conference_id;
  const submission_id = req.params.submission_id;

  if (!Number.isInteger(score)) {
    return res.redirect("/score-posters/" + conference_id + "?message=Invalid score value.");
  }

  await pool.query(
    "update submissions set submission_status=$1 where conference_id=$2 and submission_id=$3",
    ["Poster Scored", conference_id, submission_id]
  );
  await pool.query(
    "insert into poster_presentation_scores values ($1,$2,$3,$4)",
    [conference_id, submission_id, score, req.user.email]
  );

  return res.redirect("/score-posters/"+conference_id+"?message=Poster has been scored succesfully!");



});


async function isPosterCoordinator(email){
const data = await pool.query("select * from poster_session where coodinators LIKE '%' || $1 || '%'",[email]);
let result;
if(data.rows.length>0){
  result = true;
}
else{
  result = false;
}
return result;
}


async function fetchConference(id){
  const data = await pool.query("select * from conferences where conference_id =  $1",[id]);
  return data;
}

app.get("/submission/view-co-author-requests/:id",checkAuth, async(req,res)=>{

  const submissions = await pool.query("select * from submissions where submission_id=$1",[req.params.id]);
  const results = await pool.query("select * from co_author_requests where submission_id=$1 and primary_author=$2",[req.params.id,req.user.email]);

  

  return res.render("co-author-requests",{
    result:results.rows,
  submission: submissions.rows[0]
});

})

app.get("/reviewer/:id", checkAuth, async(req,res)=>{
  try {
    const reviewerEmail = req.user.email;

    // 1. Get tracks where this reviewer is assigned for this conference
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks
       WHERE conference_id = $1
       AND track_reviewers @> ARRAY[$2];`,
      [req.params.id, reviewerEmail]
    );

    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDateISO(track.presentation_date)
    }));

    // 2. Fetch the conference
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1;`,
      [req.params.id]
    );
    const conference = conferenceResult.rows[0];

    // Attach conference info to each track
    const tracksWithConferences = tracks.map(track => ({
      ...track,
      conference: conference || {}
    }));

    // 3. Fetch submissions for these tracks
    const trackIds = tracks.map(t => t.track_id);
    let userSubmissions = [];
    if (trackIds.length > 0) {
      const subResult = await pool.query(
        `SELECT * FROM submissions WHERE track_id = ANY($1);`,
        [trackIds]
      );
      userSubmissions = subResult.rows;
    }

    // 4. Fetch revised submissions for these tracks
    let revisedSubmissions = [];
    if (trackIds.length > 0) {
      const revisedResult = await pool.query(
        `SELECT * FROM submissions 
         WHERE track_id = ANY($1)
         AND submission_status = 'Submitted Revised Paper';`,
        [trackIds]
      );
      revisedSubmissions = revisedResult.rows;
    }

    return res.render("reviewer_dashboard", {
      user: req.user,
      userSubmissions,
      revisedSubmissions,
      tracks: tracksWithConferences,
    });

  } catch (err) {
    console.error("Reviewer Dashboard Error:", err);
    return res.status(500).send("Error loading reviewer dashboard.");
  }
});






// =====================
// Dashboard Route
// =====================
app.get("/dashboard", checkAuth, async (req, res) => {
  

  try {
    const isSessionChairResult = await isSessionChair(req.user.email);
    const isInviteeResult = await isInvitee(req.user.email);
    const isReviewerResult = await isReviewer(req.user.email);
    const isPosterCoordinatorResult = await isPosterCoordinator(req.user.email);
    const conferences = await fetchAllConferences();
    const submissions = await fetchUserSubmissions(req.user.email);
    const trackIds = await fetchTrackIds(req.user.email);
    const presentationTracks = await fetchPresentationTracks(trackIds);

    const result = await pool.query("select * from invited_talk_submissions where invitee_email = $1",[req.user.email]);
    
    
    
    const emailSet = new Set();
    submissions.forEach(s => {  
      emailSet.add(s.primary_author);
      if (Array.isArray(s.co_authors)) s.co_authors.forEach(e => emailSet.add(e));
    });

    const emailToNameMap = await fetchUserNamesByEmails([...emailSet]);
    const userSubmissions = enrichSubmissions(
      submissions,
      presentationTracks,
      emailToNameMap
    );

    const primarySubmissionIds = submissions
      .filter(s => s.primary_author === req.user.email)
      .map(s => s.submission_id);

    const coAuthorRequests = await fetchCoAuthorRequests(primarySubmissionIds);
    const revisedSubmissionsMap = await fetchRevisedSubmissions(primarySubmissionIds);
    const posterSessionsMap = await fetchPosterSessions(submissions);
    const trackDetailsMap = buildTrackDetailsMap(presentationTracks);

  

    res.render("dashboard.ejs", {
      user: req.user,
      conferences,
      userSubmissions,
      isReviewerResult,
      invitedTalkSubmissions: result.rows,
      isSessionChairResult,
      isInviteeResult,
      isPosterCoordinatorResult,
      presentationdata: presentationTracks,
      coAuthorRequests,
      revisedSubmissionsMap,
      posterSessionsMap,
      trackDetailsMap,
      currentDate: getCurrentDateIST(),
      message: req.query.message || null,
    });
  } catch (err) {
    console.error(err);
    res.redirect(
      "/?message=We are facing issues connecting to the database. Please try again later."
    );
  }
});

app.get("/create-new-announcement", checkChairAuth, async(req,res)=>{
  res.render("chair/new-announcement.ejs")
})

app.post("/publish-announcement",checkChairAuth,async(req,res)=>{
  const {title, body} = req.body;
  const user=req.user;

  const result = await pool.query("insert into announcements values($1,$2,$3)",[title,body,user.email]);
  if(result){
    res.redirect("/chair/dashboard?message=Announcement Posted Succesfully!");
  }
})


app.get("/announcements", checkAuthOrChair, async(req,res)=>{
  const data = await pool.query("select * from announcements");


  res.render("announcements.ejs",{announcements:data.rows})
})

app.post("/publish/review-results", checkChairAuth, async (req, res) => {
 

  const { conference_id } = req.body;

  if (!conference_id) {
    return res.status(400).send("Invalid or missing conference_id.");
  }

  const confId = conference_id;

  try {
    // 1. Fetch all review rows for this conference
    const reviewResult = await pool.query(
      `SELECT * FROM peer_review WHERE conference_id = $1;`,
      [confId]
    );
    const reviewdata = reviewResult.rows;

    // 2. Fetch conference title (for emails)
    const confTitleResult = await pool.query(
      `SELECT title FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [confId]
    );
    const conferenceTitle = confTitleResult.rows[0]?.title || "Conference";

    // 3. Process each review entry
    for (const reviewRow of reviewdata) {
      // Update submission status
      await pool.query(
        `UPDATE submissions
         SET submission_status = $1
         WHERE submission_id = $2;`,
        [reviewRow.acceptance_status, reviewRow.submission_id]
      );

      // Fetch submission metadata for email
      const submissionResult = await pool.query(
        `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
        [reviewRow.submission_id]
      );
      const submissionData = submissionResult.rows[0];
      if (!submissionData) continue;

      // Email notification
      try {
        const coAuthors = Array.isArray(submissionData.co_authors) ? submissionData.co_authors : [];
        const ccEmails = coAuthors.length ? coAuthors.join(",") : null;

        const isAccepted = reviewRow.acceptance_status.includes("Accepted");
        const statusMessage = isAccepted
          ? "We are pleased to inform you that your paper has been accepted!"
          : "We regret to inform you that your paper has not been accepted.";

        await sendMail(
          submissionData.primary_author,
          `${reviewRow.acceptance_status} - ${submissionData.title}`,
          `Your paper "${submissionData.title}" submitted to ${conferenceTitle} has been ${reviewRow.acceptance_status.toLowerCase()}.`,
          `<p>Dear Author,</p>
           <p>${statusMessage}</p>
           <p><strong>Paper Title:</strong> ${submissionData.title}</p>
           <p><strong>Conference:</strong> ${conferenceTitle}</p>
           <p><strong>Decision:</strong> ${reviewRow.acceptance_status}</p>
           <p><strong>Review Score:</strong> ${Number(reviewRow.mean_score).toFixed(2)}/5</p>
           ${
             isAccepted
               ? "<p>Please prepare your final camera-ready paper for publication.</p>"
               : "<p>We thank you for your submission and encourage you to apply again in the future.</p>"
           }
           <p>For any assistance, contact <strong>multimedia@dei.ac.in</strong> or <strong>+91 9875691340</strong>.</p>
           <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`,
          ccEmails
        );
      } catch (emailErr) {
        console.error(`Email error for submission ${reviewRow.submission_id}:`, emailErr);
      }
    }

    return res.redirect(
      "/chair/dashboard?message=Review results have been successfully published."
    );

  } catch (err) {
    console.error("Error publishing review results:", err);
    return res.status(500).send("Error publishing review results.");
  }
});

app.get("/reviewer/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "reviewer") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    const reviewerEmail = req.user.email;

    //
    // 1. Get tracks where this reviewer is assigned
    //    Equivalent of: .contains("track_reviewers", [reviewerEmail])
    //
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks
       WHERE track_reviewers @> ARRAY[$1];`,
      [reviewerEmail]
    );

    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDate(track.presentation_date)
    }));


    //
    // 2. Fetch conferences for these tracks
    //
    const conferenceIds = [...new Set(tracks.map(t => t.conference_id))];

    let conferences = [];
    if (conferenceIds.length > 0) {
      const confResult = await pool.query(
        `SELECT * FROM conferences WHERE conference_id = ANY($1);`,
        [conferenceIds]
      );
      conferences = confResult.rows.map(conference => ({
        ...conference,
        conference_start_date: formatDate(conference.conference_start_date),
        conference_end_date: formatDate(conference.conference_end_date),
        full_paper_submission: formatDate(conference.full_paper_submission),
        acceptance_notification: formatDate(conference.acceptance_notification),
        camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission)
      }));
    }

    // Create lookup map
    const conferenceMap = {};
    conferences.forEach(conf => {
      conferenceMap[conf.conference_id] = conf;
    });

    // Attach conference info to each track
    const tracksWithConferences = tracks.map(track => ({
      ...track,
      conference: conferenceMap[track.conference_id] || {}
    }));


    //
    // 3. Fetch submissions for these tracks
    //
    const trackIds = tracks.map(t => t.track_id);

    let userSubmissions = [];
    if (trackIds.length > 0) {
      const subResult = await pool.query(
        `SELECT * FROM submissions WHERE track_id = ANY($1);`,
        [trackIds]
      );
      userSubmissions = subResult.rows;
    }


    //
    // 4. Fetch revised submissions for these tracks
    //
    let revisedSubmissions = [];
    if (trackIds.length > 0) {
      const revisedResult = await pool.query(
        `SELECT * FROM submissions 
         WHERE track_id = ANY($1)
         AND submission_status = 'Submitted Revised Paper';`,
        [trackIds]
      );
      revisedSubmissions = revisedResult.rows;
    }


    //
    // 5. Render page
    //
    return res.render("reviewer/dashboard.ejs", {
      user: req.user,
      userSubmissions,
      revisedSubmissions,
      tracks: tracksWithConferences,
    });

  } catch (err) {
    console.error("Reviewer Dashboard Error:", err);
    return res.status(500).send("Error loading reviewer dashboard.");
  }
});

app.get("/chair/dashboard/edit-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates for HTML date inputs (yyyy-mm-dd)
    const formatDateForInput = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Fetch track by track_id
    const trackResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE track_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const trackRaw = trackResult.rows[0];

    if (!trackRaw) {
      return res.status(404).send("Track not found.");
    }

    const track = {
      ...trackRaw,
      presentation_date: formatDateForInput(trackRaw.presentation_date)
    };

    res.render("chair/edit-sessions.ejs", {
      user: req.user,
      trackid: req.params.id,
      track,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Error fetching track:", err);
    return res.status(500).send("Error fetching sessions.");
  }
});

app.get("/virtual-poster-presentation/:id" , async(req,res)=>{
 
    const posters = await pool.query("select * from submissions where conference_id=$1 and submission_status = 'Submitted Final Camera Ready Paper for Poster Presentation'",[req.params.id]);
    
   
    const conference = await fetchConference(posters.rows[0].conference_id);
    return res.render("virtual-poster-presentation",{posters:posters.rows[0],conference:conference});

});

app.get(
  "/chair/dashboard/manage-sessions/:id",
  checkChairAuth,
  async (req, res) => {
    try {
      // ---------- helper ----------
      const formatDate = (dateString) => {
        if (!dateString) return dateString;
        const d = new Date(dateString);
        return `${String(d.getUTCDate()).padStart(2, "0")}-${String(
          d.getUTCMonth() + 1
        ).padStart(2, "0")}-${d.getUTCFullYear()}`;
      };

      // ---------- conference ----------
      const confResult = await pool.query(
        `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1`,
        [req.params.id]
      );

      const conferenceRaw = confResult.rows[0];
      const conference = {
        ...conferenceRaw,
        conference_start_date: formatDate(conferenceRaw.conference_start_date),
        conference_end_date: formatDate(conferenceRaw.conference_end_date),
        full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
        acceptance_notification: formatDate(
          conferenceRaw.acceptance_notification
        ),
        camera_ready_paper_submission: formatDate(
          conferenceRaw.camera_ready_paper_submission
        ),
      };

      // ---------- tracks ----------
      const tracksResult = await pool.query(
        `SELECT * FROM conference_tracks WHERE conference_id = $1`,
        [req.params.id]
      );

      const tracks = tracksResult.rows.map((t) => ({
        ...t,
        presentation_date: formatDate(t.presentation_date),
      }));

      // ---------- leaderboard submissions (ONLY presentation completed) ----------
      const leaderboardSubsResult = await pool.query(
        `SELECT * FROM submissions
         WHERE conference_id = $1
         AND submission_status = $2`,
        [req.params.id, "Presentation Completed"]
      );
      const leaderboardSubs = leaderboardSubsResult.rows;

      // ---------- count per track ----------
      const trackCounts = {};
      leaderboardSubs.forEach((s) => {
        trackCounts[s.track_id] = (trackCounts[s.track_id] || 0) + 1;
      });

      const count = tracks.map((t) => ({
        track_id: t.track_id,
        track_name: t.track_name,
        count: trackCounts[t.track_id] || 0,
      }));

      // ---------- build per-track data ----------
      const tracksWithData = await Promise.all(
        tracks.map(async (track) => {
          // ===== LEADERBOARD =====
          const trackLeaderboardSubs = leaderboardSubs.filter(
            (s) => s.track_id === track.track_id
          );

          const leaderboard = await Promise.all(
            trackLeaderboardSubs.map(async (sub) => {
              // reviewer scores
              const reviewResult = await pool.query(
                `SELECT mean_score FROM peer_review WHERE submission_id = $1`,
                [sub.submission_id]
              );

              let reviewerScore = null;
              if (reviewResult.rows.length > 0) {
                reviewerScore =
                  reviewResult.rows.reduce(
                    (sum, r) => sum + (r.mean_score || 0),
                    0
                  ) / reviewResult.rows.length;
              }

              // panelist score
              const panelistResult = await pool.query(
                `SELECT panelist_score
                 FROM final_camera_ready_submissions
                 WHERE submission_id = $1
                 LIMIT 1`,
                [sub.submission_id]
              );

              const panelistScore =
                panelistResult.rows[0]?.panelist_score ?? null;

              // combined avg
              let averageScore = null;
              if (reviewerScore !== null && panelistScore !== null)
                averageScore = (reviewerScore + panelistScore) / 2;
              else averageScore = reviewerScore ?? panelistScore;

              // author names
              const emails = [
                sub.primary_author,
                ...(sub.co_authors || []),
              ];
              const usersResult = await pool.query(
                `SELECT email, name FROM users WHERE email = ANY($1)`,
                [emails]
              );

              const userMap = Object.fromEntries(
                usersResult.rows.map((u) => [u.email, u.name])
              );
              const fmt = (e) => (userMap[e] ? `${userMap[e]} (${e})` : e);

              return {
                ...sub,
                reviewerScore:
                  reviewerScore !== null ? +reviewerScore.toFixed(2) : null,
                panelistScore:
                  panelistScore !== null ? +panelistScore.toFixed(2) : null,
                averageScore:
                  averageScore !== null ? +averageScore.toFixed(2) : null,
                primary_author_formatted: fmt(sub.primary_author),
                co_authors_formatted: (sub.co_authors || [])
                  .map(fmt)
                  .join(", "),
              };
            })
          );

          const ranked = leaderboard
            .filter((l) => l.averageScore !== null)
            .sort((a, b) => b.averageScore - a.averageScore)
            .map((l, i) => ({ ...l, rank: i + 1 }));

          const unranked = leaderboard
            .filter((l) => l.averageScore === null)
            .map((l) => ({ ...l, rank: null }));

          // ===== FINAL CAMERA READY TABLE =====
          const finalCameraReadyResult = await pool.query(
            `SELECT *
             FROM submissions
             WHERE conference_id = $1
             AND track_id = $2
             AND submission_status = $3`,
            [
              req.params.id,
              track.track_id,
              "Submitted Final Camera Ready Paper for Oral Presentation",
            ]
          );

          // Format author names for final camera ready papers
          const finalCameraReadyFormatted = finalCameraReadyResult.rows.map(paper => ({
            ...paper,
            primary_author_formatted: fmt(paper.primary_author),
            co_authors_formatted: (paper.co_authors || [])
              .map(fmt)
              .join(", ")
          }));

          return {
            ...track,
            leaderboard: [...ranked, ...unranked],
            finalCameraReadyPapers: finalCameraReadyFormatted,
          };
        })
      );

      // ---------- render ----------
      res.render("chair/manage-sessions.ejs", {
        user: req.user,
        tracks: tracksWithData,
        conference,
        count,
        message: req.query.message || null,
      });
    } catch (err) {
      console.error("manage-sessions error:", err);
      res.status(500).send("Error fetching data");
    }
  }
);





app.get("/chair/dashboard/manage-poster-sessions/:id", checkChairAuth,async (req, res) => {
 

  try {
    // Helper function to format dates for display (dd-mm-yyyy)
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    // Helper function to format dates for HTML date inputs (yyyy-mm-dd)
    const formatDateForInput = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    const confRaw = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );

    const conference = {
      ...confRaw.rows[0],
      conference_start_date: formatDate(confRaw.rows[0].conference_start_date),
      conference_end_date: formatDate(confRaw.rows[0].conference_end_date),
      full_paper_submission: formatDate(confRaw.rows[0].full_paper_submission),
      acceptance_notification: formatDate(confRaw.rows[0].acceptance_notification),
      camera_ready_paper_submission: formatDate(confRaw.rows[0].camera_ready_paper_submission)
    };

    const posterSessionResult = await pool.query(
      `SELECT * FROM poster_session WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const posterSessionRaw = posterSessionResult.rows[0] || {};
    const posterSession = posterSessionRaw.date ? {
      ...posterSessionRaw,
      date: formatDateForInput(posterSessionRaw.date)
    } : posterSessionRaw;

    const posterSubsResult = await pool.query(
      `SELECT * FROM submissions
       WHERE conference_id = $1
       AND submission_status = 'Submitted Final Camera Ready Paper for Poster Presentation';`,
      [req.params.id]
    );
    const posterSubmissions = posterSubsResult.rows;

    // ---------- leaderboard submissions (ONLY presentation completed) ----------
    const leaderboardSubsResult = await pool.query(
      `SELECT * FROM submissions
       WHERE conference_id = $1
       AND submission_status = $2`,
      [req.params.id, "Poster Scored"]
    );
    const leaderboardSubs = leaderboardSubsResult.rows;

    // Build leaderboard with scores
    const leaderboard = await Promise.all(
      leaderboardSubs.map(async (sub) => {
        // reviewer scores
        const reviewResult = await pool.query(
          `SELECT mean_score FROM peer_review WHERE submission_id = $1`,
          [sub.submission_id]
        );

        let reviewerScore = null;
        if (reviewResult.rows.length > 0) {
          reviewerScore =
            reviewResult.rows.reduce(
              (sum, r) => sum + (r.mean_score || 0),
              0
            ) / reviewResult.rows.length;
        }

        // panelist score
        const panelistResult = await pool.query(
          `SELECT panelist_score
           FROM final_camera_ready_submissions
           WHERE submission_id = $1
           LIMIT 1`,
          [sub.submission_id]
        );

        const panelistScore =
          panelistResult.rows[0]?.panelist_score ?? null;

        // combined avg
        let averageScore = null;
        if (reviewerScore !== null && panelistScore !== null)
          averageScore = (reviewerScore + panelistScore) / 2;
        else averageScore = reviewerScore ?? panelistScore;

        // author names
        const emails = [
          sub.primary_author,
          ...(sub.co_authors || []),
        ];
        const usersResult = await pool.query(
          `SELECT email, name FROM users WHERE email = ANY($1)`,
          [emails]
        );

        const userMap = Object.fromEntries(
          usersResult.rows.map((u) => [u.email, u.name])
        );
        const fmt = (e) => (userMap[e] ? `${userMap[e]} (${e})` : e);

        return {
          ...sub,
          reviewerScore:
            reviewerScore !== null ? +reviewerScore.toFixed(2) : null,
          panelistScore:
            panelistScore !== null ? +panelistScore.toFixed(2) : null,
          averageScore:
            averageScore !== null ? +averageScore.toFixed(2) : null,
          primary_author_formatted: fmt(sub.primary_author),
          co_authors_formatted: (sub.co_authors || [])
            .map(fmt)
            .join(", "),
        };
      })
    );

    const ranked = leaderboard
      .filter((l) => l.averageScore !== null)
      .sort((a, b) => b.averageScore - a.averageScore)
      .map((l, i) => ({ ...l, rank: i + 1 }));

    const unranked = leaderboard
      .filter((l) => l.averageScore === null)
      .map((l) => ({ ...l, rank: null }));

    const finalLeaderboard = [...ranked, ...unranked];

    const allEmails = new Set();
    posterSubmissions.forEach(sub => {
      allEmails.add(sub.primary_author);
      (sub.co_authors || []).forEach(e => allEmails.add(e));
    });

    let usersMap = {};
    if (allEmails.size > 0) {
      const userResult = await pool.query(
        `SELECT email, name FROM users WHERE email = ANY($1);`,
        [Array.from(allEmails)]
      );
      usersMap = Object.fromEntries(userResult.rows.map(u => [u.email, u.name]));
    }

    const fmt = e => usersMap[e] ? `${usersMap[e]} (${e})` : e;

    const posterSubmissionsFormatted = posterSubmissions.map(sub => ({
      ...sub,
      primary_author_formatted: fmt(sub.primary_author),
      co_authors_formatted: (sub.co_authors || []).map(fmt).join(", ")
    }));

    res.render("chair/manage-poster-sessions.ejs", {
      user: req.user,
      conference,
      posterSession,
      submissions: posterSubmissionsFormatted,
      leaderboard: finalLeaderboard,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("manage-poster-sessions error:", err);
    res.status(500).send("Error fetching data.");
  }
});


app.post("/chair/dashboard/set-poster-session/:id", checkChairAuth, async (req, res) => {
  

  const { session_date, start_time, end_time, conference_id,coordinators } = req.body;
 try {
  // Split comma-separated coordinators into an array
  const coordinatorArray = coordinators
    ? coordinators.split(',').map(e => e.trim()).filter(e => e !== '')
    : [];

  await pool.query(
  `UPDATE poster_session
   SET date = $1,
       start_time = $2,
       end_time = $3,
       coodinators = $4
   WHERE conference_id = $5;`,
  [session_date, start_time, end_time, coordinatorArray, conference_id]
);


    res.redirect(
      `/chair/dashboard/manage-poster-sessions/${conference_id}?message=Poster session details saved successfully.`
    );

  } catch (err) {
    console.error("Error updating poster session:", err);
    return res.redirect(
      `/chair/dashboard/manage-poster-sessions/${conference_id}?message=Error setting poster session.`
    );
  }
});


app.post("/chair/dashboard/set-session/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    const { session_date, start_time, end_time, panelists, conference_id } = req.body;
    const trackId = req.params.id;

    // Convert panelists input → cleaned array
    const panelistArray = panelists
      ? panelists.split(",").map(p => p.trim()).filter(p => p !== "")
      : [];

    await pool.query(
      `UPDATE conference_tracks
       SET presentation_date = $1,
           presentation_start_time = $2,
           presentation_end_time = $3,
           panelists = $4,
           status = 'Scheduled'
       WHERE track_id = $5;`,
      [session_date, start_time, end_time, panelistArray, trackId]
    );

    res.redirect(`/chair/dashboard/manage-sessions/${conference_id || ""}`);

  } catch (err) {
    console.error("Error setting session:", err);
    return res.status(500).send("Error setting up the session.");
  }
});


app.get("/panelist/active-session/:id", checkAuth, async (req, res) => {
  try {
    // 1. Fetch track info
    const trackResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1 and $2=any(panelists)`,
      [req.params.id,req.user.email]
    );
    const trackinfo = trackResult.rows[0];

    if (!trackinfo) {
      return res.redirect("/dashboard?message=Track not found.");
    }

    // 2. Session time enforcement
    let session_end_iso = null;
    try {
      if (
        trackinfo.presentation_date &&
        trackinfo.presentation_start_time &&
        trackinfo.presentation_end_time
      ) {
        const istOffset = 5.5 * 60 * 60 * 1000;
        const dateStr = trackinfo.presentation_date instanceof Date
          ? trackinfo.presentation_date.toISOString().slice(0, 10)
          : String(trackinfo.presentation_date);
        const [y, mo, d] = dateStr.split("-").map(Number);
        const startTimeStr = String(trackinfo.presentation_start_time);
        const endTimeStr = String(trackinfo.presentation_end_time);
        const [sh, sm] = startTimeStr.split(":").map(Number);
        const [eh, em] = endTimeStr.split(":").map(Number);

        const startUtcMs = Date.UTC(y, mo - 1, d, sh, sm) - istOffset;
        const endUtcMs = Date.UTC(y, mo - 1, d, eh, em) - istOffset;
        const nowUtcMs = Date.now();
        const bufferMs = 5 * 60 * 1000;

        if (nowUtcMs < (startUtcMs - bufferMs)) {
          return res.redirect('/dashboard?message=Session not started yet.');
        }

        if (nowUtcMs > endUtcMs) {
          return res.redirect('/dashboard?message=Session has ended.');
        }

        session_end_iso = new Date(endUtcMs).toISOString();
      }
    } catch (timeErr) {
      console.error("Session window parse error:", timeErr);
      session_end_iso = null;
    }

    // 3. Fetch approved ORAL presentation submissions
    const sessionResult = await pool.query(
      `SELECT * FROM submissions
       WHERE track_id = $1
       AND submission_status = 'Submitted Final Camera Ready Paper for Oral Presentation'`,
      [trackinfo.track_id]
    );
    const session = sessionResult.rows;

    // Get all unique emails for name lookup
    const allEmails = new Set();
    session.forEach(s => {
      allEmails.add(s.primary_author);
      (s.co_authors || []).forEach(e => allEmails.add(e));
    });

    let usersMap = {};
    if (allEmails.size > 0) {
      const userResult = await pool.query(
        `SELECT email, name FROM users WHERE email = ANY($1);`,
        [Array.from(allEmails)]
      );
      usersMap = Object.fromEntries(userResult.rows.map(u => [u.email, u.name]));
    }

    const formatNameEmail = (email) => usersMap[email] ? `${usersMap[email]} (${email})` : email;

    // 4. For each submission, fetch reviewer mean score and panelist score
    for (const paper of session) {
      // Reviewer scores
      const revResult = await pool.query(
        `SELECT mean_score FROM peer_review WHERE submission_id = $1`,
        [paper.submission_id]
      );
      if (revResult.rows.length > 0) {
        const avg =
          revResult.rows.reduce((sum, r) => sum + (r.mean_score || 0), 0) /
          revResult.rows.length;
        paper.mean_score = avg.toFixed(2);
      } else {
        paper.mean_score = null;
      }

      // Panelist scores
      const panelResult = await pool.query(
        `SELECT panelist_score, status
         FROM final_camera_ready_submissions
         WHERE submission_id = $1`,
        [paper.submission_id]
      );
      const finalRow = panelResult.rows[0];
      paper.panelist_score = finalRow?.panelist_score || null;
      paper.presentation_status = finalRow?.status || null;

      // Add formatted author info
      paper.primary_author_formatted = formatNameEmail(paper.primary_author);
      paper.co_authors_formatted = (paper.co_authors || [])
        .map(formatNameEmail)
        .join(", ");
    }

    // 5. Render
    return res.render("panelist/active-session.ejs", {
      user:req.user,
      session,
      trackinfo,
      message: req.query.message || null,
      session_end_iso
    });

  } catch (err) {
    console.error("Error in /panelist/active-session:", err);
    return res.status(500).send("Internal Server Error");
  }
});

app.post("/send-password-reset-link",async(req,res)=>{

  const {email} = req.body;

  const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );



    const user = userResult.rows[0];
    const token = crypto.randomBytes(32).toString("hex");

    const expiresAt = new Date(Date.now() + 1000 * 60 * 15);

    await pool.query(
        `INSERT INTO password_resets (email, token, expires_at)
         VALUES ($1, $2, $3)`,
        [user.email, token, expiresAt]
    );

    const resetLink = `http://localhost:3000/reset-password/${token}`;

    console.log(resetLink);

    return res.redirect("/login/user?message=Password Reset Link has been sent to your Email ID. Kindly reset your password using that link and login using the updated credentials.")
    



})

app.get("/reset-password/:token", async (req, res) => {
    const { token } = req.params;

    const result = await pool.query(
        `SELECT * FROM password_resets
         WHERE token=$1 AND expires_at > NOW()`,
        [token]
    );

    if (result.rows.length === 0) {
        return res.status(400).send("Invalid or expired token");
    }

    res.render("login/reset-password.ejs", { token });
});




app.get("/password-reset", async(req,res)=>{

  res.render("login/password-reset");
})

app.post("/start-session", async (req, res) => {
  const { session_code } = req.body;

  try {
    // 1. Fetch track using session_code
    const trackResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE session_code = $1`,
      [session_code]
    );

    const track = trackResult.rows[0];

    if (!track) {
      return res.redirect("/panelist/dashboard?message=Invalid session code.");
    }

    // 2. Time validation (IST check)
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    const currentDate = istTime.toISOString().split("T")[0];
    const currentTime = istTime.toISOString().split("T")[1].slice(0, 5);

    if (formatDateISO(track.presentation_date) === currentDate) {
      if (currentTime < track.presentation_start_time) {
        return res.redirect("/panelist/dashboard?message=Session not started yet.");
      } else if (currentTime > track.presentation_end_time) {
        return res.redirect("/panelist/dashboard?message=Session has ended.");
      } else {
        // 3. Update track status + clear session code
        await pool.query(
          `UPDATE conference_tracks
           SET status = 'In Progress',
               session_code = NULL
           WHERE track_id = $1`,
          [track.track_id]
        );

        return res.redirect(`/panelist/dashboard/active-session/${track.track_id}`);
      }
    } else {
      return res.redirect("/panelist/dashboard?message=Session date mismatch.");
    }

  } catch (err) {
    console.error("Error in /start-session:", err);
    return res.redirect("/panelist/dashboard?message=Error starting session.");
  }
});


app.get("/review/:id", checkAuth, async (req, res) => {
 

  try {
    const paperCode = req.params.id;


    // await pool.query
    // ("insert into peer_review_vault(paper_id,status,locked_by) values ($1,$2,$3)",
    //   [req.params.id,"locked",req.user.email]);


    //
    // 1. Fetch submission by paper_code
    //
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE paper_code = $1 LIMIT 1;`,
      [paperCode]
    );

    const submissionData = submissionResult.rows[0];

    // 2. Handle missing submission
    if (!submissionData) {
      return res.render("error.ejs", {
        message: "The submission you are trying to view does not exist.",
      });
    }

    //
    // 3. Check if it was already reviewed
    //
    if (submissionData.submission_status === "Reviewed") {
      return res.render("error.ejs", {
        message: "This submission has already been reviewed.",
      });
    }

    //
    // 4. Fetch conference data
    //
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [submissionData.conference_id]
    );
    const conferenceRaw = conferenceResult.rows[0];

    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    const conferencedata = {
      ...conferenceRaw,
      conference_start_date: formatDate(conferenceRaw.conference_start_date),
      conference_end_date: formatDate(conferenceRaw.conference_end_date),
      full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDate(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(conferenceRaw.camera_ready_paper_submission)
    };

    //
    // 5. Fetch track data
    //
    const trackResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE track_id = $1 LIMIT 1;`,
      [submissionData.track_id]
    );
    const trackRaw = trackResult.rows[0];
    const trackdata = {
      ...trackRaw,
      presentation_date: formatDate(trackRaw.presentation_date)
    };

    //
    // 6. Render review page
    //
    res.render("reviewer/review", {
      user: req.user,
      userSubmissions: submissionData,
      conferencedata: conferencedata || null,
      trackdata: trackdata || null,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Error fetching review page data:", err);
    return res.render("error.ejs", {
      message: "An unexpected error occurred while loading this submission.",
    });
  }
});


app.get("/reviewer/dashboard/re-review/:id", checkAuth, async (req, res) => {


  try {
    //
    // 1. Fetch the submission by paper_code
    //
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE paper_code = $1 LIMIT 1;`,
      [req.params.id]
    );
    const submissionData = submissionResult.rows[0];

    // 2. Handle missing or failed fetch
    if (!submissionData) {
      return res.render("error.ejs", {
        message: "The submission you are trying to view does not exist.",
      });
    }

    //
    // 3. Check status
    //
    if (submissionData.submission_status !== "Submitted Revised Paper") {
      return res.render("error.ejs", {
        message: "This submission does not have a revised paper to review.",
      });
    }

    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    //
    // 4. Fetch conference data
    //
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [submissionData.conference_id]
    );
    const conferenceRaw = conferenceResult.rows[0];
    const conferencedata = {
      ...conferenceRaw,
      conference_start_date: formatDate(conferenceRaw.conference_start_date),
      conference_end_date: formatDate(conferenceRaw.conference_end_date),
      full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDate(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(conferenceRaw.camera_ready_paper_submission)
    };

    //
    // 5. Fetch track data
    //
    const trackResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE track_id = $1 LIMIT 1;`,
      [submissionData.track_id]
    );
    const trackRaw = trackResult.rows[0];
    const trackdata = {
      ...trackRaw,
      presentation_date: formatDate(trackRaw.presentation_date)
    };

    //
    // 6. Render Page
    //
    return res.render("reviewer/re-review", {
      user: req.user,
      userSubmissions: submissionData,
      conferencedata,
      trackdata,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Re-review page load error:", err);
    return res.render("error.ejs", {
      message: "An unexpected error occurred while loading the re-review page.",
    });
  }
});


app.post("/mark-as-re-reviewed", checkAuth, async (req, res) => {
  

  const {
    submission_id,
    conference_id,
    status,
    originality_score,
    relevance_score,
    technical_quality_score,
    clarity_score,
    impact_score,
    remarks,
  } = req.body;

  try {
    //
    // 1. Fetch submission for email use
    //
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [submission_id]
    );
    const submissionData = submissionResult.rows[0];

    if (!submissionData) {
      return res.redirect("/reviewer/dashboard?message=Error fetching submission details.");
    }

    //
    // 2. Compute mean score
    //
    const mean_score =
      (parseFloat(originality_score) +
        parseFloat(relevance_score) +
        parseFloat(technical_quality_score) +
        parseFloat(clarity_score) +
        parseFloat(impact_score)) / 5;

    //
    // 3. Update revised_submissions table
    //
    await pool.query(
      `UPDATE revised_submissions
       SET review_status = 'Re-Reviewed',
           originality_score = $1,
           relevance_score = $2,
           technical_quality_score = $3,
           clarity_score = $4,
           impact_score = $5,
           mean_score = $6,
           acceptance_status = $7
       WHERE submission_id = $8;`,
      [
        originality_score,
        relevance_score,
        technical_quality_score,
        clarity_score,
        impact_score,
        mean_score,
        status,
        submission_id,
      ]
    );

    //
    // 4. Update submissions table status, mean_score, and remarks
    //
   

     await pool.query(
      `UPDATE submissions
       SET submission_status = $1
       WHERE submission_id = $2;`,
      [status,submission_id]
    );

    //
    // 5. Send email notification
    //
    try {
      const conferenceResult = await pool.query(
        `SELECT acceptance_notification, title
         FROM conferences WHERE conference_id = $1 LIMIT 1;`,
        [conference_id]
      );
      const conferenceData = conferenceResult.rows[0];

      const acceptanceDate = conferenceData?.acceptance_notification
        ? new Date(conferenceData.acceptance_notification).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "the scheduled acceptance notification date";

      const conferenceTitle = conferenceData?.title || "the conference";

      const coAuthors = Array.isArray(submissionData.co_authors)
        ? submissionData.co_authors
        : [];
      const ccEmails = coAuthors.length > 0 ? coAuthors.join(",") : null;

      await sendMail(
        submissionData.primary_author,
        `Re-review Completed - ${submissionData.title}`,
        `Your revised paper "${submissionData.title}" has been re-reviewed. Results will be published on ${acceptanceDate}.`,
        `<p>Dear Author,</p>
         <p>Your revised paper titled <strong>"${submissionData.title}"</strong> has now been re-reviewed.</p>
         <p>Final acceptance results will be announced on <strong>${acceptanceDate}</strong>.</p>
         <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`,
        ccEmails
      );
    } catch (emailError) {
      console.error("Email send error (ignored):", emailError);
    }

    return res.redirect("/reviewer/"+conference_id+"?message=Revised paper review submitted successfully.");

  } catch (err) {
    console.error("Error during re-review:", err);
    return res.redirect("/reviewer/dashboard?message=Error processing re-review.");
  }
});



app.post("/chair/dashboard/manage-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const conferenceId = req.params.id;

  try {
    // 1. Fetch all tracks for this conference
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1`,
      [conferenceId]
    );
    const tracks = tracksResult.rows;

    // 2. Update each track with its session details
    for (let idx = 0; idx < tracks.length; idx++) {
      const track = tracks[idx];

      const session_date = req.body[`session_date_${idx}`];
      const session_start_time = req.body[`session_start_time_${idx}`];
      const session_end_time = req.body[`session_end_time_${idx}`];

      const session_panelists = req.body[`session_panelists_${idx}`]
        ? req.body[`session_panelists_${idx}`]
            .split(",")
            .map((e) => e.trim())
            .filter((e) => e)
        : [];

      // 3. Update session info
      await pool.query(
        `UPDATE conference_tracks
         SET presentation_date = $1,
             presentation_start_time = $2,
             presentation_end_time = $3,
             panelists = $4,
             status = 'Scheduled'
         WHERE track_id = $5`,
        [
          session_date,
          session_start_time,
          session_end_time,
          session_panelists,
          track.track_id,
        ]
      );

      // 4. Send email notifications to all panelists
      for (const panelistEmail of session_panelists) {
        try {
          await sendMail(
            panelistEmail,
            `Session Chair Assignment - ${track.track_name}`,
            `You have been assigned as a Session Chair for the track "${track.track_name}".`,
            `<p>Dear Session Chair,</p>
             <p>You have been assigned as a session chair for the following:</p>
             <p><strong>Track:</strong> ${track.track_name}</p>
             <p><strong>Presentation Date:</strong> ${session_date}</p>
             <p><strong>Time:</strong> ${session_start_time} to ${session_end_time}</p>
             <p>Please be available during the scheduled time to evaluate the presentations.</p>
             <p>In case of any technical assistance, please email <strong>multimedia@dei.ac.in</strong> or call <strong>+91 9875691340</strong>.</p>
             <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
          );
        } catch (emailError) {
          console.error(`Email error → ${panelistEmail}:`, emailError);
        }
      }
    }

    return res.redirect(`/chair/dashboard`);

  } catch (err) {
    console.error("Error managing sessions:", err);
    return res.status(500).send("Error managing sessions.");
  }
});


app.post("/user-registration", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // hash password (IMPORTANT: await)
    const hashed_password = await bcrypt.hash(password, 10);

    const check = await pool.query("select * from users where email = $1",[email]);
    if(check.rows.length===0){
        await pool.query(
      "INSERT INTO users (name, email, password) VALUES ($1, $2, $3)",
      [name, email, hashed_password]
    );

    return res.redirect("/login/user?message=Account created successfully. Please login.");

    }
    else{
          return res.redirect("/registration/user?message=Account with this Email Address already exists.");


    }

  
  } catch (err) {
    // console.error(err);
    return res.redirect("/registration/user?message=Something went wrong, please try again later.");
  }
});


app.get("/login/user", async (req,res)=>{
  const message = req.query.message || null;
  res.render("login/user", { message });
})

app.get("/registration/user", async (req,res)=>{
  const message = req.query.message || null;
  res.render("login/user2", { message });
})



app.post("/user-login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // fetch user
    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.redirect("/login/user?message=Invalid email or password");
    }

    const user = userResult.rows[0];

    // compare password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.redirect("/login/user?message=Invalid email or password");
    }

    // generate jwt
    const token = jwt.sign(
      { email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    // set cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // true in production
      sameSite: "strict",
      maxAge: 15 * 60 * 1000
    });



    // ✅ redirect instead of render
    return res.redirect("/dashboard");

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});


app.get("/admin", async(req,res)=>{
res.render("admin");
})

app.post("/create-chair-credentials",async(req,res)=>{

  const {name,email,contact_number, faculty, department, password} = req.body;

  const hashed_password= await bcrypt.hash(password, 10);
  const result = await pool.query("insert into chairs(name,email,contact_number,faculty,department, password) values($1,$2,$3,$4,$5,$6)",[name,email,contact_number, faculty,department, hashed_password]);

  if(!result){
    res.send("Error");
  }
  else{
    res.send("Chair Added & Credentials Created Succesfully !!!");
  }

});


app.post("/chair-login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // fetch user
    const userResult = await pool.query(
      "SELECT * FROM chairs WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.redirect("/login/user?message=Invalid email or password");
    }

    const user = userResult.rows[0];

    // compare password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.redirect("/login/user?message=Invalid email or password");
    }

    // generate jwt
    const ChairToken = jwt.sign(
      { email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    // set cookie with consistent options
    res.cookie("ChairToken", ChairToken, {
      httpOnly: true,
      secure: false, // true in production
      sameSite: "strict",
      path: "/",
      maxAge: 15 * 60 * 1000
    });



    // ✅ redirect instead of render
    return res.redirect("/chair/dashboard?message=Welcome, "+ user.name+" !");

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

app.post("/chair/dashboard/update-track/:trackId", async (req, res) => {
  try {
    const { trackId } = req.params;
    const {
      track_title,
      reviewers,
      session_date,
      start_time,
      end_time,
      panelists
    } = req.body;

    // convert comma-separated values to arrays
    const reviewersArray = reviewers.split(",").map(r => r.trim());
    const panelistsArray = panelists.split(",").map(p => p.trim());

    await pool.query(
      `UPDATE conference_tracks
       SET track_name = $1,
           track_reviewers = $2,
           presentation_date = $3,
           presentation_start_time = $4,
           presentation_end_time = $5,
           panelists = $6
       WHERE track_id = $7`,
      [
        track_title,
        reviewersArray,
        session_date,
        start_time,
        end_time,
        panelistsArray,
        trackId
      ]
    );

    res.redirect("/chair/dashboard?message=Track updated successfully!");
  } catch (err) {
    console.error(err);
    res.redirect("/chair/dashboard?message=Failed to update Track!");
  }
});




app.get("/chair/dashboard/invited-talks/:id", checkChairAuth,async (req, res) => {
  

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    const conf = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const conferenceRaw = conf.rows[0];
    const conference = {
      ...conferenceRaw,
      conference_start_date: formatDate(conferenceRaw.conference_start_date),
      conference_end_date: formatDate(conferenceRaw.conference_end_date),
      full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDate(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(conferenceRaw.camera_ready_paper_submission)
    };

    const inviteesResult = await pool.query(
      `SELECT * FROM invitees WHERE conference_id = $1;`,
      [req.params.id]
    );
    const invitees = inviteesResult.rows;

    const inviteesWithStatus = invitees.map(inv => ({
      ...inv,
      display_name: inv.name?.trim() || inv.email,
      display_email: inv.email,
      hasLoggedIn: Boolean(inv.name && inv.name.trim() !== "")
    }));

    const inviteesWithSubmissions = await Promise.all(
      inviteesWithStatus.map(async inv => {
        const subs = await pool.query(
          `SELECT * FROM invited_talk_submissions
           WHERE conference_id = $1 AND invitee_email = $2;`,
          [req.params.id, inv.email]
        );

        return { ...inv, submissions: subs.rows };
      })
    );

    const tracksResult = await pool.query(
      `SELECT track_id, track_name FROM conference_tracks WHERE conference_id = $1;`,
      [req.params.id]
    );
    const trackMap = Object.fromEntries(tracksResult.rows.map(t => [t.track_id, t.track_name]));

    const inviteesEnriched = inviteesWithSubmissions.map(inv => ({
      ...inv,
      submissions: inv.submissions.map(s => ({
        ...s,
        track_name: trackMap[s.track_id] || "N/A"
      }))
    }));

    res.render("chair/invited-talks", {
      user: req.user,
      conference,
      invitees: inviteesEnriched,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("invited-talks error:", err);
    res.status(500).send("Error fetching data.");
  }
});


app.get("/privacy-policy",async(req,res)=>{
  res.render("privacy-policy");
})

async function fetchInviteeNamebyEmail(email){

  const result = await pool.query("select name from users where email = $1",[email]);
  return result.rows[0];

}

app.post("/add-invitee", checkChairAuth,async (req, res) => {
  

  const { email, conference_id,name } = req.body;
  if (!email || !conference_id) {
    return res.status(400).send("Email and conference ID are required.");
  }

  try {
    // 1. Insert invitee row
    await pool.query(
      `INSERT INTO invitees (conference_id, name, email)
       VALUES ($1, $2, $3);`,
      [conference_id, name, email]
    );

     await pool.query(
      `INSERT INTO users (name, email,password)
       VALUES ($1, $2, $3);`,
      [name, email,"Invited User"]
    );

 

  

  } catch (err) {
    console.error("Error adding invitee:", err);
    return res.redirect(`/chair/dashboard/invited-talks/${conference_id}?message=Error adding invitee.`);
  }

  try {
    // 2. Generate setup token (valid 24 hours)
   
    // 3. Fetch conference title for email
    const confResult = await pool.query(
      `SELECT title FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [conference_id]
    );
    const conferenceTitle = confResult.rows[0]?.title || "the conference";
    const result = await fetchInviteeNamebyEmail(email);
    const invitee_name = result.name || "Invitee";

    const htmlBody = `
      <p>Dear ${invitee_name}</p>
      <p>Hope you are doing well!</p>
      <p>You have been invited to present at <strong>${conferenceTitle}</strong>.</p>
      <p>You may sign in (using Google) using this email: <strong>${email}</strong>.</p>
      <p>For support, contact <strong>multimedia@dei.ac.in</strong> or <strong>+91 9875691340</strong>.</p>
      <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>
    `;

    try {
      await sendMail(
        email,
        `Invited to Present at ${conferenceTitle}`,
        `You have been invited to present at ${conferenceTitle}`,
        htmlBody
      );
    } catch (emailErr) {
      console.error("Error sending invite email:", emailErr);
      // Email failure should not block invite creation
    }

  } catch (err) {
    console.error("Error preparing invitee setup:", err);
  }

  res.redirect(`/chair/dashboard/invited-talks/${conference_id}?message=Invitee added successfully.`);
});


app.get("/invited-user/password-update/:email",async(req,res)=>{

  const email = req.params.email;

  const result = await pool.query('select * from users where email=$1 and password=$2',[email,"Invited User"]);
  
     if (result.rows.length === 0) {
      return res.redirect("/?message=Not Eligible!");
    }

    else{ 

       res.render("invited-user-password-update.ejs", {
      user: email
    });

    }

   


})

app.post("/update-invited-user-password",async(req,res)=>{

  const { email, password } = req.body;

  const hashed_password = await bcrypt.hash(password, 10);

  const result = await pool.query("update users set password = $1 where email = $2",[hashed_password,email]);

  if(result){
    return res.redirect("/login/user?message=Password for your account has been updated. Please login with the login credentials.");
  }

})


app.post("/mark-as-reviewed", checkAuth, async (req, res) => {
  

  const {
    submission_id,
    conference_id,
    status,
    originality_score,
    relevance_score,
    technical_quality_score,
    clarity_score,
    impact_score,
    remarks,
  } = req.body;

  try {
    //
    // 1. Check if reviewer already reviewed this submission
    //
    const existingReviewResult = await pool.query(
      `SELECT 1 FROM peer_review 
       WHERE submission_id = $1 AND reviewer = $2 LIMIT 1;`,
      [submission_id, req.user.email]
    );

    if (existingReviewResult.rows.length > 0) {
      return res.redirect("/reviewer/dashboard?message=You have already reviewed this submission.");
    }

    //
    // 2. Fetch submission (needed for notification & co-authors)
    //
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [submission_id]
    );
    const submissionData = submissionResult.rows[0];

    if (!submissionData) {
      return res.redirect("/reviewer/dashboard?message=Error fetching submission details.");
    }

    //
    // 3. Insert review into peer_review
    //
    const mean_score =
      (parseFloat(originality_score) +
        parseFloat(relevance_score) +
        parseFloat(technical_quality_score) +
        parseFloat(clarity_score) +
        parseFloat(impact_score)) / 5;

    await pool.query(
      `INSERT INTO peer_review (
        conference_id, submission_id, review_status, remarks,
        originality_score, relevance_score, technical_quality_score,
        clarity_score, impact_score, mean_score, reviewer, acceptance_status
      )
      VALUES ($1,$2,'Reviewed',$3,$4,$5,$6,$7,$8,$9,$10,$11);`,
      [
        conference_id,
        submission_id,
        remarks,
        originality_score,
        relevance_score,
        technical_quality_score,
        clarity_score,
        impact_score,
        mean_score,
        req.user.email,
        status,
      ]
    );

    //
    // 4. Update submission status
    //
    await pool.query(
      `UPDATE submissions 
       SET submission_status = 'Reviewed'
       WHERE submission_id = $1;`,
      [submission_id]
    );

    //
    // 5. If revision required → insert record for revision
    //
    if (status === "Revision Required") {
      await pool.query(
        `INSERT INTO revised_submissions (submission_id) 
         VALUES ($1) ON CONFLICT DO NOTHING;`,
        [submission_id]
      );
    }

    //
    // 6. Notify authors by email
    //
    try {
      const confResult = await pool.query(
        `SELECT acceptance_notification, title 
         FROM conferences WHERE conference_id = $1 LIMIT 1;`,
        [conference_id]
      );
      const conference = confResult.rows[0];

      const acceptanceDate = conference?.acceptance_notification
        ? new Date(conference.acceptance_notification).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "the scheduled acceptance notification date";

      const coAuthors = Array.isArray(submissionData.co_authors)
        ? submissionData.co_authors
        : [];
      const ccEmails = coAuthors.length > 0 ? coAuthors.join(",") : null;

      await sendMail(
        submissionData.primary_author,
        `Review Completed - ${submissionData.title}`,
        `Your paper "${submissionData.title}" has been reviewed. Results will be published on ${acceptanceDate}.`,
        `<p>Dear Author,</p>
         <p>Your paper titled <strong>"${submissionData.title}"</strong> has now been reviewed.</p>
         <p>Final results will be announced on <strong>${acceptanceDate}</strong>.</p>
         <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`,
        ccEmails
      );
    } catch (emailErr) {
      console.error("Email send failed (ignored):", emailErr);
    }

    //
    // 7. Re-render dashboard so reviewer sees updated list
    //
    return res.redirect("/dashboard?message=Submission has been successfully marked as reviewed.");

  } catch (err) {
    console.error("Mark-as-reviewed error:", err);
    return res.redirect("/reviewer/dashboard?message=We are facing some issues in marking this submission as reviewed.");
  }
});

app.post("/create-track/:id", checkChairAuth,async(req,res)=>{

  const {track_title, reviewers,session_date, session_start_time,session_end_time, session_chairs} = req.body;
  const result = await pool.query("insert into conference_tracks (track_name,track_reviewers,presentation_date,presentation_start_time,presentation_end_time, panelists,conference_id) values ($1,array[$2],$3,$4,$5,array[$6],$7)",[track_title,reviewers,session_date,session_start_time,session_end_time,session_chairs,req.params.id])

  return res.redirect("/chair/dashboard?message=Track Added Succesfully!")

})

app.get("/chair/dashboard/delete-track/:id", checkChairAuth,async(req,res)=>{
  const result = await pool.query("delete from conference_tracks where track_id = $1",[req.params.id]);
  if(!result){
    return res.redirect("/chair/dashboard?message=Error deleting Track!");
  }
  else{
        return res.redirect("/chair/dashboard?message=Track Deleted Succesfully!");

  }
})

app.post("/mark-presentation-as-complete", checkAuth, async (req, res) => {
  const { paper_id, panelist_score, track_id } = req.body;

  if (!paper_id || !track_id) {
    return res.render("error.ejs", {
      message: "Missing required fields: paper_id or track_id",
    });
  }

  const scoreValue = panelist_score ? Number(panelist_score) : null;
  if (panelist_score && isNaN(scoreValue)) {
    return res.render("error.ejs", {
      message: "Invalid panelist score provided",
    });
  }

  if (!paper_id || typeof paper_id !== "string" || paper_id.trim() === "") {
    return res.render("error.ejs", {
      message: "Invalid paper ID provided",
    });
  }

  try {
    // Fetch submission to get conference_id
    const submissionResult = await pool.query(
      `SELECT conference_id FROM submissions WHERE submission_id = $1`,
      [paper_id]
    );

    if (submissionResult.rows.length === 0) {
      return res.render("error.ejs", {
        message: "Submission not found.",
      });
    }

    const conference_id = submissionResult.rows[0].conference_id;

    // Update submissions table
    await pool.query(
      `UPDATE submissions
       SET submission_status = 'Presentation Completed'
       WHERE submission_id = $1`,
      [paper_id]
    );

    // Update final_camera_ready_submissions table
    await pool.query(
      `UPDATE final_camera_ready_submissions
       SET panelist_score = $1,
           status = 'Completed'
       WHERE submission_id = $2`,
      [scoreValue, paper_id]
    );

    return res.redirect(
      `/panelist/active-session/${conference_id}?message=Submission has been successfully marked as completed.`
    );
  } catch (err) {
    console.error("Error updating submission:", err);
    return res.render("error.ejs", {
      message:
        "We are facing some issues in marking this submission as completed.",
    });
  }
});

app.get("/chair/dashboard/manage-tracks/:id",checkChairAuth, async(req,res)=>{

  const conference = await fetchConference(req.params.id);
  const tracks = await pool.query("select * from conference_tracks where conference_id = $1",[req.params.id]);
  

  return res.render("chair/manage-tracks",{tracks:tracks.rows,conference:conference.rows[0]});


})


app.get("/chair/dashboard/delete-conference/:id", checkChairAuth,async (req, res) => {
  

  try {
    await pool.query(`DELETE FROM conference_tracks WHERE conference_id = $1;`, [req.params.id]);
    await pool.query(`DELETE FROM conferences WHERE conference_id = $1;`, [req.params.id]);

    res.redirect("/chair/dashboard?message=Conference Deleted Succesfully.");
  } catch (err) {
    console.error("Error deleting conference:", err);
    res.status(500).send("Error deleting conference.");
  }
});



app.get("/submission/co-author/:id", checkAuth, async (req, res) => {
  

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    // Fetch conference
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );

    const conferenceRaw = conferenceResult.rows[0];

    if (!conferenceRaw) {
      return res.status(404).send("Conference not found.");
    }

    const conference = {
      ...conferenceRaw,
      conference_start_date: formatDate(conferenceRaw.conference_start_date),
      conference_end_date: formatDate(conferenceRaw.conference_end_date),
      full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDate(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(conferenceRaw.camera_ready_paper_submission)
    };

    res.render("submission2.ejs", {
      user: req.user,
      conferences: conference,
      submission: null,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Error fetching conference:", err);
    return res.status(500).send("Error fetching conference.");
  }
});


app.post("/join", checkAuth, async (req, res) => {
 

  const { paper_code, id } = req.body;

  try {
    // 1. Get submission by paper_code + conference_id
    const submissionResult = await pool.query(
      `SELECT * FROM submissions 
       WHERE paper_code = $1 AND conference_id = $2 
       LIMIT 1;`,
      [paper_code, id]
    );

    const submission = submissionResult.rows[0];

    if (!submission) {
      return res.redirect("/dashboard?message=Invalid Paper Code. Please try again.");
    }

    // 2. Check status requirement for joining
    if (submission.submission_status !== "Submitted for Review") {
      return res.redirect(
        `/dashboard?message=Cannot join this paper as co-author. Current status: ${submission.submission_status}. Co-authors can only join papers with 'Submitted for Review' status.`
      );
    }

    // 3. Prevent primary author from joining as co-author
    if (submission.primary_author === req.user.email) {
      return res.redirect("/dashboard?message=You are the primary author of this paper. You cannot join as a co-author.");
    }

    const coAuthors = submission.co_authors || [];

    // 4. Prevent duplicate co-author entries
    if (coAuthors.includes(req.user.email)) {
      return res.redirect("/dashboard?message=You are already a co-author of this paper.");
    }

    // 5. Check if join request already exists
    const existingReqResult = await pool.query(
      `SELECT * FROM co_author_requests
       WHERE submission_id = $1 AND co_author = $2
       LIMIT 1;`,
      [submission.submission_id, req.user.email]
    );

    if (existingReqResult.rows.length > 0) {
      return res.redirect("/dashboard?message=You have already sent a request to join this paper.");
    }

    // 6. Insert new co-author request (track primary author and set clear pending status)
    await pool.query(
      `INSERT INTO co_author_requests (conference_id, submission_id, primary_author, co_author, status)
       VALUES ($1, $2, $3, $4, $5);`,
      [id, submission.submission_id, submission.primary_author, req.user.email, "Pending"]
    );

    // 7. Send notification email to primary author
    try {
      await sendMail(
        submission.primary_author,
        `Co-Author Request - ${submission.title}`,
        `A co-author request for your paper "${submission.title}" has been submitted.`,
        `<p>Dear Author,</p>
         <p>A co-author has requested to join your paper titled <strong>"${submission.title}"</strong>.</p>
         <p><strong>Co-Author Email:</strong> ${req.user.email}</p>
         <p>Please review and accept or reject this request from your dashboard.</p>
         <p>For assistance, contact <strong>multimedia@dei.ac.in</strong> or <strong>+91 9875691340</strong>.</p>
         <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
      );
    } catch (emailErr) {
      console.error("Email send error:", emailErr);
      // We intentionally do NOT stop request due to mail failure
    }

    return res.redirect("/dashboard?message=Co-author request submitted successfully.");

  } catch (err) {
    console.error("Join error:", err);
    return res.redirect("/dashboard?message=Something went wrong while submitting your request.");
  }
});


app.post("/co-author-request/accept/:request_id", checkAuth, async (req, res) => {
 

  const requestId = req.params.request_id;

  try {
    // 1. Fetch co-author request
    const coAuthorReqResult = await pool.query(
      `SELECT * FROM co_author_requests WHERE request_id = $1 LIMIT 1;`,
      [requestId]
    );
    const coAuthorRequest = coAuthorReqResult.rows[0];

    if (!coAuthorRequest) {
      return res.redirect("/dashboard?message=Co-author request not found.");
    }

    // 2. Fetch submission
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [coAuthorRequest.submission_id]
    );
    const submission = submissionResult.rows[0];

    if (!submission) {
      return res.redirect("/dashboard?message=Submission not found.");
    }

    // 3. Verify current user is primary author
    if (submission.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=You are not authorized to accept this request.");
    }

    // 4. Ensure co_authors is an array and update
    let coAuthors = submission.co_authors || [];
    if (!Array.isArray(coAuthors)) coAuthors = [];

    if (!coAuthors.includes(coAuthorRequest.co_author)) {
      coAuthors.push(coAuthorRequest.co_author);
    }

    // 5. Update submissions table
    await pool.query(
      `UPDATE submissions SET co_authors = $1 WHERE submission_id = $2;`,
      [coAuthors, coAuthorRequest.submission_id]
    );

    // 6. Mark request as accepted
    await pool.query(
      `UPDATE co_author_requests SET status = 'Accepted' WHERE request_id = $1;`,
      [requestId]
    );

    // 7. Send email to co-author
    try {
      await sendMail(
        coAuthorRequest.co_author,
        `Co-Author Request Accepted - ${submission.title}`,
        `Your co-author request for "${submission.title}" has been accepted.`,
        `<p>Dear Co-Author,</p>
         <p>Your request to join the paper titled <strong>"${submission.title}"</strong> has been <strong>accepted</strong>.</p>
         <p>You are now listed as a co-author. View in your dashboard.</p>
         <p>Regards,<br>DEI Conference Management Toolkit Team</p>`
      );
    } catch (emailErr) {
      console.error("Email sending error:", emailErr);
    }

    return res.redirect("/dashboard?message=Co-author request accepted successfully.");

  } catch (err) {
    console.error("Error accepting co-author request:", err);
    return res.redirect("/dashboard?message=Something went wrong.");
  }
});
app.post("/co-author-request/reject/:request_id", checkAuth, async (req, res) => {
 

  const requestId = req.params.request_id;

  try {
    // 1. Fetch co-author request
    const coAuthorReqResult = await pool.query(
      `SELECT * FROM co_author_requests WHERE request_id = $1 LIMIT 1;`,
      [requestId]
    );
    const coAuthorRequest = coAuthorReqResult.rows[0];

    if (!coAuthorRequest) {
      return res.redirect("/dashboard?message=Co-author request not found.");
    }

    // 2. Fetch submission
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [coAuthorRequest.submission_id]
    );
    const submission = submissionResult.rows[0];

    if (!submission) {
      return res.redirect("/dashboard?message=Submission not found.");
    }

    // 3. Verify ownership
    if (submission.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=You are not authorized to reject this request.");
    }

    // 4. Update request status to Rejected
    await pool.query(
      `UPDATE co_author_requests SET status = 'Rejected' WHERE request_id = $1;`,
      [requestId]
    );

    // 5. Notify via email
    try {
      await sendMail(
        coAuthorRequest.co_author,
        `Co-Author Request Rejected - ${submission.title}`,
        `Your co-author request for "${submission.title}" has been rejected.`,
        `<p>Dear Co-Author,</p>
         <p>Your request to join the paper <strong>"${submission.title}"</strong> was <strong>rejected</strong>.</p>
         <p>Please contact the primary author if needed.</p>
         <p>Regards,<br>DEI Conference Management Toolkit Team</p>`
      );
    } catch (emailErr) {
      console.error("Email sending error:", emailErr);
    }

    return res.redirect("/dashboard?message=Co-author request rejected successfully.");

  } catch (err) {
    console.error("Error rejecting co-author request:", err);
    return res.redirect("/dashboard?message=Something went wrong.");
  }
});


app.post("/create-new-conference", checkChairAuth,async (req, res) => {
  const {
    title,
    description,
    conference_start_date,
    conference_end_date,
    full_paper_submission,
    acceptance_notification,
    camera_ready_paper_submission,
    deadline_peer_review,
    co_chairs
  } = req.body;

  try {
    // 1. Insert conference and return row
    const confResult = await pool.query(
      `INSERT INTO conferences
      (title, description, conference_start_date, conference_end_date, full_paper_submission, acceptance_notification, camera_ready_paper_submission,deadline_peer_review,co_chairs,created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7,$8,array[$9],$10)
      RETURNING conference_id;`,
      [
        title,
        description,
        conference_start_date,
        conference_end_date,
        full_paper_submission,
        acceptance_notification,
        camera_ready_paper_submission,
        deadline_peer_review,
        co_chairs,
        req.user.email
      ]
    );

    const conference_id = confResult.rows[0].conference_id;

    // 2. Insert poster session placeholder row
    await pool.query(
      `INSERT INTO poster_session (conference_id, date, start_time, end_time, coodinators)
       VALUES ($1, null, null, null, ARRAY[]::text[]);`,
      [conference_id]
    );



    res.redirect("/chair/dashboard?message=Congratulations!!! Conference Created Successfully. Now you can proceed with configuring the tracks for the conference, once this is done you will be able to schedule the oral and poster presentation sessions.");

  } catch (err) {
    console.error("Create conference error:", err);
    return res.redirect("/chair/dashboard?message=Error creating conference.");
  }
});


app.get("/chair/create-new-conference", checkChairAuth,(req, res) => {
  
  res.render("chair/create-new-conference.ejs" , {
    user: req.user,
    message: req.query.message || null,
  });
});

app.get("/submission/primary-author/:id", checkAuth, async (req, res) => {
  
  const isReviewerResult = await isReviewer(req.user.email);
    const isSessionChairResult = await isSessionChair(req.user.email);
    const isInviteeResult = await isInvitee(req.user.email);

    if(isInviteeResult === true || isReviewerResult===true || isSessionChairResult===true){
      return res.redirect("/dashboard?message=Unauthorized Access!!! Please note, Reviewers / Session Chairs / Invited Speakers are not allowed to join papers as co-authors. If you think this is an error, please reach out to us at multimedia@dei.ac.in.")
    }
    

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    // 1. Fetch conference by conference_id
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );

    const conferenceRaw = conferenceResult.rows[0];

    if (!conferenceRaw) {
      return res.status(404).send("Conference not found.");
    }

    const conference = {
      ...conferenceRaw,
      conference_start_date: formatDate(conferenceRaw.conference_start_date),
      conference_end_date: formatDate(conferenceRaw.conference_end_date),
      full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDate(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(conferenceRaw.camera_ready_paper_submission)
    };

    // 2. Fetch tracks for this conference
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1;`,
      [req.params.id]
    );

    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDate(track.presentation_date)
    }));

    


    res.render("submission.ejs", {
      user: req.user,
      conferences: conference,
      tracks: tracks || [],
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Database error:", err);
    return res.status(500).send("Error fetching data from database.");
  }
});

app.get("/submission/invited-talk/:id", checkAuth, async (req, res) => {


 

  try {
    const conferenceId = req.params.id;

    const data = await pool.query("select * from invitees where conference_id=$1 and email=$2",[conferenceId,req.user.email]);
    const result = data.rows[0];

    if(!result){
      return res.redirect("/dashboard?message=We could not find your Email ID in the list of Invited Speakers. If you think this is an error, please reach out to the conference chairs.")
    }


    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    //
    // Fetch conference
    //
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1`,
      [conferenceId]
    );
    const conferenceRaw = conferenceResult.rows[0];

    if (!conferenceRaw) {
      return res.status(404).send("Conference not found.");
    }

    const conference = {
      ...conferenceRaw,
      conference_start_date: formatDate(conferenceRaw.conference_start_date),
      conference_end_date: formatDate(conferenceRaw.conference_end_date),
      full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDate(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(conferenceRaw.camera_ready_paper_submission)
    };

    //
    // Fetch tracks for this conference
    //
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1`,
      [conferenceId]
    );
    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDate(track.presentation_date)
    }));

    //
    // Render submission form
    //
    res.render("invitee/submission.ejs", {
      user: req.user,
      conferences: conference,
      tracks: tracks || [],
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Error loading invited talk submission page:", err);
    return res.status(500).send("Server error loading submission page.");
  }
});


app.get("/submission/edit/primary-author/:id", checkAuth, async (req, res) => {


  try {
    // 1. Fetch the submission
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [req.params.id]
    );

    const submission = submissionResult.rows[0];

    if (!submission) {
      return res.redirect("/dashboard?message=Submission not found.");
    }

    // 2. Permission check
    if (submission.primary_author !== req.user.email) {
      const coAuthors = submission.co_authors || []; // co_authors must be TEXT[] in DB
      if (!coAuthors.includes(req.user.email)) {
        return res.redirect("/dashboard?message=You can only edit your own submissions.");
      }
    }

    // 3. Allow edit only if status is Submitted for Review
    if (submission.submission_status !== "Submitted for Review") {
      return res.redirect(
        `/dashboard?message=Papers can only be edited when status is Submitted for Review. Current status: ${submission.submission_status}`
      );
    }

    // 4. Fetch tracks for the same conference
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks 
       WHERE conference_id = $1 
       ORDER BY track_name ASC;`,
      [submission.conference_id]
    );

    const tracks = tracksResult.rows;

    // Debug Logging (safe)
    console.log("Submission data:", {
      submission_id: submission.submission_id,
      track_id: submission.track_id,
      track_id_type: typeof submission.track_id
    });

    console.log("Tracks data:", tracks.map(t => ({
      track_id: t.track_id,
      track_name: t.track_name,
      track_id_type: typeof t.track_id
    })));

    // 5. Render page
    res.render("submission3.ejs", { 
      user: req.user, 
      submission,
      tracks,
      message: req.query.message || null,
    });

  } catch (error) {
    console.error("Error in edit submission route:", error);
    return res.redirect("/dashboard?message=An unexpected error occurred.");
  }
});


app.get("/submission/revised/primary-author/:id", checkAuth, async (req, res) => {
 

  try {
    const submissionId = req.params.id;

    //
    // 1. Fetch submission
    //
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1`,
      [submissionId]
    );

    const submission = submissionResult.rows[0];

    if (!submission) {
      return res.redirect("/dashboard?message=Submission not found.");
    }

    //
    // 2. Security check
    //
    if (submission.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=Only the primary author can submit revised papers.");
    }

    //
    // 3. Ensure status is correct
    //
    if (submission.submission_status !== "Revision Required") {
      return res.redirect(
        `/dashboard?message=Revised papers can only be submitted for papers with 'Revision Required' status. Current status: ${submission.submission_status}`
      );
    }

    //
    // 4. Fetch tracks for this conference
    //
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1 ORDER BY track_name`,
      [submission.conference_id]
    );
    const tracks = tracksResult.rows;

    //
    // 5. Fetch reviewer remarks and scores
    //
    const reviewerResult = await pool.query(
      `SELECT * FROM peer_review WHERE submission_id = $1`,
      [submissionId]
    );
    const reviewerData = reviewerResult.rows;

    //
    // 6. Render page
    //
    res.render("submission5.ejs", {
      user: req.user,
      submission,
      tracks,
      reviewerData,
      message: req.query.message || null,
    });

  } catch (error) {
    console.error("Error in revised submission route:", error);
    res.redirect("/dashboard?message=An unexpected error occurred.");
  }
});


app.get("/submission/final-camera-ready/primary-author/:id", checkAuth, async (req, res) => {
 

  try {
    // 1. Fetch submission
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const submission = submissionResult.rows[0];

    if (!submission) {
      return res.redirect("/dashboard?message=Submission not found.");
    }

    // 2. Get track name (optional)
    let trackName = "Unknown Track";

    if (submission.track_id) {
      const trackResult = await pool.query(
        `SELECT track_name FROM conference_tracks WHERE track_id = $1 LIMIT 1;`,
        [submission.track_id]
      );

      if (trackResult.rows.length > 0) {
        trackName = trackResult.rows[0].track_name;
      }
    }

    // 3. Fetch reviewer remarks
    const reviewerResult = await pool.query(
      `SELECT * FROM peer_review WHERE submission_id = $1;`,
      [req.params.id]
    );
    const reviewerRemarks = reviewerResult.rows;

    // 4. Fetch revised submission if exists
    let revisedSubmissionData = null;
    const revisedResult = await pool.query(
      `SELECT * FROM revised_submissions WHERE submission_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    if (revisedResult.rows.length > 0) {
      revisedSubmissionData = revisedResult.rows[0];
      console.log("Revised submission found:", revisedSubmissionData);
    } else {
      console.log("No revised submission found for:", req.params.id);
    }

    // 5. Fetch camera-ready deadline
    const confResult = await pool.query(
      `SELECT camera_ready_paper_submission FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [submission.conference_id]
    );
    const conferenceInfo = confResult.rows[0];

    // 6. Deadline check (IST date conversion)
    if (conferenceInfo && conferenceInfo.camera_ready_paper_submission) {
      const currentDate = getCurrentDateIST();
      const deadline = formatDateISO(conferenceInfo.camera_ready_paper_submission);

      // Check if current date is AFTER the deadline (not on the deadline day)
      if (currentDate > deadline) {
        return res.redirect("/dashboard?message=The camera-ready submission deadline has passed.");
      }
    }

    // 7. Status-based access restrictions
    if (submission.submission_status === "Submitted for Review") {
      return res.redirect("/dashboard?message=Your submission is under review.");
    }
    if (submission.submission_status === "Rejected") {
      return res.redirect("/dashboard?message=Your submission has been rejected.");
    }
    if (submission.submission_status === "Submitted Final Camera Ready Paper") {
      return res.redirect("/dashboard?message=You have already submitted the final camera ready paper.");
    }

    // 8. Render page
    res.render("submission4.ejs", {
      user: req.user,
      submission: { ...submission, track_name: trackName },
      reviewerRemarks: reviewerRemarks || [],
      revisedSubmissionData: revisedSubmissionData || null,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Error in final camera ready route:", err);
    return res.redirect("/dashboard?message=An unexpected error occurred.");
  }
});


app.post("/final-camera-ready-submission", checkAuth, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
          ? "File size exceeds 4MB limit. Please upload a smaller file."
          : err.message;
        return res.redirect(`/dashboard?message=Error: ${message}`);
      }


      if (!req.file) {
        return res.redirect("/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.");
      }

      const { confid, title, abstract, areas, id, co_authors } = req.body;

      // 1. Verify camera-ready deadline
      try {
        const confResult = await pool.query(
          `SELECT camera_ready_paper_submission 
           FROM conferences 
           WHERE conference_id = $1 LIMIT 1;`,
          [confid]
        );

        const confRow = confResult.rows[0];

        if (confRow && confRow.camera_ready_paper_submission) {
          const currentDate = getCurrentDateIST();
          const deadline = formatDateISO(confRow.camera_ready_paper_submission);

          // Check if current date is AFTER the deadline (not on the deadline day)
          if (currentDate > deadline) {
            return res.redirect("/dashboard?message=The camera-ready submission deadline has passed.");
          }
        }
      } catch (deadlineErr) {
        console.error("Deadline check error:", deadlineErr);
      }

      // 2. Upload to Cloudinary
      const filePath = req.file.path;
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        resource_type: "auto",
        folder: "submissions",
        public_id: `${req.user.uid}-${Date.now()}-Final`,
      });

      try { await fs.unlink(filePath); } catch {}

      // 3. Insert into final_camera_ready_submissions
      await pool.query(
        `INSERT INTO final_camera_ready_submissions
         (conference_id, submission_id, primary_author, title, abstract, track_id, co_authors, file_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8);`,
        [
          confid,
          id,
          req.user.email,
          title,
          abstract,
          areas,
          co_authors,
          uploadResult.secure_url
        ]
      );

      // 4. Get current submission status
      const submissionStatusResult = await pool.query(
        `SELECT submission_status FROM submissions WHERE submission_id = $1 LIMIT 1;`,
        [id]
      );
      const submissionData = submissionStatusResult.rows[0];

      let newStatus = "Submitted Final Camera Ready Paper";
      if (submissionData) {
        if (submissionData.submission_status === "Accepted for Poster Presentation") {
          newStatus = "Submitted Final Camera Ready Paper for Poster Presentation";
        } else if (submissionData.submission_status === "Accepted for Oral Presentation") {
          newStatus = "Submitted Final Camera Ready Paper for Oral Presentation";
        }
      }

      // 5. Update submission record
      await pool.query(
        `UPDATE submissions 
         SET submission_status = $1, file_url = $2
         WHERE submission_id = $3;`,
        [newStatus, uploadResult.secure_url, id]
      );

      return res.redirect("/dashboard");

    } catch (error) {
      console.error("Final camera-ready submission error:", error);
      return res.redirect("/dashboard?message=Something went wrong while submitting the final camera-ready paper.");
    }
  });
});


app.get("/login" , async (req,res)=>{
  res.render("login.ejs", {
    message: req.query.message || null
  });
});

app.get("/chair/dashboard", checkChairAuth, async (req, res) => {
  

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    const result = await pool.query("SELECT * FROM conferences where created_by = $1",[req.user.email]);
    const conferences = result.rows.map(conference => ({
      ...conference,
      conference_start_date: formatDate(conference.conference_start_date),
      conference_end_date: formatDate(conference.conference_end_date),
      full_paper_submission: formatDate(conference.full_paper_submission),
      acceptance_notification: formatDate(conference.acceptance_notification),
      camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission),
      deadline_peer_review:formatDate(conference.camera_ready_paper_submission)
    }));

    res.render("chair/dashboard.ejs", {
      user: req.user,
      conferences,
      message: req.query.message || null,
    });
  } catch (err) {
    console.error("Database error:", err);
    return res.redirect("/?message=We are facing some issues in connecting to the database. Please try again later. Apologies for the inconvinience.");
  }
});


app.get("/chair/dashboard/edit-conference/:id", checkChairAuth,async (req, res) => {
  

  try {
    // Helper function to format dates for HTML date inputs (yyyy-mm-dd)
    const formatDateForInput = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Fetch conference
    const confResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const conferenceRaw = confResult.rows[0];

    if (!conferenceRaw) return res.status(404).send("Conference not found.");

    const conference = {
      ...conferenceRaw,
      conference_start_date: formatDateForInput(conferenceRaw.conference_start_date),
      conference_end_date: formatDateForInput(conferenceRaw.conference_end_date),
      full_paper_submission: formatDateForInput(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDateForInput(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDateForInput(conferenceRaw.camera_ready_paper_submission)
    };

    // Fetch tracks
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1;`,
      [req.params.id]
    );
    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDateForInput(track.presentation_date)
    }));

    res.render("chair/edit-conference.ejs", {
      user: req.user,
      conference,
      tracks,
      message: req.query.message || null,
    });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).send("Error fetching conference data.");
  }
});


app.post("/chair/dashboard/update-conference/:id", async (req, res) => {
  const conferenceId = req.params.id;

  const {
    title,
    description,
    conference_start_date,
    conference_end_date,
    full_paper_submission,
    acceptance_notification,
    camera_ready_paper_submission,
  } = req.body;

  try {
    //
    // 1. Update conference details
    //
    await pool.query(
      `UPDATE conferences
       SET title = $1,
           description = $2,
           conference_start_date = $3,
           conference_end_date = $4,
           full_paper_submission = $5,
           acceptance_notification = $6,
           camera_ready_paper_submission = $7
       WHERE conference_id = $8;`,
      [
        title,
        description,
        conference_start_date,
        conference_end_date,
        full_paper_submission,
        acceptance_notification,
        camera_ready_paper_submission,
        conferenceId
      ]
    );


    return res.redirect("/chair/dashboard?message=Conference Updated Successfully!");

  } catch (err) {
    console.error("Update conference error:", err);
    return res.status(500).send("Error updating conference.");
  }
});


app.get("/chair/dashboard/view-submissions/:id", checkChairAuth,async (req, res) => {
  

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getUTCDate()).padStart(2, '0');
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const year = date.getUTCFullYear();
      return `${day}-${month}-${year}`;
    };

    // Fetch submissions
    const submissionsResult = await pool.query(
      `SELECT * FROM submissions WHERE conference_id = $1;`,
      [req.params.id]
    );
    const submissions = submissionsResult.rows;

    // Fetch tracks
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1;`,
      [req.params.id]
    );
    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDate(track.presentation_date)
    }));

    // Fetch conference data
    const confResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const confdataRaw = confResult.rows[0];
    const confdata = {
      ...confdataRaw,
      conference_start_date: formatDate(confdataRaw.conference_start_date),
      conference_end_date: formatDate(confdataRaw.conference_end_date),
      full_paper_submission: formatDate(confdataRaw.full_paper_submission),
      acceptance_notification: formatDate(confdataRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(confdataRaw.camera_ready_paper_submission)
    };

    // Track map for lookup
    const trackMap = {};
    tracks.forEach(t => (trackMap[t.track_id] = t.track_name));

    // Build set of all author emails
    const allEmails = new Set();
    submissions.forEach(sub => {
      allEmails.add(sub.primary_author);
      if (Array.isArray(sub.co_authors)) {
        sub.co_authors.forEach(e => allEmails.add(e));
      }
    });

    let emailArray = Array.from(allEmails);
    let emailToNameMap = {};

    if (emailArray.length > 0) {
      const usersResult = await pool.query(
        `SELECT email, name FROM users WHERE email = ANY($1);`,
        [emailArray]
      );
      usersResult.rows.forEach(u => (emailToNameMap[u.email] = u.name));
    }

    const formatNameEmail = email =>
      emailToNameMap[email] ? `${emailToNameMap[email]} (${email})` : email;

    // Attach formatted fields
    const submissionsWithTracks = submissions.map(sub => ({
      ...sub,
      track_name: trackMap[sub.track_id] || "Unknown Track",
      primary_author_formatted: formatNameEmail(sub.primary_author),
      co_authors_formatted: Array.isArray(sub.co_authors)
        ? sub.co_authors.map(formatNameEmail).join(", ")
        : (sub.co_authors ? formatNameEmail(sub.co_authors) : "None")
    }));

    // Fetch latest review details (optimized: 1 query per submission)
    for (let s of submissionsWithTracks) {
      const reviewResult = await pool.query(
        `SELECT reviewer, mean_score, remarks 
         FROM peer_review 
         WHERE submission_id = $1;`,
        [s.submission_id]
      );

      if (reviewResult.rows.length > 0) {
        const r = reviewResult.rows[0];
        s.reviewer = r.reviewer;
        s.mean_score = r.mean_score !== null ? parseFloat(r.mean_score).toFixed(2) : null;
        s.remarks = r.remarks;

        if (s.reviewer) {
          const reviewerNameResult = await pool.query(
            `SELECT name FROM users WHERE email = $1 LIMIT 1;`,
            [s.reviewer]
          );
          s.reviewer_name = reviewerNameResult.rows[0]?.name || s.reviewer;
        }
      } else {
        s.reviewer = null;
        s.mean_score = null;
        s.remarks = null;
      }
    }

    const uniqueStatuses = [...new Set(submissions.map(sub => sub.submission_status))];

    res.render("chair/view-submissions.ejs", {
      user: req.user,
      submissions: submissionsWithTracks,
      tracks,
      uniqueStatuses,
      conferencedata: req.params.id,
      confdata,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Error in chair view submissions:", err);
    return res.status(500).send("Error fetching data.");
  }
});


app.get('/chair/dashboard/delete-submission/:id', checkChairAuth, async (req, res) => {
  
  const submissionId = req.params.id;
  const conferenceId = req.query.conference_id;

  console.log('Delete submission request:', { submissionId, conferenceId, query: req.query });

  if (!conferenceId) {
    console.error('Conference ID is missing');
    return res.redirect('/chair/dashboard?message=Error: Conference ID is required.');
  }

  try {
    // 1. Delete co-author requests
    await pool.query(
      `DELETE FROM co_author_requests WHERE submission_id = $1;`,
      [submissionId]
    );

    // 2. Delete revised submissions
    await pool.query(
      `DELETE FROM revised_submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    // 3. Delete related peer reviews
    await pool.query(
      `DELETE FROM peer_review WHERE submission_id = $1;`,
      [submissionId]
    );

    // 4. Delete any final camera-ready submission entry
    await pool.query(
      `DELETE FROM final_camera_ready_submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    // 5. Delete submission itself
    await pool.query(
      `DELETE FROM submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    console.log('Submission deleted successfully:', submissionId);
    return res.redirect(
      `/chair/dashboard/view-submissions/${conferenceId}?message=Submission deleted successfully.`
    );

  } catch (err) {
    console.error('Error deleting submission:', err);
    return res.redirect(
      `/chair/dashboard/view-submissions/${conferenceId}?message=Error deleting submission.`
    );
  }
});


app.post("/submit-revised-paper", checkAuth, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File size exceeds 4MB limit. Please upload a smaller file.'
        : err.message;
      return res.redirect(`/dashboard?message=Error: ${message}`);
    }

    (async () => {
    

      const { submission_id } = req.body;

      if (!req.file) {
        return res.redirect(`/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.`);
      }

      try {
        //
        // 1. Fetch submission
        //
        const submissionResult = await pool.query(
          `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1`,
          [submission_id]
        );
        const submission = submissionResult.rows[0];

        if (!submission) {
          return res.redirect("/dashboard?message=Submission not found.");
        }

        //
        // 2. Security + Status checks
        //
        if (submission.primary_author !== req.user.email) {
          return res.redirect("/dashboard?message=Only the primary author can submit revised papers.");
        }

        if (submission.submission_status !== "Revision Required") {
          return res.redirect("/dashboard?message=This submission is not waiting for revisions.");
        }

        //
        // 3. Upload File
        //
        const filePath = req.file.path;
        const uploadResult = await cloudinary.uploader.upload(filePath, {
          resource_type: "auto",
          folder: "revised_submissions",
          public_id: `${req.user.name}-${submission_id}-${Date.now()}`,
        });

        //
        // 4. Update revised_submissions file_url
        //
        await pool.query(
          `UPDATE revised_submissions SET file_url = $1 WHERE submission_id = $2`,
          [uploadResult.secure_url, submission_id]
        );

        //
        // 5. Update submissions status + file_url
        //
        await pool.query(
          `UPDATE submissions SET submission_status = 'Submitted Revised Paper', file_url = $1 WHERE submission_id = $2`,
          [uploadResult.secure_url, submission_id]
        );

        //
        // 6. Local file cleanup
        //
        try { await fs.unlink(filePath); } 
        catch (cleanupError) { console.error("Cleanup error:", cleanupError); }

        return res.redirect("/dashboard?message=Revised paper submitted successfully for re-review!");

      } catch (error) {
        console.error("Error in submit revised paper:", error);
        return res.redirect("/dashboard?message=Error uploading revised paper.");
      }
    })().catch(next);
  });
});


app.post("/edit-submission", checkAuth, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
          ? "File size exceeds 4MB limit. Please upload a smaller file."
          : err.message;
        return res.redirect(`/dashboard?message=Error: ${message}`);
      }

      let { title, abstract, areas, id } = req.body;
      if (typeof areas !== "string") areas = String(areas).trim();

      const updateFields = [];
      const updateValues = [];
      let index = 1;

      updateFields.push(`title = $${index++}`);
      updateValues.push(title);

      updateFields.push(`abstract = $${index++}`);
      updateValues.push(abstract);

      if (areas && areas !== "undefined" && areas !== "") {
        updateFields.push(`track_id = $${index++}`);
        updateValues.push(areas);
      }

      // If user uploaded a new file
      if (req.file) {
        const filePath = req.file.path;
        const uploadResult = await cloudinary.uploader.upload(filePath, {
          resource_type: "auto",
          folder: "submissions",
          public_id: `${req.user.uid}-${Date.now()}`,
        });

        updateFields.push(`file_url = $${index++}`);
        updateValues.push(uploadResult.secure_url);

        try {
          await fs.unlink(filePath);
        } catch (cleanupErr) {
          console.error("File cleanup error:", cleanupErr);
        }
      }

      // Add WHERE clause argument
      updateValues.push(id);

      const sql = `
        UPDATE submissions 
        SET ${updateFields.join(", ")}
        WHERE submission_id = $${index};
      `;

      await pool.query(sql, updateValues);

      return res.redirect("/dashboard?message=Submission updated successfully!");

    } catch (error) {
      console.error("Error in edit submission:", error);
      return res.redirect("/dashboard?message=Error updating submission.");
    }
  });
});


app.get("/submission/delete/primary-author/:id", checkAuth, async (req, res) => {
  

  try {
    await pool.query(
      `DELETE FROM submissions WHERE submission_id = $1;`,
      [req.params.id]
    );

    return res.redirect("/dashboard?message=Submission deleted Successfully!");
  } catch (err) {
    console.error("Error deleting submission:", err);
    return res.redirect("/dashboard?message=Error deleting submission.");
  }
});



app.get("/submission/delete/invitee/:id", checkAuth, async (req, res) => {


  try {
    await pool.query(
      `DELETE FROM invited_talk_submissions WHERE paper_id = $1`,
      [req.params.id]
    );

    return res.redirect("/dashboard?message=Submission deleted successfully!");
  } catch (err) {
    console.error("Error deleting invited talk submission:", err);
    return res.redirect("/?message=Error deleting submission.");
  }
});

app.post("/submit", checkAuth, async(req, res) => {

  upload.single("file")(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
          ? "File size exceeds 4MB limit. Please upload a smaller file."
          : err.message;
        return res.redirect(`/dashboard?message=Error: ${message}`);
      }


      if (!req.file) {
        return res.redirect("/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.");
      }

      const { title, abstract, areas, id } = req.body;

      // Server-side validation of required fields
      if (!title || !abstract || !areas || !id) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("All fields are required: Title, Abstract, Area and Conference."));
      }

      // Ensure Cloudinary is configured
      if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("Upload service is not configured. Please contact the administrator."));
      }

      // Validate that the selected track belongs to the selected conference
      try {
        const trackCheck = await pool.query(
          `SELECT 1 FROM conference_tracks WHERE track_id = $1 AND conference_id = $2 LIMIT 1;`,
          [areas, id]
        );
        if (trackCheck.rows.length === 0) {
          return res.redirect("/dashboard?message=" + encodeURIComponent("Invalid track selection for the chosen conference."));
        }
      } catch (trackErr) {
        console.error("Track validation error:", trackErr);
        return res.redirect("/dashboard?message=" + encodeURIComponent("Unable to validate track selection right now."));
      }

      const filePath = req.file.path;

      // Upload to Cloudinary
      let uploadResult;
      try {
        uploadResult = await cloudinary.uploader.upload(filePath, {
          resource_type: "auto",
          folder: "submissions",
          public_id: `${(req.user && (req.user.uid || req.user.email)) || "user"}-${Date.now()}`,
        });
      } finally {
        try { await fs.unlink(filePath); } catch (e) { /* ignore cleanup errors */ }
      }

      const paperCode = crypto.randomUUID();

      const parser = new PDFParse({ url: uploadResult.secure_url });
      const result = await parser.getText();
	    console.log(result.text);

const aidetection = detectAIText(result.text);
console.log(aidetection.isAIGenerated);
const confidence = getConfidenceScore(result.text);
console.log(confidence);

      // Insert into PostgreSQL
      await pool.query(
        `INSERT INTO submissions 
         (conference_id, primary_author, title, abstract, track_id, file_url, paper_code, ai_score, is_ai)
         VALUES ($1, $2, $3, $4, $5, $6, $7,$8,$9);`,
        [
          id,
          req.user.email,
          title,
          abstract,
          areas,
          uploadResult.secure_url,
          paperCode,
          confidence,
          aidetection.isAIGenerated
        

        ]
      );

    	



      return res.redirect("/dashboard?message=Congratulations!!! Paper Submitted Succesfully, You can now share the Paper Code with your Co-Authors. Keep checking the status of your submission from the dashboard.");
    } catch (error) {
      console.error("Submit error:", error);
      return res.redirect("/dashboard?message=Something went wrong while submitting the paper.");
    }
  });
});




app.post("/submit-invited-talk", checkAuth, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' 
        ? 'File size exceeds 4MB limit. Please upload a smaller file.'
        : err.message;
      return res.redirect(`/dashboard?message=Error: ${message}`);
    }

    (async () => {
    

      if (!req.file) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("Error: No file uploaded. File size must not exceed 4MB."));
      }

      const { title, abstract, areas, conference_id } = req.body;
      if (!title || !abstract || !areas) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("All fields are required"));
      }

      const filePath = req.file.path;
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        resource_type: "auto",
        folder: "submissions",
        public_id: `${req.user.email}-${Date.now()}`,
      });

      const paper_id = crypto.randomUUID();

      try {
        await pool.query(
          `INSERT INTO invited_talk_submissions 
           (conference_id, invitee_email, title, abstract, track_id, file_url, paper_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            conference_id,
            req.user.email,
            title,
            abstract,
            areas,
            uploadResult.secure_url,
            paper_id
          ]
        );
      } catch (dbErr) {
        console.error("Error inserting submission:", dbErr);
        return res.redirect("/dashboard?message=" + encodeURIComponent("Submission failed."));
      }

      return res.redirect("/dashboard?message=" + encodeURIComponent("Submission saved successfully"));
    })().catch(next);
  });
});



passport.use(
  "google",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/dashboard",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    },
    async (accessToken, refreshToken, profile, cb) => {
      try {
        const email = profile.emails[0].value;

        //
        // 1. Check if user exists by uid (Google account previously linked)
        //
        const uidResult = await pool.query(
          `SELECT * FROM users WHERE uid = $1 LIMIT 1;`,
          [profile.id]
        );
        if (uidResult.rows.length > 0) {
          const user = uidResult.rows[0];
          user.role = user.role || "author";
          return cb(null, user);
        }

        //
        // 2. Check if account exists by email
        //
        const emailResult = await pool.query(
          `SELECT * FROM users WHERE email = $1 LIMIT 1;`,
          [email]
        );
        const existing = emailResult.rows[0];

        if (existing) {
          // If the user has a local password, block Google sign in
          if (existing.password_hash) {
            return cb(null, false, {
              message: "An account with this email already exists. Please sign in using Email + Password.",
            });
          }

          // Update missing fields if any
          const updates = [];
          const values = [];
          let idx = 1;

          if (!existing.uid) {
            updates.push(`uid = $${idx++}`);
            values.push(profile.id);
          }
          if (!existing.profile_picture) {
            updates.push(`profile_picture = $${idx++}`);
            values.push(profile.photos[0].value);
          }
          if (!existing.name) {
            updates.push(`name = $${idx++}`);
            values.push(profile.displayName);
          }

          if (updates.length > 0) {
            values.push(email);
            await pool.query(
              `UPDATE users SET ${updates.join(", ")} WHERE email = $${idx};`,
              values
            );
          }

          existing.role = existing.role || "author";
          return cb(null, existing);
        }

        //
        // 3. Insert new Google user
        //
        await pool.query(
          `INSERT INTO users (uid, name, email, profile_picture)
           VALUES ($1, $2, $3, $4);`,
          [profile.id, profile.displayName, email, profile.photos[0].value]
        );

        // Retrieve newly inserted user
        const newUserResult = await pool.query(
          `SELECT * FROM users WHERE uid = $1 LIMIT 1;`,
          [profile.id]
        );
        const newUser = newUserResult.rows[0];
        newUser.role = newUser.role || "author";

        return cb(null, newUser);

      } catch (err) {
        console.error("Google OAuth Error:", err);
        return cb(err);
      }
    }
  )
);


passport.use(
  "google3",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID3,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET3,
      callbackURL: "http://localhost:3000/auth3/google/dashboard3",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    },
    async (accessToken, refreshToken, profile, cb) => {
      try {
        const email = profile.emails[0].value;

        // 1. Check if the user exists in chair table
        const result = await pool.query(
          `SELECT * FROM chair WHERE email_id = $1 LIMIT 1;`,
          [email]
        );

        if (result.rows.length === 0) {
          return cb(null, false, {
            message: "You are not authorized as a chair for this conference.",
          });
        }

        const chair = result.rows[0];

        // 2. Determine updates needed
        const updates = {};
        if (!chair.profile_picture) updates.profile_picture = profile.photos[0].value;
        if (!chair.name) updates.name = profile.displayName;
        if (!chair.uid) updates.uid = profile.id;

        // 3. If updates exist, apply them
        if (Object.keys(updates).length > 0) {
          const updateFields = [];
          const values = [];
          let index = 1;

          for (const field in updates) {
            updateFields.push(`${field} = $${index}`);
            values.push(updates[field]);
            index++;
          }
          values.push(email); // last param for WHERE clause

          await pool.query(
            `UPDATE chair SET ${updateFields.join(", ")}
             WHERE email_id = $${index};`,
            values
          );
        }

        // 4. Set role for session object
        const user = { ...chair, ...updates, role: "chair" };

        return cb(null, user);

      } catch (err) {
        console.error("Google3 Chair Auth Error:", err);
        return cb(err);
      }
    }
  )
);


passport.use(
  "google2",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID2,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET2,
      callbackURL: "http://localhost:3000/auth2/google/dashboard2",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    },
    async (accessToken, refreshToken, profile, cb) => {
      try {
        const reviewerEmail = profile.emails[0].value;

        // 1. Fetch all tracks
        const trackResult = await pool.query(
          `SELECT track_reviewers FROM conference_tracks;`
        );

        const tracks = trackResult.rows;

        // 2. Check if email is listed as reviewer in any track
        const isReviewer = tracks.some(track =>
          Array.isArray(track.track_reviewers) &&
          track.track_reviewers.includes(reviewerEmail)
        );

        if (!isReviewer) {
          return cb(null, false, {
            message: "You are not authorized as a reviewer for any track.",
          });
        }

        // 3. Construct reviewer session user object (no DB write)
        const user = {
          uid: profile.id,
          name: profile.displayName,
          email: reviewerEmail,
          profile_picture: profile.photos?.[0]?.value || null,
          role: "reviewer",
        };

        return cb(null, user);

      } catch (err) {
        console.error("Reviewer Google Login Error:", err);
        return cb(err);
      }
    }
  )
);


passport.use(
  "google4",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID4,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET4,
      callbackURL: "http://localhost:3000/auth4/google/dashboard4",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    },
    async (accessToken, refreshToken, profile, cb) => {
      try {
        const userEmail = profile.emails[0].value;
        console.log("Google4 OAuth - User email:", userEmail);

        //
        // 1. Check if user exists in invitees table
        //
        const inviteeResult = await pool.query(
          `SELECT * FROM invitees WHERE email = $1;`,
          [userEmail]
        );
        const invitees = inviteeResult.rows;

        if (invitees.length === 0) {
          console.log("No invitee found for:", userEmail);
          return cb(null, false, {
            message: "You are not authorized as an invited speaker.",
          });
        }

        const invitee = invitees[0]; // If multiple exist, use the first


        //
        // 2. Update missing fields (name only)
        //
        const updates = {};
        if (!invitee.name) updates.name = profile.displayName;

        if (Object.keys(updates).length > 0) {
          const updateColumns = [];
          const values = [];
          let idx = 1;

          for (const key in updates) {
            updateColumns.push(`${key} = $${idx}`);
            values.push(updates[key]);
            idx++;
          }
          values.push(userEmail);

          await pool.query(
            `UPDATE invitees 
             SET ${updateColumns.join(", ")}
             WHERE email = $${idx};`,
            values
          );
        }


        //
        // 3. Construct authenticated user object
        //
        const user = {
          uid: profile.id,
          name: profile.displayName,
          email: userEmail,
          profile_picture: profile.photos?.[0]?.value || null,
          role: "invitee",
          conference_id: invitee.conference_id,
        };

        console.log("Google4 OAuth - Auth Success:", user);
        return cb(null, user);

      } catch (err) {
        console.error("Google4 Invitee Auth Error:", err);
        return cb(err);
      }
    }
  )
);



passport.serializeUser((user, cb) => {
  cb(null, { ...user, role: user.role });
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});


app.get("/logout", (req, res) => {
  // Explicitly delete cookies by setting maxAge to 0 and expires to past date
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
    maxAge: 0,
    expires: new Date(0)
  };

  res.cookie("token", "", cookieOptions);
  res.cookie("ChairToken", "", cookieOptions);

  console.log("Clearing cookies: token and ChairToken");
  return res.redirect("/?message=Logged out successfully");
});

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

