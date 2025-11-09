import express from "express";
import bodyParser from "body-parser";
import passport from "passport";
import { v4 as uuidv4 } from "uuid";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import bcrypt from "bcrypt";
import pool from "./config/db.js";

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
const upload = multer({ dest: "uploads/" });

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
  if (req.isAuthenticated()) {
    if (req.user.role === "author") {
      return res.redirect("/dashboard");
    } else if (req.user.role === "reviewer") {
      return res.redirect("/reviewer/dashboard");
    } else if (req.user.role === "chair") {
      return res.redirect("/chair/dashboard");
    }
    else if (req.user.role === "invitee") {
      return res.redirect("/invitee/dashboard");
    }
    // Add more roles as needed
  }
  const message = req.query.message || null;
  const result = await pool.query("SELECT * FROM conferences");
  const data = result.rows;
  
  // Format dates to dd-mm-yyyy
  const formattedData = data.map(conference => {
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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

app.get("/panelist/dashboard", (req, res) => {
  res.render("panelist/dashboard.ejs", { message: req.query.message || null });
});

app.get("/invitee/dashboard", ensureAuthenticatedOrToken, async (req, res) => {
  if (!req.user || req.user.role !== "invitee") {
    return res.redirect("/?message=You are not authorized to access this page.");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}-${month}-${year}`;
    };

    //
    // 1. Fetch conference details
    //
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1`,
      [req.user.conference_id]
    );
    const conference = conferenceResult.rows[0];

    if (!conference) {
      return res.status(500).send("Error fetching conference details.");
    }

    // Format conference dates
    conference.conference_start_date = formatDate(conference.conference_start_date);
    conference.conference_end_date = formatDate(conference.conference_end_date);
    conference.full_paper_submission = formatDate(conference.full_paper_submission);
    conference.acceptance_notification = formatDate(conference.acceptance_notification);
    conference.camera_ready_paper_submission = formatDate(conference.camera_ready_paper_submission);

    //
    // 2. Fetch invitee's submissions
    //
    const submissionsResult = await pool.query(
      `SELECT * FROM invited_talk_submissions 
       WHERE conference_id = $1 AND invitee_email = $2`,
      [req.user.conference_id, req.user.email]
    );
    const submissions = submissionsResult.rows;

    //
    // 3. Fetch tracks for this conference
    //
    const tracksResult = await pool.query(
      `SELECT track_id, track_name
       FROM conference_tracks
       WHERE conference_id = $1`,
      [req.user.conference_id]
    );
    const tracks = tracksResult.rows;

    // Create a map of track_id → track_name
    const trackMap = {};
    tracks.forEach(track => {
      trackMap[track.track_id] = track.track_name;
    });

    // Enrich submissions with track names
    const submissionsWithTrackNames = submissions.map(submission => ({
      ...submission,
      track_name: trackMap[submission.track_id] || submission.track_id || "N/A",
    }));

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


app.get("/dashboard", async (req, res) => {
  if (!req.user) return res.redirect("/");
  if (req.user.role !== "author") {
    return res.redirect("/?message=You are not authorized to access the author dashboard.");
  }

  try {
    // Helper function to format dates to yyyy-mm-dd for comparisons
    const formatDateISO = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // 1. Get all conferences
    const conferencedata = (await pool.query(`SELECT * FROM conferences;`)).rows.map(conference => ({
      ...conference,
      conference_start_date: formatDateISO(conference.conference_start_date),
      conference_end_date: formatDateISO(conference.conference_end_date),
      full_paper_submission: formatDateISO(conference.full_paper_submission),
      acceptance_notification: formatDateISO(conference.acceptance_notification),
      camera_ready_paper_submission: formatDateISO(conference.camera_ready_paper_submission)
    }));

    // 2. Get user's track_ids
    const trackinfodata = (
      await pool.query(
        `SELECT track_id
         FROM submissions
         WHERE primary_author = $1
         OR $1 = ANY(co_authors);`,
        [req.user.email]
      )
    ).rows;

    const trackIds = [...new Set(trackinfodata.map(t => t.track_id).filter(Boolean))];

    // 3. Get presentation track info
    let presentationdatainfo = [];
    if (trackIds.length > 0) {
      presentationdatainfo = (
        await pool.query(
          `SELECT * FROM conference_tracks WHERE track_id = ANY($1);`,
          [trackIds]
        )
      ).rows.map(track => ({
        ...track,
        presentation_date: formatDateISO(track.presentation_date)
      }));
    }

    // 4. Get full submission data for the user
    const submissiondata = (
      await pool.query(
        `SELECT * FROM submissions
         WHERE primary_author = $1
         OR $1 = ANY(co_authors);`,
        [req.user.email]
      )
    ).rows;

    // 5. Map track_id → track_name
    const trackMap = {};
    presentationdatainfo.forEach(t => (trackMap[t.track_id] = t.track_name));

    // 6. Collect all author/co-author emails to fetch names
    const allEmails = new Set();
    submissiondata.forEach(sub => {
      allEmails.add(sub.primary_author);
      if (Array.isArray(sub.co_authors)) sub.co_authors.forEach(e => allEmails.add(e));
    });

    let emailArray = Array.from(allEmails);
    let userData = [];

    if (emailArray.length > 0) {
      userData = (
        await pool.query(
          `SELECT email, name FROM users WHERE email = ANY($1);`,
          [emailArray]
        )
      ).rows;
    }

    const emailToNameMap = {};
    userData.forEach(u => (emailToNameMap[u.email] = u.name));

    const formatNameEmail = (email) => {
      const name = emailToNameMap[email];
      return name ? `${name} (${email})` : email;
    };

    const submissionsWithTrackNames = submissiondata.map(sub => ({
      ...sub,
      track_name: trackMap[sub.track_id] || 'There was error fetching the track name for this submission.',
      primary_author_formatted: formatNameEmail(sub.primary_author),
      co_authors_formatted: Array.isArray(sub.co_authors)
        ? sub.co_authors.map(formatNameEmail).join(", ")
        : (sub.co_authors ? formatNameEmail(sub.co_authors) : "")
    }));

    // 7. Get user's submission_ids (only primary authored)
    const userSubmissionIds = submissiondata
      .filter(sub => sub.primary_author === req.user.email)
      .map(sub => sub.submission_id);

    // 8. Get co-author requests
    let coAuthorRequests = [];
    if (userSubmissionIds.length > 0) {
      coAuthorRequests = (
        await pool.query(
          `SELECT * FROM co_author_requests WHERE submission_id = ANY($1);`,
          [userSubmissionIds]
        )
      ).rows;
    }

    // 9. Get revised submissions
    let revisedSubmissionsMap = {};
    if (userSubmissionIds.length > 0) {
      const revised = (
        await pool.query(
          `SELECT submission_id, file_url FROM revised_submissions WHERE submission_id = ANY($1);`,
          [userSubmissionIds]
        )
      ).rows;

      revised.forEach(r => (revisedSubmissionsMap[r.submission_id] = r.file_url));
    }

    // 10. Get poster sessions
    const conferenceIds = [...new Set(
      submissiondata
        .filter(sub =>
          sub.submission_status === "Accepted for Poster Presentation" ||
          sub.submission_status === "Submitted Final Camera Ready Paper for Poster Presentation"
        )
        .map(sub => sub.conference_id)
    )];

    let posterSessionsMap = {};
    if (conferenceIds.length > 0) {
      const posterSessions = (
        await pool.query(
          `SELECT * FROM poster_session WHERE conference_id = ANY($1);`,
          [conferenceIds]
        )
      ).rows;

      posterSessions.forEach(ps => (posterSessionsMap[ps.conference_id] = ps));
    }

    // 11. Track details map for oral presentations
    const trackDetailsMap = {};
    presentationdatainfo.forEach(track => {
      trackDetailsMap[track.track_id] = track;
    });

    res.render("dashboard.ejs", {
      user: req.user,
      conferences: conferencedata,
      userSubmissions: submissionsWithTrackNames,
      presentationdata: presentationdatainfo,
      currentDate: (() => {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      })(),
      message: req.query.message || null,
      trackinfodata,
      coAuthorRequests,
      revisedSubmissionsMap,
      posterSessionsMap,
      trackDetailsMap,
    });

  } catch (err) {
    console.error(err);
    return res.redirect(
      "/?message=We are facing some issues in connecting to the database. Please try again later."
    );
  }
});


app.post("/publish/review-results", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

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
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
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

app.get("/chair/dashboard/manage-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}-${month}-${year}`;
    };

    // Tracks
    const tracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1;`,
      [req.params.id]
    );
    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDate(track.presentation_date)
    }));

    // Conference
    const confResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const conferenceRaw = confResult.rows[0];
    const conference = {
      ...conferenceRaw,
      conference_start_date: formatDate(conferenceRaw.conference_start_date),
      conference_end_date: formatDate(conferenceRaw.conference_end_date),
      full_paper_submission: formatDate(conferenceRaw.full_paper_submission),
      acceptance_notification: formatDate(conferenceRaw.acceptance_notification),
      camera_ready_paper_submission: formatDate(conferenceRaw.camera_ready_paper_submission)
    };

    // Submissions (Final Camera Ready or Completed)
    const submissionsResult = await pool.query(
      `SELECT * FROM submissions 
       WHERE conference_id = $1
       AND submission_status = ANY($2);`,
      [req.params.id, [
        "Submitted Final Camera Ready Paper",
        "Presentation Completed"
      ]]
    );
    const submissions = submissionsResult.rows;

    // Count submissions per track
    const trackCounts = {};
    submissions.forEach(sub => {
      trackCounts[sub.track_id] = (trackCounts[sub.track_id] || 0) + 1;
    });

    const count = tracks.map(track => ({
      track_id: track.track_id,
      track_name: track.track_name,
      count: trackCounts[track.track_id] || 0,
    }));

    // Build leaderboard per track
    const tracksWithLeaderboard = await Promise.all(
      tracks.map(async track => {
        const trackSubs = submissions.filter(s => s.track_id === track.track_id);

        const leaderboard = await Promise.all(
          trackSubs.map(async sub => {
            // Reviewer scores
            const reviewResult = await pool.query(
              `SELECT mean_score FROM peer_review WHERE submission_id = $1;`,
              [sub.submission_id]
            );
            let reviewerScore = null;
            if (reviewResult.rows.length > 0) {
              reviewerScore = reviewResult.rows.reduce(
                (sum, r) => sum + (r.mean_score || 0), 0
              ) / reviewResult.rows.length;
            }

            // Panelist score
            const panelistResult = await pool.query(
              `SELECT panelist_score FROM final_camera_ready_submissions
               WHERE submission_id = $1 LIMIT 1;`,
              [sub.submission_id]
            );
            const panelistScore = panelistResult.rows[0]?.panelist_score || null;

            // Combined score
            let avg = null;
            if (reviewerScore !== null && panelistScore !== null) avg = (reviewerScore + panelistScore) / 2;
            else avg = reviewerScore !== null ? reviewerScore : panelistScore;

            // Author names
            const emails = [sub.primary_author, ...(sub.co_authors || [])];
            const userResult = await pool.query(
              `SELECT email, name FROM users WHERE email = ANY($1);`,
              [emails]
            );
            const map = Object.fromEntries(userResult.rows.map(u => [u.email, u.name]));
            const fmt = e => map[e] ? `${map[e]} (${e})` : e;

            return {
              ...sub,
              reviewerScore: reviewerScore !== null ? +reviewerScore.toFixed(2) : null,
              panelistScore: panelistScore !== null ? +panelistScore.toFixed(2) : null,
              averageScore: avg !== null ? +avg.toFixed(2) : null,
              primary_author_formatted: fmt(sub.primary_author),
              co_authors_formatted: (sub.co_authors || []).map(fmt).join(", ")
            };
          })
        );

        const ranked = leaderboard
          .filter(s => s.averageScore !== null)
          .sort((a, b) => b.averageScore - a.averageScore)
          .map((item, i) => ({ ...item, rank: i + 1 }));

        const unranked = leaderboard
          .filter(s => s.averageScore === null)
          .map(s => ({ ...s, rank: null }));

        return { ...track, leaderboard: [...ranked, ...unranked] };
      })
    );

    res.render("chair/manage-sessions.ejs", {
      user: req.user,
      tracks: tracksWithLeaderboard,
      conference,
      count,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("manage-sessions error:", err);
    return res.status(500).send("Error fetching data.");
  }
});


app.get("/chair/dashboard/manage-poster-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates for display (dd-mm-yyyy)
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}-${month}-${year}`;
    };

    // Helper function to format dates for HTML date inputs (yyyy-mm-dd)
    const formatDateForInput = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
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
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("manage-poster-sessions error:", err);
    res.status(500).send("Error fetching data.");
  }
});


app.post("/chair/dashboard/set-poster-session/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { session_date, start_time, end_time, conference_id } = req.body;

  try {
    await pool.query(
      `UPDATE poster_session
       SET date = $1,
           start_time = $2,
           end_time = $3
       WHERE conference_id = $4;`,
      [session_date, start_time, end_time, conference_id]
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


app.get("/panelist/active-session/:id", async (req, res) => {
  try {
    // 1. Fetch track info
    const trackResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE track_id = $1`,
      [req.params.id]
    );
    const trackinfo = trackResult.rows[0];

    if (!trackinfo) {
      return res.redirect("/panelist/dashboard?message=Track not found.");
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
        const [y, mo, d] = trackinfo.presentation_date.split("-").map(Number);
        const [sh, sm] = trackinfo.presentation_start_time.split(":").map(Number);
        const [eh, em] = trackinfo.presentation_end_time.split(":").map(Number);

        const startUtcMs = Date.UTC(y, mo - 1, d, sh, sm) - istOffset;
        const endUtcMs = Date.UTC(y, mo - 1, d, eh, em) - istOffset;
        const nowUtcMs = Date.now();
        const bufferMs = 5 * 60 * 1000;

        if (nowUtcMs < (startUtcMs - bufferMs)) {
          return res.redirect('/?message=Session not started yet.');
        }

        if (nowUtcMs > endUtcMs) {
          return res.redirect('/?message=Session has ended.');
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
    }

    // 5. Render
    return res.render("panelist/active-session.ejs", {
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

    if (track.presentation_date == currentDate) {
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


app.get("/reviewer/dashboard/review/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  try {
    const paperCode = req.params.id;

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
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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


app.get("/reviewer/dashboard/re-review/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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


app.post("/mark-as-re-reviewed", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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
    // 4. Update submissions table status
    //
    await pool.query(
      `UPDATE submissions
       SET submission_status = $1
       WHERE submission_id = $2;`,
      [status, submission_id]
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

    return res.redirect("/reviewer/dashboard?message=Revised paper review submitted successfully.");

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
            `Panelist Assignment - ${track.track_name}`,
            `You have been assigned as a panelist for the track "${track.track_name}".`,
            `<p>Dear Panelist,</p>
             <p>You have been assigned as a panelist for the following:</p>
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


app.get("/chair/dashboard/invited-talks/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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

app.post("/add-invitee", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { email, conference_id } = req.body;
  if (!email || !conference_id) {
    return res.status(400).send("Email and conference ID are required.");
  }

  try {
    // 1. Insert invitee row
    await pool.query(
      `INSERT INTO invitees (conference_id, email)
       VALUES ($1, $2);`,
      [conference_id, email]
    );
  } catch (err) {
    console.error("Error adding invitee:", err);
    return res.redirect(`/chair/dashboard/invited-talks/${conference_id}?message=Error adding invitee.`);
  }

  try {
    // 2. Generate setup token (valid 24 hours)
    const setupToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // Timestamp, not string

    await pool.query(
      `UPDATE invitees
       SET password_reset_token = $1,
           password_reset_expires = $2
       WHERE conference_id = $3 AND email = $4;`,
      [setupToken, expiresAt, conference_id, email]
    );

    // 3. Fetch conference title for email
    const confResult = await pool.query(
      `SELECT title FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [conference_id]
    );
    const conferenceTitle = confResult.rows[0]?.title || "the conference";

    const resetLink = `${APP_URL}/invitee/reset-password?token=${encodeURIComponent(setupToken)}`;

    const htmlBody = `
      <p>Dear Invitee,</p>
      <p>You have been invited to present at <strong>${conferenceTitle}</strong>.</p>
      <p>You may sign in using Google, or create a password for email login.</p>
      <p>To set your password (valid 24 hours):</p>
      <p><a href="${resetLink}">${resetLink}</a></p>
      <p>After setting your password, log in using this email: <strong>${email}</strong>.</p>
      <p>For support, contact <strong>multimedia@dei.ac.in</strong> or <strong>+91 9875691340</strong>.</p>
      <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>
    `;

    try {
      await sendMail(
        email,
        `Invited to Present at ${conferenceTitle} - Set Your Password`,
        `You have been invited to present at ${conferenceTitle}. Set your password: ${resetLink}`,
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


app.post("/mark-as-reviewed", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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
    return res.redirect("/reviewer/dashboard?message=Submission has been successfully marked as reviewed.");

  } catch (err) {
    console.error("Mark-as-reviewed error:", err);
    return res.redirect("/reviewer/dashboard?message=We are facing some issues in marking this submission as reviewed.");
  }
});


app.post("/mark-presentation-as-complete", async (req, res) => {
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
      `/panelist/active-session/${track_id}?message=Submission has been successfully marked as completed.`
    );
  } catch (err) {
    console.error("Error updating submission:", err);
    return res.render("error.ejs", {
      message:
        "We are facing some issues in marking this submission as completed.",
    });
  }
});



app.get("/chair/dashboard/delete-conference/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    await pool.query(`DELETE FROM conference_tracks WHERE conference_id = $1;`, [req.params.id]);
    await pool.query(`DELETE FROM conferences WHERE conference_id = $1;`, [req.params.id]);

    res.redirect("/chair/dashboard");
  } catch (err) {
    console.error("Error deleting conference:", err);
    res.status(500).send("Error deleting conference.");
  }
});



app.get("/submission/co-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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


app.post("/join", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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

    // 6. Insert new co-author request
    await pool.query(
      `INSERT INTO co_author_requests (conference_id, submission_id, co_author, status)
       VALUES ($1, $2, $3, $4);`,
      [id, submission.submission_id, req.user.email, "Submitted For Review"]
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


app.post("/co-author-request/accept/:request_id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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
app.post("/co-author-request/reject/:request_id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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


app.post("/create-new-conference", async (req, res) => {
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
    // 1. Insert conference and return row
    const confResult = await pool.query(
      `INSERT INTO conferences
      (title, description, conference_start_date, conference_end_date, full_paper_submission, acceptance_notification, camera_ready_paper_submission)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING conference_id;`,
      [
        title,
        description,
        conference_start_date,
        conference_end_date,
        full_paper_submission,
        acceptance_notification,
        camera_ready_paper_submission
      ]
    );

    const conference_id = confResult.rows[0].conference_id;

    // 2. Insert poster session placeholder row
    await pool.query(
      `INSERT INTO poster_session (conference_id, date, start_time, end_time)
       VALUES ($1, null, null, null);`,
      [conference_id]
    );

    // 3. Collect tracks from request body
    const tracks = [];
    let i = 1;
    while (req.body[`track_title_${i}`] && req.body[`track_reviewer_${i}`]) {
      tracks.push({
        conference_id,
        track_name: req.body[`track_title_${i}`],
        track_reviewers: [req.body[`track_reviewer_${i}`]], // -> TEXT[] in DB
      });
      i++;
    }

    // 4. Insert tracks into conference_tracks
    if (tracks.length > 0) {
      const trackValues = tracks.flatMap(t => [t.conference_id, t.track_name, t.track_reviewers]);

      // Bulk insert
      const valuePlaceholders = tracks
        .map((_, idx) => `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`)
        .join(",");

      await pool.query(
        `INSERT INTO conference_tracks (conference_id, track_name, track_reviewers)
         VALUES ${valuePlaceholders};`,
        trackValues
      );

      // 5. Notify reviewers
      for (const track of tracks) {
        for (const reviewerEmail of track.track_reviewers) {
          try {
            await sendMail(
              reviewerEmail,
              `Reviewer Assignment - ${title}`,
              `You have been assigned as a reviewer for the track "${track.track_name}" in the conference "${title}".`,
              `<p>Dear Reviewer,</p>
              <p>You have been assigned as a reviewer for:</p>
              <p><strong>Conference:</strong> ${title}</p>
              <p><strong>Track:</strong> ${track.track_name}</p>
              <p><strong>Conference Dates:</strong> ${conference_start_date} to ${conference_end_date}</p>
              <p>You may now log in with your email: <strong>${reviewerEmail}</strong></p>
              <p>For help, contact <strong>multimedia@dei.ac.in</strong> or <strong>+91 9875691340</strong></p>
              <p>Regards,<br>DEI Conference Management Toolkit Team</p>`
            );
          } catch (emailError) {
            console.error(`Error emailing reviewer ${reviewerEmail}:`, emailError);
          }
        }
      }
    }

    res.redirect("/chair/dashboard");

  } catch (err) {
    console.error("Create conference error:", err);
    return res.status(500).send("Error creating conference.");
  }
});


app.get("/chair/create-new-conference", (req, res) => {
   if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }
  res.render("chair/create-new-conference.ejs" , {
    user: req.user,
    message: req.query.message || null,
  });
});

app.get("/submission/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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

app.get("/submission/invited-talk/:id", ensureAuthenticatedOrToken, async (req, res) => {
  if (!req.user || req.user.role !== "invitee") {
    return res.redirect("/?message=You are not authorized to access this page.");
  }

  try {
    const conferenceId = req.params.id;

    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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


app.get("/submission/edit/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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


app.get("/submission/revised/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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


app.get("/submission/final-camera-ready/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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
      const now = new Date();
      const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // IST
      
      // Get current date in yyyy-mm-dd format
      const currentYear = istTime.getFullYear();
      const currentMonth = String(istTime.getMonth() + 1).padStart(2, '0');
      const currentDay = String(istTime.getDate()).padStart(2, '0');
      const currentDate = `${currentYear}-${currentMonth}-${currentDay}`;
      
      // Get deadline date in yyyy-mm-dd format
      const deadlineDate = new Date(conferenceInfo.camera_ready_paper_submission);
      const deadlineYear = deadlineDate.getFullYear();
      const deadlineMonth = String(deadlineDate.getMonth() + 1).padStart(2, '0');
      const deadlineDay = String(deadlineDate.getDate()).padStart(2, '0');
      const deadline = `${deadlineYear}-${deadlineMonth}-${deadlineDay}`;

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


app.post("/final-camera-ready-submission", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
          ? "File size exceeds 4MB limit. Please upload a smaller file."
          : err.message;
        return res.redirect(`/dashboard?message=Error: ${message}`);
      }

      if (!req.isAuthenticated()) return res.redirect("/");

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
          const now = new Date();
          const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // IST
          
          // Get current date in yyyy-mm-dd format
          const currentYear = istTime.getFullYear();
          const currentMonth = String(istTime.getMonth() + 1).padStart(2, '0');
          const currentDay = String(istTime.getDate()).padStart(2, '0');
          const currentDate = `${currentYear}-${currentMonth}-${currentDay}`;
          
          // Get deadline date in yyyy-mm-dd format
          const deadlineDate = new Date(confRow.camera_ready_paper_submission);
          const deadlineYear = deadlineDate.getFullYear();
          const deadlineMonth = String(deadlineDate.getMonth() + 1).padStart(2, '0');
          const deadlineDay = String(deadlineDate.getDate()).padStart(2, '0');
          const deadline = `${deadlineYear}-${deadlineMonth}-${deadlineDay}`;

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

app.get("/chair/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}-${month}-${year}`;
    };

    const result = await pool.query(`SELECT * FROM conferences;`);
    const conferences = result.rows.map(conference => ({
      ...conference,
      conference_start_date: formatDate(conference.conference_start_date),
      conference_end_date: formatDate(conference.conference_end_date),
      full_paper_submission: formatDate(conference.full_paper_submission),
      acceptance_notification: formatDate(conference.acceptance_notification),
      camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission)
    }));

    res.render("chair/dashboard.ejs", {
      user: req.user,
      conferences,
      message: req.query.message || null,
    });
  } catch (err) {
    console.error("Database error:", err);
    return res.send("Database error!");
  }
});


app.get("/chair/dashboard/edit-conference/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates for HTML date inputs (yyyy-mm-dd)
    const formatDateForInput = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
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

    //
    // 2. Fetch existing tracks
    //
    const existingTracksResult = await pool.query(
      `SELECT * FROM conference_tracks WHERE conference_id = $1 ORDER BY track_id ASC;`,
      [conferenceId]
    );
    const existingTracks = existingTracksResult.rows;

    //
    // 3. Collect updated track entries from form
    //
    const newTracks = [];
    let i = 1;
    while (req.body[`track_title_${i}`] && req.body[`track_reviewer_${i}`]) {
      newTracks.push({
        track_name: req.body[`track_title_${i}`],
        track_reviewers: [req.body[`track_reviewer_${i}`]],
      });
      i++;
    }

    //
    // 4. Update matching tracks
    //
    for (let idx = 0; idx < Math.min(existingTracks.length, newTracks.length); idx++) {
      const oldTrack = existingTracks[idx];
      const newTrack = newTracks[idx];

      // Update track name & reviewers (keep session fields intact)
      await pool.query(
        `UPDATE conference_tracks
         SET track_name = $1,
             track_reviewers = $2
         WHERE track_id = $3;`,
        [newTrack.track_name, newTrack.track_reviewers, oldTrack.track_id]
      );

      // Notify newly added reviewers
      const previousReviewers = oldTrack.track_reviewers || [];
      const updatedReviewers = newTrack.track_reviewers || [];
      const addedReviewers = updatedReviewers.filter(r => !previousReviewers.includes(r));

      if (addedReviewers.length > 0) {
        const confTitleResult = await pool.query(
          `SELECT title FROM conferences WHERE conference_id = $1 LIMIT 1;`,
          [conferenceId]
        );
        const confTitle = confTitleResult.rows[0]?.title || "Conference";

        for (const email of addedReviewers) {
          try {
            await sendMail(
              email,
              `Reviewer Assignment - ${confTitle}`,
              `You have been assigned as a reviewer for the track "${newTrack.track_name}".`,
              `<p>Dear Reviewer,</p>
               <p>You have been assigned as a reviewer for <strong>${newTrack.track_name}</strong> in <strong>${confTitle}</strong>.</p>
               <p>Please log in using this email address.</p>
               <p>Regards,<br>Conference Management Toolkit Team</p>`
            );
          } catch (err) {
            console.error("Email error:", err);
          }
        }
      }
    }

    //
    // 5. Insert additional tracks (if newTracks > existingTracks)
    //
    if (newTracks.length > existingTracks.length) {
      const tracksToInsert = newTracks.slice(existingTracks.length).map(t => [
        conferenceId,
        t.track_name,
        t.track_reviewers
      ]);

      const values = tracksToInsert.flat();
      const placeholders = tracksToInsert
        .map((_, idx) => `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`)
        .join(",");

      await pool.query(
        `INSERT INTO conference_tracks (conference_id, track_name, track_reviewers)
         VALUES ${placeholders};`,
        values
      );
    }

    //
    // 6. Delete extra tracks (if existingTracks > newTracks)
    //
    if (newTracks.length < existingTracks.length) {
      const extraTrackIds = existingTracks.slice(newTracks.length).map(t => t.track_id);

      await pool.query(
        `DELETE FROM conference_tracks WHERE track_id = ANY($1);`,
        [extraTrackIds]
      );
    }

    return res.redirect("/chair/dashboard");

  } catch (err) {
    console.error("Update conference error:", err);
    return res.status(500).send("Error updating conference.");
  }
});


app.get("/chair/dashboard/view-submissions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  try {
    // Helper function to format dates
    const formatDate = (dateString) => {
      if (!dateString) return dateString;
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
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


app.post('/chair/dashboard/delete-submission/:id', async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== 'chair') {
    return res.redirect('/');
  }

  const submissionId = req.params.id;
  const conferenceId = req.query.conference_id || req.body.conference_id;

  try {
    // 1. Delete related peer reviews
    await pool.query(
      `DELETE FROM peer_review WHERE submission_id = $1;`,
      [submissionId]
    );

    // 2. Delete any final camera-ready submission entry
    await pool.query(
      `DELETE FROM final_camera_ready_submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    // 3. Delete submission itself
    await pool.query(
      `DELETE FROM submissions WHERE submission_id = $1;`,
      [submissionId]
    );

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


app.post("/submit-revised-paper", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'File size exceeds 4MB limit. Please upload a smaller file.'
        : err.message;
      return res.redirect(`/dashboard?message=Error: ${message}`);
    }

    (async () => {
      // Accept either session / Bearer / jwt cookie (unchanged logic)
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        const authHeader = req.headers?.authorization;
        if (authHeader) {
          const parts = authHeader.split(" ");
          if (parts.length === 2 && parts[0] === "Bearer") {
            try { req.user = jwt.verify(parts[1], process.env.JWT_SECRET || "dev_jwt_secret"); }
            catch { return res.redirect("/"); }
          }
        }

        if (!req.user) {
          const cookieHeader = req.headers?.cookie;
          if (cookieHeader) {
            const jwtCookie = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('jwt='));
            if (jwtCookie) {
              const token = jwtCookie.split('=')[1];
              try { req.user = jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret"); }
              catch { return res.redirect("/"); }
            }
          }
        }
      }

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


app.post("/edit-submission", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
          ? "File size exceeds 4MB limit. Please upload a smaller file."
          : err.message;
        return res.redirect(`/dashboard?message=Error: ${message}`);
      }

      // Ensure authentication by session or token fallback
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        const authHeader = req.headers?.authorization;
        if (authHeader) {
          const parts = authHeader.split(" ");
          if (parts.length === 2 && parts[0] === "Bearer") {
            try {
              req.user = jwt.verify(parts[1], process.env.JWT_SECRET || "dev_jwt_secret");
            } catch {
              return res.redirect("/");
            }
          }
        }

        if (!req.user) {
          const cookieHeader = req.headers?.cookie;
          if (cookieHeader) {
            const jwtCookie = cookieHeader.split(";").map(c => c.trim()).find(c => c.startsWith("jwt="));
            if (jwtCookie) {
              const token = jwtCookie.split("=")[1];
              try {
                req.user = jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret");
              } catch {
                return res.redirect("/");
              }
            }
          }
        }
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


app.get("/submission/delete/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

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



app.get("/submission/delete/invitee/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "invitee") {
    return res.redirect("/");
  }

  try {
    await pool.query(
      `DELETE FROM invited_talk_submissions WHERE paper_id = $1`,
      [req.params.id]
    );

    return res.redirect("/invitee/dashboard?message=Submission deleted successfully!");
  } catch (err) {
    console.error("Error deleting invited talk submission:", err);
    return res.redirect("/invitee/dashboard?message=Error deleting submission.");
  }
});


app.post("/submit", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    try {
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE"
          ? "File size exceeds 4MB limit. Please upload a smaller file."
          : err.message;
        return res.redirect(`/dashboard?message=Error: ${message}`);
      }

      if (!req.isAuthenticated()) return res.redirect("/");

      if (!req.file) {
        return res.redirect("/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.");
      }

      const { title, abstract, areas, id } = req.body;
      const filePath = req.file.path;

      // Upload to Cloudinary
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        resource_type: "auto",
        folder: "submissions",
        public_id: `${req.user.uid}-${Date.now()}`,
      });

      const paperCode = crypto.randomUUID();

      // Insert into PostgreSQL
      await pool.query(
        `INSERT INTO submissions 
         (conference_id, primary_author, title, abstract, track_id, file_url, paper_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          id,
          req.user.email,
          title,
          abstract,
          areas,
          uploadResult.secure_url,
          paperCode
        ]
      );

      return res.redirect("/dashboard");
    } catch (error) {
      console.error("Submit error:", error);
      return res.redirect("/dashboard?message=Something went wrong while submitting the paper.");
    }
  });
});




app.post("/submit-invited-talk", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' 
        ? 'File size exceeds 4MB limit. Please upload a smaller file.'
        : err.message;
      return res.redirect(`/invitee/dashboard?message=Error: ${message}`);
    }

    (async () => {
      if (!req.user || req.user.role !== "invitee") {
        return res.redirect("/?message=Unauthorized");
      }

      if (!req.file) {
        return res.redirect("/invitee/dashboard?message=" + encodeURIComponent("Error: No file uploaded. File size must not exceed 4MB."));
      }

      const { title, abstract, areas } = req.body;
      if (!title || !abstract || !areas) {
        return res.redirect("/invitee/dashboard?message=" + encodeURIComponent("All fields are required"));
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
            req.user.conference_id,
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
        return res.redirect("/invitee/dashboard?message=" + encodeURIComponent("Submission failed."));
      }

      return res.redirect("/invitee/dashboard?message=" + encodeURIComponent("Submission saved successfully"));
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
  req.logout(function (err) {
    if (err) {
      return next(err);
    }
    res.redirect("/");
  });
});

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

