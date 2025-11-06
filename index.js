import express from "express";
import bodyParser from "body-parser";
import passport from "passport";
import { v4 as uuidv4 } from "uuid";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import bcrypt from "bcrypt";
import { Strategy as LocalStrategy } from "passport-local";
import jwt from "jsonwebtoken";
import session from "express-session";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";
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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
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
    secret: process.env.SESSION_SECRET || "dev_session_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// -----------------------------
// Local auth routes (email + password)
// -----------------------------
// Register: create a new user with password_hash
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }

    // Check if user already exists
    const existing = await supabase.from("users").select("*").eq("email", email).single();
    if (existing.data) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const uid = uuidv4();

    const { error: insertError } = await supabase.from("users").insert([
      {
        uid,
        name,
        email,
        password_hash,
        role: 'author',
        profile_picture: null,
      },
    ]);

    if (insertError) {
      console.error("Error inserting user:", insertError);
      return res.status(500).json({ error: "Could not create user" });
    }

  const { data: newUser } = await supabase.from("users").select("uid,name,email,profile_picture,role").eq("email", email).single();

    // create JWT and set cookie so browser can be redirected and authenticated
    const payload = { uid: newUser.uid, name: newUser.name, email: newUser.email, role: newUser.role || 'author' };
    const token = jwt.sign(payload, process.env.JWT_SECRET || "dev_jwt_secret", { expiresIn: "7d" });

    // set httpOnly cookie and also return token in json for client-side usage
    res.cookie("jwt", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    return res.status(201).json({ token, user: payload });
  } catch (err) {
    console.error("/register error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

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
  const { data, error } = await supabase.from("conferences").select("*");
  res.render("home.ejs", { conferences: data, message: message });
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
      "/?message=You have not been assigned any tracks. Please contact the conference organizers for more information. ",
    successRedirect: "/reviewer/dashboard", // REMOVED
  }),
  async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.redirect("/");
    }

    // Fetch all tracks
    const { data: tracks, error } = await supabase
      .from("conference_tracks")
      .select("*");

    if (error) {
      console.error(error);
      return res.redirect(
        "/?message=We are facing some issues in fetching your assigned tracks. Please try again later. Sincere apologies for the inconvenience caused."
      );
    }

    // Check if user is a reviewer for any track
    const reviewerTracks = (tracks || []).filter(
      (track) =>
        Array.isArray(track.track_reviewers) &&
        track.track_reviewers.includes(req.user.email)
    );

    if (reviewerTracks.length === 0) {
      return res.redirect(
        "/?message=You are not authorized as a reviewer for any track."
      );
    }

    // Fetch all submissions for these tracks
    const trackIds = reviewerTracks.map((track) => track.track_id);
    let submissiondata = [];
    if (trackIds.length > 0) {
      const { data: submissions, error: submissionerror } = await supabase
        .from("submissions")
        .select("*")
        .in("track_id", trackIds);

      if (submissionerror) {
        console.error(submissionerror);
        return res.redirect(
          "/?message=We are facing some issues in fetching the submissions."
        );
      }
      submissiondata = submissions || [];
    }

    return res.render("reviewer/dashboard", {
      user: req.user,
      tracks: reviewerTracks,
      userSubmissions: submissiondata,
    });
  }
);

app.get(
  "/auth3/google/dashboard3",
  passport.authenticate("google3", {
    failureRedirect: "/?message=You are not authorized to access this page.",
    successRedirect: "/chair/dashboard",
  }),
  async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.redirect("/");
    }

    const { data, error } = await supabase
      .from("conference_tracks")
      .select("*");
    const reviewerTracks = (data || []).filter(
      (track) =>
        Array.isArray(track.track_reviewers) &&
        track.track_reviewers.includes(req.user.email)
    );

    if (reviewerTracks.length > 0) {
      const trackIds = reviewerTracks.map((track) => track.track_id);

      // Fetch all submissions for these tracks
      let submissiondata = [];
      if (trackIds.length > 0) {
        const { data: submissions, error: submissionerror } = await supabase
          .from("submissions")
          .select("*")
          .in("track_id", trackIds);

        if (submissionerror) {
          console.error(submissionerror);
          return res.render("error.ejs", {
            message: "We are facing some issues in fetching the submissions.",
          });
        }
        submissiondata = submissions || [];
      }

      res.render("reviewer/dashboard", {
        user: req.user,
        tracks: reviewerTracks,
        userSubmissions: submissiondata,
      });
    } else {
      res.render("error.ejs", {
        message:
          "You are not assigned to any tracks. Please contact the conference organizers for more information.",
      });
    }
    if (error && error.code !== "PGRST116") {
      console.error(error);
      return res.send(
        "We are facing some issues in fetching your assigned tracks. Please try again later. Sincere apologies for the inconvenience caused."
      );
    }
  }
);

app.get("/error", (req, res) => {
  res.render("error.ejs", { message });
});

app.get("/panelist/dashboard", (req, res) => {
  res.render("panelist/dashboard.ejs", { message: req.query.message || null });
});

app.get("/invitee/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "invitee") {
    return res.redirect("/?message=You are not authorized to access this page.");
  }

  // Fetch conference details
  const { data: conference, error: conferenceError } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.user.conference_id)
    .single();

  if (conferenceError || !conference) {
    console.error("Error fetching conference:", conferenceError);
    return res.status(500).send("Error fetching conference details.");
  }

  // Fetch invitee's submissions
  const { data: submissions, error: submissionsError } = await supabase
    .from("invited_talk_submissions")
    .select("*")
    .eq("conference_id", req.user.conference_id)
    .eq("invitee_email", req.user.email);

  if (submissionsError) {
    console.error("Error fetching submissions:", submissionsError);
  }

  // Fetch all tracks for this conference to get track names
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("track_id, track_name")
    .eq("conference_id", req.user.conference_id);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
  }

  // Create a map of track_id to track_name
  const trackMap = {};
  (tracks || []).forEach(track => {
    trackMap[track.track_id] = track.track_name;
  });

  // Enrich submissions with track names
  const submissionsWithTrackNames = (submissions || []).map(submission => ({
    ...submission,
    track_name: trackMap[submission.track_id] || submission.track_id || 'N/A'
  }));

  res.render("invitee/dashboard.ejs", {
    user: req.user,
    conference: conference || {},
    submissions: submissionsWithTrackNames || [],
    message: req.query.message || null,
  });
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

// Render local auth page (login + register)
app.get('/auth/local', (req, res) => {
  const message = req.query.message || null;
  res.render('local_auth', { message });
});

// -----------------------------
// Author password reset (email link)
// -----------------------------
app.get('/author/forgot-password', (req, res) => {
  const message = req.query.message || null;
  res.render('author/forgot_password', { message });
});

app.post('/author/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Find user by email first (don't restrict by role yet) so we can log role mismatches
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
    if (error || !user) {
      // Don't reveal existence
      console.warn('/author/forgot-password: no user found for', email, error || '');
      return res.json({ success: true });
    }

    // Proceed with password reset for any user matching the email.

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const { data: updateData, error: updateError } = await supabase
      .from('users')
      .update({ password_reset_token: resetToken, password_reset_expires: expiresAt })
      .eq('uid', user.uid);

    if (updateError) {
      console.error('/author/forgot-password: failed to update reset token for', email, updateError);
      // don't reveal too much to client, but include a hint for debugging
      return res.status(500).json({ success: false, error: 'Failed to set reset token' });
    }

    const resetLink = `${APP_URL}/author/reset-password?token=${encodeURIComponent(resetToken)}`;
    const subject = 'DEI CMT - Password reset request';
    const text = `You requested a password reset. Use this link (valid 30 minutes): ${resetLink}`;
    const html = `<p>You requested a password reset. Use this link (valid 30 minutes):</p><p><a href="${resetLink}">${resetLink}</a></p>`;

    try { await sendMail(email, subject, text, html); } catch (mailErr) { console.error('mail err', mailErr); }

    return res.json({ success: true });
  } catch (err) {
    console.error('forgot-password error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

app.get('/author/reset-password', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/?message=' + encodeURIComponent('Invalid or expired reset link'));
  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('password_reset_token', token).single();
    if (error || !user) return res.redirect('/?message=' + encodeURIComponent('Invalid or expired reset link'));
    if (!user.password_reset_expires || new Date(user.password_reset_expires) < new Date()) {
      return res.redirect('/?message=' + encodeURIComponent('Reset link has expired'));
    }
    return res.render('author/reset_password', { token });
  } catch (err) {
    console.error('reset GET error', err);
    return res.redirect('/?message=' + encodeURIComponent('Server error'));
  }
});

app.post('/author/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    const { data: user, error } = await supabase.from('users').select('*').eq('password_reset_token', token).single();
    if (error || !user) return res.status(400).json({ error: 'Invalid or expired token' });
    if (!user.password_reset_expires || new Date(user.password_reset_expires) < new Date()) return res.status(400).json({ error: 'Token expired' });
  // No role restriction: allow resetting password for the matched user

    const password_hash = await bcrypt.hash(password, 10);
    await supabase.from('users').update({ password_hash, password_reset_token: null, password_reset_expires: null }).eq('uid', user.uid);

    const payload = { uid: user.uid, name: user.name, email: user.email, role: user.role || 'author' };
    const jwtToken = jwt.sign(payload, process.env.JWT_SECRET || 'dev_jwt_secret', { expiresIn: '7d' });
    res.cookie('jwt', jwtToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });

    return res.json({ success: true });
  } catch (err) {
    console.error('reset POST error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// Debug endpoint: send a test email (guarded by DEBUG_EMAIL_SECRET).
// Usage: GET /__debug/send-test-email?secret=...&to=you@example.com
app.get('/__debug/send-test-email', async (req, res) => {
  const secret = req.query.secret;
  const allowed = process.env.DEBUG_EMAIL_SECRET || null;
  if (!allowed) return res.status(403).send('Debug email not enabled');
  if (!secret || secret !== allowed) return res.status(401).send('Bad secret');

  const to = req.query.to;
  if (!to) return res.status(400).send('Provide ?to=your@email.com');

  try {
    const subject = 'Test email from ConfEase';
    const text = 'This is a test email to verify mail configuration.';
    const html = '<p>This is a test email to verify mail configuration.</p>';
    const info = await sendMail(to, subject, text, html);
    // include preview url if available
    return res.json({ success: true, info });
  } catch (err) {
    console.error('debug send email error', err);
    return res.status(500).json({ success: false, error: err && err.message ? err.message : String(err) });
  }
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

app.get("/dashboard", ensureAuthenticatedOrToken, async (req, res) => {
  // ensureAuthenticatedOrToken attaches req.user either from session or decoded JWT
  if (!req.user) {
    return res.redirect("/");
  }
  if (req.user.role !== "author") {
    return res.redirect("/?message=You are not authorized to access the author dashboard.");
  }
  const { data:conferencedata, error:conferenceerror } = await supabase.from("conferences").select("*");

  if (conferenceerror && conferenceerror.code !== "PGRST116") {
    console.error(error);
    return res.redirect(
      "/?message=We are facing some issues in connecting to the database. Please try again later."
    );
  }

  // Get all user's submissions (remove .single())
  const { data: trackinfodata, error: trackinfoError } = await supabase
    .from("submissions")
    .select("track_id")
    .or(
      `primary_author.eq.${req.user.email},co_authors.cs.{${req.user.email}}`
    );

  // Get unique track_ids from all submissions
  const trackIds = [...new Set((trackinfodata || []).map((t) => t.track_id).filter(Boolean))];

  // Get presentation data for all tracks (use .in() instead of .eq())
  let presentationdatainfo = [];
  if (trackIds.length > 0) {
    const { data: presentationData, error: presentationError } = await supabase
      .from("conference_tracks")
      .select("*")
      .in("track_id", trackIds);

    if (!presentationError) {
      presentationdatainfo = presentationData || [];
    }
  }

  // Get all user's submission details
  const { data: submissiondata, error: submissionerror } = await supabase
    .from("submissions")
    .select("*")
    .or(
      `primary_author.eq.${req.user.email},co_authors.cs.{${req.user.email}}`
    );

  // Create a map of track_id to track_name for easy lookup
  const trackMap = {};
  if (presentationdatainfo && presentationdatainfo.length > 0) {
    presentationdatainfo.forEach(track => {
      trackMap[track.track_id] = track.track_name;
    });
  }

  // Get all unique email addresses from submissions to fetch user names
  const allEmails = new Set();
  (submissiondata || []).forEach(sub => {
    allEmails.add(sub.primary_author);
    if (Array.isArray(sub.co_authors)) {
      sub.co_authors.forEach(email => allEmails.add(email));
    }
  });

  // Fetch user names for all emails
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("email, name")
    .in("email", Array.from(allEmails));

  // Create email to name mapping
  const emailToNameMap = {};
  (userData || []).forEach(user => {
    emailToNameMap[user.email] = user.name;
  });

  // Helper function to format name and email
  const formatNameEmail = (email) => {
    const name = emailToNameMap[email];
    return name ? `${name} (${email})` : email;
  };

  // Add track_name and formatted author names to each submission
  const submissionsWithTrackNames = (submissiondata || []).map(sub => ({
    ...sub,
    track_name: trackMap[sub.track_id] || 'There was error fetching the track name for this submission.',
    primary_author_formatted: formatNameEmail(sub.primary_author),
    co_authors_formatted: Array.isArray(sub.co_authors) 
      ? sub.co_authors.map(email => formatNameEmail(email)).join(', ')
      : (sub.co_authors ? formatNameEmail(sub.co_authors) : '')
  }));

  // Fetch pending co-author requests for all submissions owned by the current user
  const userSubmissionIds = (submissiondata || [])
    .filter(sub => sub.primary_author === req.user.email)
    .map(sub => sub.submission_id);

  let coAuthorRequests = [];
  if (userSubmissionIds.length > 0) {
    const { data: requests, error: requestsError } = await supabase
      .from("co_author_requests")
      .select("*")
      .in("submission_id", userSubmissionIds);

    if (!requestsError) {
      coAuthorRequests = requests || [];
    }
  }

  // Fetch revised submissions to check if they've been uploaded
  let revisedSubmissions = [];
  if (userSubmissionIds.length > 0) {
    const { data: revisions, error: revisionsError } = await supabase
      .from("revised_submissions")
      .select("submission_id, file_url")
      .in("submission_id", userSubmissionIds);

    if (!revisionsError) {
      revisedSubmissions = revisions || [];
    }
  }

  // Create a map of submission_id to file_url for easy lookup
  const revisedSubmissionsMap = {};
  revisedSubmissions.forEach(rev => {
    revisedSubmissionsMap[rev.submission_id] = rev.file_url;
  });

  // Fetch poster sessions for conferences of poster presentations
  const conferenceIds = [...new Set((submissiondata || [])
    .filter(sub => sub.submission_status === "Accepted for Poster Presentation" || sub.submission_status === "Submitted Final Camera Ready Paper for Poster Presentation")
    .map(sub => sub.conference_id))];

  let posterSessionsMap = {};
  if (conferenceIds.length > 0) {
    const { data: posterSessions, error: posterError } = await supabase
      .from("poster_session")
      .select("*")
      .in("conference_id", conferenceIds);

    if (!posterError && posterSessions) {
      posterSessions.forEach(ps => {
        posterSessionsMap[ps.conference_id] = ps;
      });
    }
  }

  // Create a map of track_id to track details for easy lookup (for oral presentations)
  const trackDetailsMap = {};
  if (presentationdatainfo && presentationdatainfo.length > 0) {
    presentationdatainfo.forEach(track => {
      trackDetailsMap[track.track_id] = track;
    });
  }

  res.render("dashboard.ejs", {
    user: req.user,
    conferences: conferencedata || [],
    userSubmissions: submissionsWithTrackNames,
    presentationdata: presentationdatainfo || [],
    currentDate: new Date().toISOString().split("T")[0],
    message: req.query.message || null,
    trackinfodata,
    coAuthorRequests: coAuthorRequests || [],
    revisedSubmissionsMap: revisedSubmissionsMap || {},
    posterSessionsMap: posterSessionsMap || {},
    trackDetailsMap: trackDetailsMap || {},
  });
});

app.post("/publish/review-results", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { conference_id } = req.body;
  
  console.log("Received conference_id:", conference_id);
  console.log("Type of conference_id:", typeof conference_id);
  console.log("Full req.body:", req.body);

  if (!conference_id) {
    return res.status(400).send("Invalid or missing conference_id.");
  }

  // Use the conference_id as is (it's a UUID string, not a number)
  const confId = conference_id;

  const { data: reviewdata, error: reviewdataError } = await supabase
    .from("peer_review")
    .select("*")
    .eq("conference_id", confId);

  if (reviewdataError) {
    console.error("Error fetching tracks:", reviewdataError);
    return res.status(500).send("Error.");
  }

  // Get conference title for email
  const { data: conferenceData, error: conferenceError } = await supabase
    .from("conferences")
    .select("title")
    .eq("conference_id", confId)
    .single();

  const conferenceTitle = conferenceData?.title || "Conference";

  for (const data of reviewdata) {
    const { error: updateError } = await supabase
      .from("submissions")
      .update({ submission_status: data.acceptance_status , })
      .eq("submission_id", data.submission_id);

    if (updateError) {
      console.error(`Error updating track ${data.submission_id}:`, updateError);
      return res.status(500).send(`Error updating track ${data.submission_id}.`);
    }

    // Get submission details for email notification
    const { data: submissionData, error: submissionError } = await supabase
      .from("submissions")
      .select("*")
      .eq("submission_id", data.submission_id)
      .single();

    if (submissionData) {
      // Send email to primary author with co-authors in CC
      try {
        const coAuthorEmails = Array.isArray(submissionData.co_authors) ? submissionData.co_authors : [];
        const ccEmails = coAuthorEmails.length > 0 ? coAuthorEmails.join(',') : null;
        
        const isAccepted = data.acceptance_status.includes("Accepted");
        const statusMessage = isAccepted ? 
          "We are pleased to inform you that your paper has been accepted!" :
          "We regret to inform you that your paper has not been accepted.";
        
        await sendMail(
          submissionData.primary_author,
          `${data.acceptance_status} - ${submissionData.title}`,
          `Your paper "${submissionData.title}" submitted to ${conferenceTitle} has been ${data.acceptance_status.toLowerCase()}.`,
          `<p>Dear Author,</p>
           <p>${statusMessage}</p>
           <p><strong>Paper Title:</strong> ${submissionData.title}</p>
           <p><strong>Conference:</strong> ${conferenceTitle}</p>
           <p><strong>Decision:</strong> ${data.acceptance_status}</p>
           <p><strong>Review Score:</strong> ${data.mean_score.toFixed(2)}/5</p>
           ${isAccepted ? 
             "<p>Please prepare your final camera-ready paper for publication.</p>" : 
             "<p>Thank you for your submission. We encourage you to consider submitting to future conferences.</p>"
           }
           <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
           <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`,
          ccEmails
        );
      } catch (emailError) {
        console.error(`Error sending result notification email for ${data.submission_id}:`, emailError);
      }
    }
  }

  res.redirect(
    "/chair/dashboard?message=Review results have been successfully published."
  );
});

app.get("/reviewer/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "reviewer") {
    return res.redirect("/");
  }

  // Fetch tracks assigned to this reviewer first
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .contains("track_reviewers", [req.user.email]);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
    return res.status(500).send("Error fetching tracks.");
  }

  // Get conference information for tracks
  const conferenceIds = [...new Set((tracks || []).map(track => track.conference_id))];
  let conferences = [];
  if (conferenceIds.length > 0) {
    const { data: conferenceData, error: conferenceError } = await supabase
      .from("conferences")
      .select("*")
      .in("conference_id", conferenceIds);

    if (!conferenceError) {
      conferences = conferenceData || [];
    }
  }

  // Create conference map for easy lookup
  const conferenceMap = {};
  conferences.forEach(conf => {
    conferenceMap[conf.conference_id] = conf;
  });

  // Add conference info to tracks
  const tracksWithConferences = (tracks || []).map(track => ({
    ...track,
    conference: conferenceMap[track.conference_id] || {}
  }));

  // Get track IDs for this reviewer
  const trackIds = (tracks || []).map(track => track.track_id);

  // Fetch submissions for these tracks using track_id
  let userSubmissions = [];
  if (trackIds.length > 0) {
    const { data: submissions, error: submissionsError } = await supabase
      .from("submissions")
      .select("*")
      .in("track_id", trackIds);

    if (submissionsError) {
      console.error("Error fetching submissions:", submissionsError);
      return res.status(500).send("Error fetching submissions.");
    }

    userSubmissions = submissions || [];
  }

  // Fetch revised submissions for these tracks
  let revisedSubmissions = [];
  if (trackIds.length > 0) {
    const { data: revisions, error: revisionsError } = await supabase
      .from("submissions")
      .select("*")
      .in("track_id", trackIds)
      .eq("submission_status", "Submitted Revised Paper");

    if (!revisionsError) {
      revisedSubmissions = revisions || [];
    }
  }

  res.render("reviewer/dashboard.ejs", {
    user: req.user,
    userSubmissions: userSubmissions,
    revisedSubmissions: revisedSubmissions,
    tracks: tracksWithConferences || [],
  });
});
app.get("/chair/dashboard/edit-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  // Fetch the track (optional, for display)
  const { data: track, error: trackError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("track_id", req.params.id)
    .single();

  if (trackError) {
    console.error("Error fetching data:", trackError);
    return res.status(500).send("Error fetching sessions.");
  }

  res.render("chair/edit-sessions.ejs", {
    user: req.user,
    trackid: req.params.id,
    track: track || {},
    message: req.query.message || null,
  });
});
app.get("/chair/dashboard/manage-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  // Fetch tracks for this conference
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("conference_id", req.params.id);

  // Fetch conference details
  const { data: conference, error: conferenceError } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  // Fetch only final-camera-ready submissions for this conference
  const { data: submissions, error: submissionsError } = await supabase
    .from("submissions")
    .select("*")
    .eq("conference_id", req.params.id)
    .in("submission_status", ["Submitted Final Camera Ready Paper", "Presentation Completed"]);

  // Count submissions per track (track_id)
  const trackCounts = {};
  (submissions || []).forEach((sub) => {
    trackCounts[sub.track_id] = (trackCounts[sub.track_id] || 0) + 1;
  });

  // Convert to array for EJS - include track names for display
  const count = tracks.map(track => ({
    track_id: track.track_id,
    track_name: track.track_name,
    count: trackCounts[track.track_id] || 0,
  }));

  // Fetch reviewer scores and panelist scores for all submissions
  const tracksWithLeaderboard = await Promise.all((tracks || []).map(async (track) => {
    const trackSubmissions = (submissions || []).filter(sub => sub.track_id === track.track_id);
    
    const leaderboard = await Promise.all(trackSubmissions.map(async (submission) => {
      // Get reviewer score from peer_review table
      const { data: reviewData, error: reviewError } = await supabase
        .from("peer_review")
        .select("mean_score")
        .eq("submission_id", submission.submission_id);

      let reviewerScore = null;
      if (reviewData && reviewData.length > 0) {
        reviewerScore = reviewData.reduce((sum, review) => sum + (review.mean_score || 0), 0) / reviewData.length;
      }

      // Get panelist score from final_camera_ready_submissions table
      const { data: panelistData, error: panelistError } = await supabase
        .from("final_camera_ready_submissions")
        .select("panelist_score")
        .eq("submission_id", submission.submission_id)
        .single();

      const panelistScore = panelistData?.panelist_score || null;

      // Calculate average score
      let averageScore = null;
      if (reviewerScore !== null && panelistScore !== null) {
        averageScore = (reviewerScore + panelistScore) / 2;
      } else if (reviewerScore !== null) {
        averageScore = reviewerScore;
      } else if (panelistScore !== null) {
        averageScore = panelistScore;
      }

      // Get author names
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("email, name")
        .in("email", [submission.primary_author, ...(submission.co_authors || [])]);

      const emailToNameMap = {};
      (userData || []).forEach(user => {
        emailToNameMap[user.email] = user.name;
      });

      const formatNameEmail = (email) => {
        const name = emailToNameMap[email];
        return name ? `${name} (${email})` : email;
      };

      return {
        ...submission,
        reviewerScore: reviewerScore ? parseFloat(reviewerScore.toFixed(2)) : null,
        panelistScore: panelistScore ? parseFloat(panelistScore.toFixed(2)) : null,
        averageScore: averageScore ? parseFloat(averageScore.toFixed(2)) : null,
        primary_author_formatted: formatNameEmail(submission.primary_author),
        co_authors_formatted: Array.isArray(submission.co_authors) 
          ? submission.co_authors.map(email => formatNameEmail(email)).join(', ')
          : (submission.co_authors ? formatNameEmail(submission.co_authors) : 'None')
      };
    }));

    // Sort by average score (highest first) and assign ranks
    const sortedLeaderboard = leaderboard
      .filter(item => item.averageScore !== null)
      .sort((a, b) => b.averageScore - a.averageScore)
      .map((item, index) => ({ ...item, rank: index + 1 }));

    // Add unranked submissions (those without scores)
    const unrankedSubmissions = leaderboard
      .filter(item => item.averageScore === null)
      .map(item => ({ ...item, rank: null }));

    return {
      ...track,
      leaderboard: [...sortedLeaderboard, ...unrankedSubmissions]
    };
  }));

  if (tracksError || conferenceError || submissionsError) {
    console.error(
      "Error fetching data:",
      tracksError || conferenceError || submissionsError
    );
    return res.status(500).send("Error fetching data.");
  }

  res.render("chair/manage-sessions.ejs", {
    user: req.user,
    tracks: tracksWithLeaderboard || [],
    conference: conference || {},
    count: count || [],
    message: req.query.message || null,
  });
});

app.get("/chair/dashboard/manage-poster-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  // Fetch conference details
  const { data: conference, error: conferenceError } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  if (conferenceError || !conference) {
    console.error("Error fetching conference:", conferenceError);
    return res.status(500).send("Error fetching conference details.");
  }

  // Fetch poster session details from poster_session table
  const { data: posterSession, error: posterSessionError } = await supabase
    .from("poster_session")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  if (posterSessionError && posterSessionError.code !== 'PGRST116') {
    console.error("Error fetching poster session:", posterSessionError);
  }

  // Fetch submissions with status "Submitted Final Camera Ready Paper for Poster Presentation"
  const { data: posterSubmissions, error: submissionsError } = await supabase
    .from("submissions")
    .select("*")
    .eq("conference_id", req.params.id)
    .eq("submission_status", "Submitted Final Camera Ready Paper for Poster Presentation");

  if (submissionsError) {
    console.error("Error fetching submissions:", submissionsError);
    return res.status(500).send("Error fetching submissions.");
  }

  // Get author names for all submissions
  const allEmails = new Set();
  (posterSubmissions || []).forEach(sub => {
    allEmails.add(sub.primary_author);
    if (Array.isArray(sub.co_authors)) {
      sub.co_authors.forEach(email => allEmails.add(email));
    }
  });

  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("email, name")
    .in("email", Array.from(allEmails));

  const emailToNameMap = {};
  (userData || []).forEach(user => {
    emailToNameMap[user.email] = user.name;
  });

  const formatNameEmail = (email) => {
    const name = emailToNameMap[email];
    return name ? `${name} (${email})` : email;
  };

  // Add formatted author names to each submission
  const posterSubmissionsFormatted = (posterSubmissions || []).map(sub => ({
    ...sub,
    primary_author_formatted: formatNameEmail(sub.primary_author),
    co_authors_formatted: Array.isArray(sub.co_authors) 
      ? sub.co_authors.map(email => formatNameEmail(email)).join(', ')
      : (sub.co_authors ? formatNameEmail(sub.co_authors) : 'None')
  }));

  res.render("chair/manage-poster-sessions.ejs", {
    user: req.user,
    conference: conference || {},
    posterSession: posterSession || {},
    submissions: posterSubmissionsFormatted || [],
    message: req.query.message || null,
  });
});

app.post("/chair/dashboard/set-poster-session/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { session_date, start_time, end_time, conference_id } = req.body;

  // Update poster_session table with session details
  const { error } = await supabase
    .from("poster_session")
    .update({
      date: session_date,
      start_time: start_time,
      end_time: end_time,
    })
    .eq("conference_id", conference_id);

  if (error) {
    console.error("Error updating poster session:", error);
    return res.redirect(`/chair/dashboard/manage-poster-sessions/${conference_id}?message=Error setting poster session.`);
  }

  res.redirect(
    `/chair/dashboard/manage-poster-sessions/${conference_id}?message=Poster session details saved successfully.`
  );
});

app.post("/chair/dashboard/set-session/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { session_date, start_time, end_time, panelists } = req.body;
  const trackId = req.params.id;
  const otp = Math.floor(100000 + Math.random() * 900000);

  // Insert the session details into the sessions table
  const { error } = await supabase
    .from("conference_tracks")
    .update({
      presentation_date: session_date,
      presentation_start_time: start_time,
      presentation_end_time: end_time,
      panelists: panelists
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e), // Convert to array
      status: "Scheduled",
    })
    .eq("track_id", trackId);

  if (error) {
    console.error("Error inserting session:", error);
    return res.status(500).send("Error setting up the session.");
  }

  res.redirect(
    `/chair/dashboard/manage-sessions/${req.body.conference_id || ""}`
  );
});

app.get("/panelist/active-session/:id", async (req, res) => {
  const { data: trackinfo, error: trackError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("track_id", req.params.id)
    .single();

  if (trackError || !trackinfo) {
    return res.redirect("/panelist/dashboard?message=Track not found.");
  }

  // Enforce session access window: allow page only from (presentation_start_time - 5 minutes) to presentation_end_time
  let session_end_iso = null;
  try {
    if (trackinfo.presentation_date && trackinfo.presentation_start_time && trackinfo.presentation_end_time) {
      const istOffset = 5.5 * 60 * 60 * 1000; // ms
      const [y, mo, d] = ('' + trackinfo.presentation_date).split('-').map(Number);
      const [sh, sm] = ('' + trackinfo.presentation_start_time).split(':').map(Number);
      const [eh, em] = ('' + trackinfo.presentation_end_time).split(':').map(Number);

      const startUtcMs = Date.UTC(y, mo - 1, d, sh, sm) - istOffset;
      const endUtcMs = Date.UTC(y, mo - 1, d, eh, em) - istOffset;
      const nowUtcMs = Date.now();
      const bufferMs = 5 * 60 * 1000; // 5 minutes

      if (nowUtcMs < (startUtcMs - bufferMs)) {
        return res.redirect('/?message=Session not started yet.');
      }

      if (nowUtcMs > endUtcMs) {
        return res.redirect('/?message=Session has ended.');
      }

      session_end_iso = new Date(endUtcMs).toISOString();
    }
  } catch (timeErr) {
    console.error('Error checking session window:', timeErr);
    // If an error occurs, allow access (fail-open) but don't provide a timer
    session_end_iso = null;
  }

  // Fetch submissions by track_id instead of area
  // Fetch submissions with status "Submitted Final Camera Ready Paper for Oral Presentation"
  const { data: session, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("track_id", trackinfo.track_id)
    .eq("submission_status", "Submitted Final Camera Ready Paper for Oral Presentation");

  if (error) {
    console.error("Error fetching session:", error);
    return res.status(500).send("Error fetching session details.");
  }

  // Fetch mean_score for each submission from peer_review table and panelist scores
  if (session && session.length > 0) {
    for (let i = 0; i < session.length; i++) {
      // Fetch reviewer mean_score
      const { data: reviewData, error: reviewError } = await supabase
        .from("peer_review")
        .select("mean_score")
        .eq("submission_id", session[i].submission_id);

      if (reviewError) {
        console.error("Error fetching review data:", reviewError);
        session[i].mean_score = null;
      } else if (reviewData && reviewData.length > 0) {
        // Calculate average if multiple reviews exist
        const avgScore = reviewData.reduce((sum, review) => sum + (review.mean_score || 0), 0) / reviewData.length;
        session[i].mean_score = avgScore.toFixed(2);
      } else {
        session[i].mean_score = null;
      }

      // Fetch panelist score from final_camera_ready_submissions table
      const { data: finalSubmission, error: finalError } = await supabase
        .from("final_camera_ready_submissions")
        .select("panelist_score, status")
        .eq("submission_id", session[i].submission_id)
        .single();

      if (!finalError && finalSubmission) {
        session[i].panelist_score = finalSubmission.panelist_score || null;
        session[i].presentation_status = finalSubmission.status || null;
      } else {
        session[i].panelist_score = null;
        session[i].presentation_status = null;
      }
    }
  }

  res.render("panelist/active-session.ejs", {
    session: session,
    trackinfo: trackinfo,
    message: req.query.message || null,
    session_end_iso: session_end_iso,
  });
});


app.post("/start-session", async (req, res) => {
  const { session_code } = req.body;
  

  
  

  // Rest of your existing code...
  const { data: track, error: trackError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("session_code", session_code)
    .single();

  if (trackError || !track) {
    return res.redirect("/panelist/dashboard?message=Invalid session code.");
  }

  // Continue with time validation...
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
      const { error: updateError } = await supabase
        .from("conference_tracks")
        .update({
          status: "In Progress",
         
          session_code: null
        })
        .eq("track_id", track.track_id);

      if (updateError) {
        console.error("Error updating track:", updateError);
        return res.redirect("/panelist/dashboard?message=Error starting session.");
      }

      return res.redirect(`/panelist/dashboard/active-session/${track.track_id}`);
    }
  } else {
    return res.redirect("/panelist/dashboard?message=Session date mismatch.");
  }
});
app.get("/reviewer/dashboard/review/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  // 1. Fetch the submission data
  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .select("*")
    .eq("paper_code", req.params.id)
    .single();

  // 2. IMMEDIATELY check for an error or if no data was found
  if (submissionError) {
    console.error("Error fetching submission:", submissionError);
    return res.render("error.ejs", {
      message: "An error occurred while fetching the submission.",
    });
  }

  if (!submissionData) {
    return res.render("error.ejs", {
      message: "The submission you are trying to view does not exist.",
    });
  }

  // 3. NOW it is safe to use submissionData
  if (submissionData.submission_status === "Reviewed") {
    return res.render("error.ejs", {
      message: "This submission has already been reviewed.",
    });
  }

  // 4. Fetch the related data
  const { data: conferencedata, error: conferenceerror } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", submissionData.conference_id)
    .single();

  const { data: trackdata, error: trackerror } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("track_id", submissionData.track_id)
    .single();
  
  // // 5. Check if the related data was found
  // if (conferenceerror || trackerror || !conferencedata || !trackdata) {
  //    return res.render("error.ejs", {
  //     message: "Could not find the associated conference or track for this submission.",
  //   });
  // }

  // 6. Only render the page if all data is valid and present
  res.render("reviewer/review", {
    user: req.user,
    userSubmissions: submissionData,
    conferencedata,
    trackdata,
    message: req.query.message || null,
  });
});

app.get("/reviewer/dashboard/re-review/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  // 1. Fetch the submission data by paper_code
  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .select("*")
    .eq("paper_code", req.params.id)
    .single();

  // 2. IMMEDIATELY check for an error or if no data was found
  if (submissionError) {
    console.error("Error fetching submission:", submissionError);
    return res.render("error.ejs", {
      message: "An error occurred while fetching the submission.",
    });
  }

  if (!submissionData) {
    return res.render("error.ejs", {
      message: "The submission you are trying to view does not exist.",
    });
  }

  // 3. Check if submission status is "Submitted Revised Paper"
  if (submissionData.submission_status !== "Submitted Revised Paper") {
    return res.render("error.ejs", {
      message: "This submission does not have a revised paper to review.",
    });
  }

  // 4. Fetch the related data
  const { data: conferencedata, error: conferenceerror } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", submissionData.conference_id)
    .single();

  const { data: trackdata, error: trackerror } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("track_id", submissionData.track_id)
    .single();

  // 5. Only render the page if all data is valid and present
  res.render("reviewer/re-review", {
    user: req.user,
    userSubmissions: submissionData,
    conferencedata,
    trackdata,
    message: req.query.message || null,
  });
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

  // Get submission details for email notification
  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .select("*")
    .eq("submission_id", submission_id)
    .single();

  if (submissionError || !submissionData) {
    console.error("Error fetching submission:", submissionError);
    return res.redirect("/reviewer/dashboard?message=Error fetching submission details.");
  }

  const mean_score = (parseFloat(originality_score) + parseFloat(relevance_score) + parseFloat(technical_quality_score) + parseFloat(clarity_score) + parseFloat(impact_score)) / 5;

  // Update the revised_submissions table with re-review data
  const { error: updateRevisionError } = await supabase
    .from("revised_submissions")
    .update({
      review_status: "Re-Reviewed",
      originality_score: parseFloat(originality_score),
      relevance_score: parseFloat(relevance_score),
      technical_quality_score: parseFloat(technical_quality_score),
      clarity_score: parseFloat(clarity_score),
      impact_score: parseFloat(impact_score),
      mean_score: mean_score,
      acceptance_status: status,
    })
    .eq("submission_id", submission_id);

  if (updateRevisionError) {
    console.error("Error updating revised_submissions:", updateRevisionError);
    return res.redirect("/reviewer/dashboard?message=Error saving re-review data.");
  }



  const { error: updateSubmissionError } = await supabase
    .from("submissions")
    .update({ submission_status: status })
    .eq("submission_id", submission_id);

  if (updateSubmissionError) {
    console.error("Error updating submission status:", updateSubmissionError);
    return res.redirect("/reviewer/dashboard?message=Error updating submission status.");
  }

  // Send email notification to primary author and co-authors about re-review completion
  try {
    const { data: conferenceData, error: confError } = await supabase
      .from("conferences")
      .select("acceptance_notification, title")
      .eq("conference_id", conference_id)
      .single();

    const acceptanceDate = conferenceData?.acceptance_notification 
      ? new Date(conferenceData.acceptance_notification).toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })
      : 'the scheduled acceptance notification date';

    const conferenceTitle = conferenceData?.title || 'the conference';

    const coAuthorEmails = Array.isArray(submissionData.co_authors) ? submissionData.co_authors : [];
    const ccEmails = coAuthorEmails.length > 0 ? coAuthorEmails.join(',') : null;
    
    await sendMail(
      submissionData.primary_author,
      `Re-review Completed - ${submissionData.title}`,
      `Dear Author, your revised paper "${submissionData.title}" has been re-reviewed. Results will be published on ${acceptanceDate}.`,
      `<p>Dear Author,</p>
       <p>Your revised paper titled <strong>"${submissionData.title}"</strong> has been re-reviewed by one of our reviewers.</p>
       <p>The re-review process is now complete. The final results and acceptance decisions will be published on <strong>${acceptanceDate}</strong>.</p>
       <p>Please stay tuned for the official announcement from ${conferenceTitle}.</p>
       <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
       <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`,
      ccEmails
    );
  } catch (emailError) {
    console.error("Error sending re-review notification email:", emailError);
    // Don't fail the re-review process if email fails
  }

  return res.redirect("/reviewer/dashboard?message=Revised paper review submitted successfully.");
});

app.post("/chair/dashboard/manage-sessions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const conferenceId = req.params.id;

  // Fetch all tracks for this conference to get their indexes and IDs
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("conference_id", conferenceId);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
    return res.status(500).send("Error fetching tracks.");
  }

  // For each track, update its session details
  for (let idx = 0; idx < tracks.length; idx++) {
    const track = tracks[idx];
    const session_date = req.body[`session_date_${idx}`];
    const session_start_time = req.body[`session_start_time_${idx}`];
    const session_end_time = req.body[`session_end_time_${idx}`];
    const session_panelists = req.body[`session_panelists_${idx}`]
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e); // removes empty strings
    const { error: updateError } = await supabase.from("conference_tracks").update({
      track_name: track.track_name,
      presentation_date: session_date,
      presentation_start_time: session_start_time,
      presentation_end_time: session_end_time,
      panelists: session_panelists,
      status: "Scheduled",
    }).eq("track_id", track.track_id);

    if (updateError) {
      console.error(`Error updating track ${track.track_name}:`, updateError);
      return res
        .status(500)
        .send(`Error updating session for track ${track.track_name}.`);
    }

    // Send email notifications to panelists
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
           <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
           <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
        );
      } catch (emailError) {
        console.error(`Error sending panelist notification email to ${panelistEmail}:`, emailError);
      }
    }
  }

  res.redirect(`/chair/dashboard`);
});

app.get("/chair/dashboard/invited-talks/:id",async(req,res)=>{
  
   if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  // Fetch conference details
  const { data: conferenceData, error: conferenceError } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  if (conferenceError || !conferenceData) {
    console.error("Error fetching conference:", conferenceError);
    return res.status(500).send("Error fetching conference details.");
  }

  // Fetch invitees for this conference
  const { data: inviteesData, error: inviteesError } = await supabase
    .from("invitees")
    .select("*")
    .eq("conference_id", req.params.id);

  if (inviteesError) {
    console.error("Error fetching invitees:", inviteesError);
    return res.status(500).send("Error fetching invitees.");
  }

  // Process invitees: check if name column is populated to determine login status
  const inviteesWithStatus = (inviteesData || []).map((invitee) => {
    const hasLoggedIn = invitee.name && invitee.name.trim() !== '';
    
    return {
      ...invitee,
      display_name: hasLoggedIn ? invitee.name : invitee.email,
      display_email: invitee.email,
      hasLoggedIn: hasLoggedIn
    };
  });

  // Fetch submissions for each invitee from invited_talk_submissions table
  const inviteesWithSubmissions = await Promise.all(inviteesWithStatus.map(async (invitee) => {
    const { data: submissions, error: submissionsError } = await supabase
      .from("invited_talk_submissions")
      .select("*")
      .eq("conference_id", req.params.id)
      .eq("invitee_email", invitee.email);

    if (submissionsError) {
      console.error(`Error fetching submissions for ${invitee.email}:`, submissionsError);
    }

    return {
      ...invitee,
      submissions: submissions || []
    };
  }));

  // Fetch all tracks for this conference to get track names
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("track_id, track_name")
    .eq("conference_id", req.params.id);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
  }

  // Create a map of track_id to track_name
  const trackMap = {};
  (tracks || []).forEach(track => {
    trackMap[track.track_id] = track.track_name;
  });

  // Enrich all submissions with track names
  const inviteesWithEnrichedSubmissions = inviteesWithSubmissions.map(invitee => ({
    ...invitee,
    submissions: (invitee.submissions || []).map(submission => ({
      ...submission,
      track_name: trackMap[submission.track_id] || submission.track_id || 'N/A'
    }))
  }));

  res.render("chair/invited-talks", {
    user: req.user,
    conference: conferenceData,
    invitees: inviteesWithEnrichedSubmissions || [],
    message: req.query.message || null,
  });
})

app.get("/privacy-policy",async(req,res)=>{
  res.render("privacy-policy");
})
app.post("/add-invitee", async(req,res)=>{
   if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const email = req.body.email;
  const conferenceId = req.body.conference_id;

  if (!email || !conferenceId) {
    return res.status(400).send("Email and conference ID are required.");
  }

  const {data, error} = await supabase.from("invitees").insert({
    conference_id: conferenceId,
    email: email
  });

  if (error) {
    console.error("Error adding invitee:", error);
    return res.redirect(`/chair/dashboard/invited-talks/${conferenceId}?message=Error adding invitee.`);
  }

  // Send email notification to invitee
  try {
    const { data: conferenceData, error: confError } = await supabase
      .from("conferences")
      .select("title")
      .eq("conference_id", conferenceId)
      .single();

    const conferenceTitle = conferenceData?.title || "the conference";

    await sendMail(
      email,
      `Invited to Present at ${conferenceTitle}`,
      `You have been invited to present at ${conferenceTitle}.`,
      `<p>Dear Invitee,</p>
       <p>You have been invited to present at <strong>${conferenceTitle}</strong>.</p>
       <p>Please log in to your invitee dashboard using this email address: <strong>${email}</strong> to submit your presentation.</p>
       <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
       <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
    );
  } catch (emailError) {
    console.error("Error sending invitee notification email:", emailError);
    // Don't fail the invitee addition if email fails
  }

  res.redirect(`/chair/dashboard/invited-talks/${conferenceId}?message=Invitee added successfully.`);
})
app.post("/mark-as-reviewed", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const {
    submission_id, // This is actually paper_code (UUID string)
    conference_id,
    status,
    originality_score,
    relevance_score,
    technical_quality_score,
    clarity_score,
    impact_score,
    remarks,
  } = req.body;

  // // First, get the submission to retrieve the UUID submission_id
  // const { data: submissionData, error: submissionError } = await supabase
  //   .from("submissions")
  //   .select("*") // Get the UUID primary key
  //   .eq("submission_id", submission_id)
  //   .single();

  // if (submissionError) {
  //   console.error("Error fetching submission:", submissionError);
  //   console.error("Paper code searched:", paper_id);
    
  //   // If no rows found, it means paper_code doesn't exist
  //   if (submissionError.code === 'PGRST116') {
  //     return res.render("error.ejs", {
  //       message: "Submission not found with the provided paper code. Please verify the paper code is correct.",
  //     });
  //   }
    
  //   return res.render("error.ejs", {
  //     message: "Database error while fetching submission.",
  //   });
  // }

  // if (!submissionData) {
  //   return res.render("error.ejs", {
  //     message: "Submission data is empty.",
  //   });
  // }

  // Check if this reviewer has already reviewed this submission
  const { data: existingReview, error: checkError } = await supabase
    .from("peer_review")
    .select("*")
    .eq("submission_id", submission_id)
    .eq("reviewer", req.user.email)
    .single();

  if (checkError && checkError.code !== 'PGRST116') {
    console.error("Error checking existing review:", checkError);
    return res.redirect("/reviewer/dashboard?message=Error checking review status.");
  }

  if (existingReview) {
    return res.redirect("/reviewer/dashboard?message=You have already reviewed this submission.");
  }

  // Get submission details for email notification
  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .select("*")
    .eq("submission_id", submission_id)
    .single();

  if (submissionError || !submissionData) {
    console.error("Error fetching submission:", submissionError);
    return res.redirect("/reviewer/dashboard?message=Error fetching submission details.");
  }

  const mean_score = (parseFloat(originality_score) + parseFloat(relevance_score) + parseFloat(technical_quality_score) + parseFloat(clarity_score) + parseFloat(impact_score)) / 5;
  const { data, error } = await supabase.from("peer_review").insert({
    conference_id: conference_id,
    submission_id: submission_id, // Use the correct UUID
    review_status: "Reviewed",
    remarks: remarks,
    originality_score: parseFloat(originality_score),
    relevance_score: parseFloat(relevance_score),
    technical_quality_score: parseFloat(technical_quality_score),
    clarity_score: parseFloat(clarity_score),
    impact_score: parseFloat(impact_score),
    mean_score: mean_score,
    reviewer: req.user.email,
    acceptance_status: status,
  });

  // Update the submission using paper_code
  const { error: updateError } = await supabase
    .from("submissions")
    .update({ submission_status: "Reviewed" })
    .eq("submission_id", submission_id);

  if (error || updateError){
    console.error("Error updating submission:", error || updateError);
    return res.redirect("/reviewer/dashboard?message=We are facing some issues in marking this submission as reviewed.");
  }

  // If status is "Revision Required", insert into revised_submissions table
  if (status === "Revision Required") {
    const { error: revisionError } = await supabase
      .from("revised_submissions")
      .insert({
        submission_id: submission_id
      });

    if (revisionError) {
      console.error("Error inserting into revised_submissions:", revisionError);
      // Don't fail the review process if this insert fails
    } else {
      console.log("Successfully inserted submission into revised_submissions table");
    }
  }

  // Send email notification to primary author and co-authors about review completion
  try {
    // Fetch conference details to get acceptance notification date
    const { data: conferenceData, error: confError } = await supabase
      .from("conferences")
      .select("acceptance_notification, title")
      .eq("conference_id", conference_id)
      .single();

    const acceptanceDate = conferenceData?.acceptance_notification 
      ? new Date(conferenceData.acceptance_notification).toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })
      : 'the scheduled acceptance notification date';

    const conferenceTitle = conferenceData?.title || 'the conference';

    const coAuthorEmails = Array.isArray(submissionData.co_authors) ? submissionData.co_authors : [];
    const ccEmails = coAuthorEmails.length > 0 ? coAuthorEmails.join(',') : null;
    
    await sendMail(
      submissionData.primary_author,
      `Review Completed - ${submissionData.title}`,
      `Dear Author, your paper "${submissionData.title}" has been reviewed. Results will be published on ${acceptanceDate}.`,
      `<p>Dear Author,</p>
       <p>Your paper titled <strong>"${submissionData.title}"</strong> has been reviewed by one of our reviewers.</p>
       <p>The review process is now complete. The final results and acceptance decisions will be published on <strong>${acceptanceDate}</strong>.</p>
       <p>Please stay tuned for the official announcement from ${conferenceTitle}.</p>
       <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
       <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`,
      ccEmails
    );
  } catch (emailError) {
    console.error("Error sending review notification email:", emailError);
    // Don't fail the review process if email fails
  }

  // Fetch tracks assigned to this reviewer first
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .contains("track_reviewers", [req.user.email]);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
    return res.render("error.ejs", {
      message: "We are facing some issues in fetching tracks.",
    });
  }

  // Get conference information for tracks
  const conferenceIds = [...new Set((tracks || []).map(track => track.conference_id))];
  let conferences = [];
  if (conferenceIds.length > 0) {
    const { data: conferenceData, error: conferenceError } = await supabase
      .from("conferences")
      .select("*")
      .in("conference_id", conferenceIds);

    if (!conferenceError) {
      conferences = conferenceData || [];
    }
  }

  // Create conference map for easy lookup
  const conferenceMap = {};
  conferences.forEach(conf => {
    conferenceMap[conf.conference_id] = conf;
  });

  // Add conference info to tracks
  const tracksWithConferences = (tracks || []).map(track => ({
    ...track,
    conference: conferenceMap[track.conference_id] || {}
  }));

  // Get track IDs for this reviewer
  const trackIds = (tracks || []).map(track => track.track_id);

  // Fetch submissions for these tracks using track_id
  let userSubmissions = [];
  if (trackIds.length > 0) {
    const { data: submissions, error: submissionsError } = await supabase
      .from("submissions")
      .select("*")
      .in("track_id", trackIds);

    if (submissionsError) {
      console.error("Error fetching submissions:", submissionsError);
      return res.render("error.ejs", {
        message: "We are facing some issues in fetching the submissions.",
      });
    }

    userSubmissions = submissions || [];
  }

  res.render("reviewer/dashboard.ejs", {
    user: req.user,
    userSubmissions: userSubmissions,
    revisedSubmissions: [],
    tracks: tracksWithConferences || [],
    message: "Submission has been successfully marked as reviewed.",
  });
});

app.post("/mark-presentation-as-complete", async (req, res) => {
  const { paper_id, panelist_score, track_id } = req.body;
  
  // Validate required fields
  if (!paper_id || !track_id) {
    return res.render("error.ejs", {
      message: "Missing required fields: paper_id or track_id",  
    });
  }

  // Convert and validate panelist_score
  const scoreValue = panelist_score ? Number(panelist_score) : null;
  if (panelist_score && isNaN(scoreValue)) {
    return res.render("error.ejs", {
      message: "Invalid panelist score provided",  
    });
  }

  // Validate paper_id (UUID format)
  if (!paper_id || typeof paper_id !== 'string' || paper_id.trim() === '') {
    return res.render("error.ejs", {
      message: "Invalid paper ID provided",  
    });
  }

  // Update submissions table
  const { data, error } = await supabase
    .from("submissions")
    .update({ submission_status: "Presentation Completed" })
    .eq("submission_id", paper_id);

  // Update final_camera_ready_submissions table
  const { data: finalpresentation, error: finalpresentationerror } = await supabase
    .from("final_camera_ready_submissions")
    .update({ panelist_score: scoreValue,status:"Completed" }) // Remove quotes around column name
    .eq("submission_id", paper_id);
    
  if (error || finalpresentationerror) {
    console.error("Error updating submission:", error || finalpresentationerror);
    return res.render("error.ejs", {
      message: "We are facing some issues in marking this submission as completed.",  
    });
  }

  // Redirect to active session with success message
  res.redirect(`/panelist/active-session/${track_id}?message=Submission has been successfully marked as completed.`);
});



app.get("/chair/dashboard/delete-conference/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { error } = await supabase
    .from("conferences")
    .delete()
    .eq("conference_id", req.params.id);

  await supabase
    .from("conference_tracks")
    .delete()
    .eq("conference_id", req.params.id);

  if (error) {
    console.error("Error deleting conference:", error);
    return res.status(500).send("Error deleting conference.");
  }

  res.redirect("/chair/dashboard");
});

app.get("/submission/co-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const { data, error } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

 

  if (error) {
    console.error("Error fetching conference:", error);
    return res.status(500).send("Error fetching conference.");
  }
  if (!data) {
    return res.status(404).send("Conference not found.");
  }

  res.render("submission2.ejs", {
    user: req.user,
    conferences: data,
    submission: null,
    message: req.query.message || null,
  });
});

app.post("/join", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const { paper_code, id } = req.body;

  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("paper_code", paper_code)
    .eq("conference_id", id)
    .single();

  if (error) {
    return res.redirect(
      "/dashboard?message=Invalid Paper Code. Please try again."
    );
  }

  if (!data) {
    return res.redirect(
      "/dashboard?message=Submission not found. Please try again."
    );
  }

  // Check if submission status allows joining as co-author
  if (data.submission_status !== "Submitted for Review") {
    return res.redirect(
      `/dashboard?message=Cannot join this paper as co-author. Current status: ${data.submission_status}. Co-authors can only join papers with 'Submitted' status.`
    );
  }

  let coAuthors = data.co_authors || [];
  
  if (data.primary_author === req.user.email) {
    return res.redirect(
      "/dashboard?message=You are the primary author of this paper. You cannot join as a co-author."
    );
  } else if (coAuthors.includes(req.user.email)) {
    return res.redirect(
      "/dashboard?message=You are already a co-author of this paper"
    );
  }

  // Check if a request already exists for this user and submission
  const { data: existingRequest, error: checkError } = await supabase
    .from("co_author_requests")
    .select("*")
    .eq("submission_id", data.submission_id)
    .eq("co_author", req.user.email)
    .single();

  if (existingRequest) {
    return res.redirect(
      "/dashboard?message=You have already sent a request to join this paper."
    );
  }

  // Insert into co_author_requests table
  const { error: insertError } = await supabase
    .from("co_author_requests")
    .insert({
      conference_id: id,
      submission_id: data.submission_id,
      co_author: req.user.email,
      status: "Submitted For Review"
    });

  if (insertError) {
    console.error("Error creating co-author request:", insertError);
    return res.status(500).send("Error sending co-author request.");
  }

  // Send email notification to primary author about co-author request
  try {
    await sendMail(
      data.primary_author,
      `Co-Author Request - ${data.title}`,
      `A co-author request for your paper "${data.title}" has been submitted.`,
      `<p>Dear Author,</p>
       <p>A co-author has requested to join your paper titled <strong>"${data.title}"</strong>.</p>
       <p><strong>Co-Author Email:</strong> ${req.user.email}</p>
       <p>Please review and accept or reject this request from your dashboard.</p>
       <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
       <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
    );
  } catch (emailError) {
    console.error("Error sending co-author request notification email:", emailError);
    // Don't fail the request process if email fails
  }

  res.redirect("/dashboard?message=Co-author request submitted successfully.");
});

app.post("/co-author-request/accept/:request_id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const requestId = req.params.request_id;

  // Fetch the co-author request
  const { data: coAuthorRequest, error: fetchError } = await supabase
    .from("co_author_requests")
    .select("*")
    .eq("request_id", requestId)
    .single();

  if (fetchError || !coAuthorRequest) {
    console.error("Error fetching co-author request:", fetchError);
    return res.redirect("/dashboard?message=Co-author request not found.");
  }

  // Verify the current user is the primary author of the submission
  const { data: submission, error: subError } = await supabase
    .from("submissions")
    .select("*")
    .eq("submission_id", coAuthorRequest.submission_id)
    .single();

  if (subError || !submission) {
    console.error("Error fetching submission:", subError);
    return res.redirect("/dashboard?message=Submission not found.");
  }

  if (submission.primary_author !== req.user.email) {
    return res.redirect("/dashboard?message=You are not authorized to accept this request.");
  }

  // Add co-author email to submissions table
  let coAuthors = submission.co_authors || [];
  
  // Ensure coAuthors is an array
  if (!Array.isArray(coAuthors)) {
    coAuthors = [];
  }
  
  // Add the co-author email if not already present
  if (!coAuthors.includes(coAuthorRequest.co_author)) {
    coAuthors.push(coAuthorRequest.co_author);
  }

  console.log("Updated co-authors array:", coAuthors);

  // Update submission with new co-author
  const { error: updateError } = await supabase
    .from("submissions")
    .update({ co_authors: coAuthors })
    .eq("submission_id", coAuthorRequest.submission_id);

  if (updateError) {
    console.error("Error updating submission:", updateError);
    return res.redirect("/dashboard?message=Error accepting co-author request.");
  }

  console.log("Successfully updated submission with co-author");

  // Update co_author_requests status to Accepted
  const { error: requestUpdateError } = await supabase
    .from("co_author_requests")
    .update({ status: "Accepted" })
    .eq("request_id", requestId);

  if (requestUpdateError) {
    console.error("Error updating co-author request:", requestUpdateError);
    return res.redirect("/dashboard?message=Error updating request status.");
  }

  console.log("Successfully updated co-author request status to Accepted");

  // Send email notification to co-author about acceptance
  try {
    await sendMail(
      coAuthorRequest.co_author,
      `Co-Author Request Accepted - ${submission.title}`,
      `Your co-author request for "${submission.title}" has been accepted.`,
      `<p>Dear Co-Author,</p>
       <p>Your request to join the paper titled <strong>"${submission.title}"</strong> has been <strong>accepted</strong>.</p>
       <p>You are now listed as a co-author on this submission. You can view the paper details in your dashboard.</p>
       <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
       <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
    );
  } catch (emailError) {
    console.error("Error sending acceptance email:", emailError);
  }

  res.redirect("/dashboard?message=Co-author request accepted successfully.");
});

// app.post("/sync-co-author-requests", async (req, res) => {
//   if (!req.isAuthenticated() || req.user.role !== "author") {
//     return res.redirect("/");
//   }

//   try {
//     // Fetch all accepted co-author requests for submissions owned by this user
//     const { data: acceptedRequests, error: requestsError } = await supabase
//       .from("co_author_requests")
//       .select("*")
//       .eq("status", "Accepted");

//     if (requestsError) {
//       console.error("Error fetching accepted requests:", requestsError);
//       return res.redirect("/dashboard?message=Error syncing co-author requests.");
//     }

//     let syncedCount = 0;

//     // For each accepted request, ensure the co-author is in the submissions table
//     for (const request of acceptedRequests || []) {
//       // Fetch the submission
//       const { data: submission, error: subError } = await supabase
//         .from("submissions")
//         .select("*")
//         .eq("submission_id", request.submission_id)
//         .single();

//       if (subError || !submission) {
//         console.error(`Error fetching submission ${request.submission_id}:`, subError);
//         continue;
//       }

//       // Check if co-author is already in the array
//       let coAuthors = submission.co_authors || [];
//       if (!Array.isArray(coAuthors)) {
//         coAuthors = [];
//       }

//       if (!coAuthors.includes(request.co_author)) {
//         coAuthors.push(request.co_author);

//         // Update submission
//         const { error: updateError } = await supabase
//           .from("submissions")
//           .update({ co_authors: coAuthors })
//           .eq("submission_id", request.submission_id);

//         if (updateError) {
//           console.error(`Error updating submission ${request.submission_id}:`, updateError);
//         } else {
//           syncedCount++;
//           console.log(`Synced co-author ${request.co_author_email} to submission ${request.submission_id}`);
//         }
//       }
//     }

//     res.redirect(`/dashboard?message=Sync complete. Updated ${syncedCount} co-author(s).`);
//   } catch (error) {
//     console.error("Error in sync-co-author-requests:", error);
//     res.redirect("/dashboard?message=Error syncing co-author requests.");
//   }
// });

app.post("/co-author-request/reject/:request_id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const requestId = req.params.request_id;

  // Fetch the co-author request
  const { data: coAuthorRequest, error: fetchError } = await supabase
    .from("co_author_requests")
    .select("*")
    .eq("request_id", requestId)
    .single();

  if (fetchError || !coAuthorRequest) {
    console.error("Error fetching co-author request:", fetchError);
    return res.redirect("/dashboard?message=Co-author request not found.");
  }

  // Verify the current user is the primary author of the submission
  const { data: submission, error: subError } = await supabase
    .from("submissions")
    .select("*")
    .eq("submission_id", coAuthorRequest.submission_id)
    .single();

  if (subError || !submission) {
    console.error("Error fetching submission:", subError);
    return res.redirect("/dashboard?message=Submission not found.");
  }

  if (submission.primary_author !== req.user.email) {
    return res.redirect("/dashboard?message=You are not authorized to reject this request.");
  }

  // Update co_author_requests status to Rejected
  const { error: requestUpdateError } = await supabase
    .from("co_author_requests")
    .update({ status: "Rejected" })
    .eq("request_id", requestId);

  if (requestUpdateError) {
    console.error("Error updating co-author request:", requestUpdateError);
    return res.redirect("/dashboard?message=Error rejecting co-author request.");
  }

  // Send email notification to co-author about rejection
  try {
    await sendMail(
      coAuthorRequest.co_author,
      `Co-Author Request Rejected - ${submission.title}`,
      `Your co-author request for "${submission.title}" has been rejected.`,
      `<p>Dear Co-Author,</p>
       <p>Your request to join the paper titled <strong>"${submission.title}"</strong> has been <strong>rejected</strong>.</p>
       <p>If you believe this was a mistake, please contact the paper's primary author.</p>
       <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
       <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
    );
  } catch (emailError) {
    console.error("Error sending rejection email:", emailError);
  }

  res.redirect("/dashboard?message=Co-author request rejected successfully.");
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

  // 1. Insert the conference
  const { data: confData, error: confError } = await supabase
    .from("conferences")
    .insert([
      {
        title,
        description,
        conference_start_date,
        conference_end_date,
        full_paper_submission,
        acceptance_notification,
        camera_ready_paper_submission,
      },
    ]).select().single();

  if (confError) {
    console.error("Error inserting conference:", confError);
    return res.status(500).send("Error creating conference.");
  }

  // 2. Create poster_session row for this conference
  const { error: posterError } = await supabase
    .from("poster_session")
    .insert({
      conference_id: confData.conference_id,
      date: null,
      start_time: null,
      end_time: null,
    });

  if (posterError) {
    console.error("Error creating poster session:", posterError);
    // Don't fail the conference creation, just log the error
  }

  // 3. Collect tracks from req.body
  const tracks = [];
  let i = 1;
  while (req.body[`track_title_${i}`] && req.body[`track_reviewer_${i}`]) {
    tracks.push({
      conference_id: confData.conference_id,
      track_name: req.body[`track_title_${i}`],
      track_reviewers: [req.body[`track_reviewer_${i}`]], // store as array
    });
    i++;
  }

  // 4. Insert tracks into conference_tracks table
  if (tracks.length > 0) {
    const { error: tracksError } = await supabase
      .from("conference_tracks")
      .insert(tracks);
    if (tracksError) {
      console.error("Error inserting tracks:", tracksError);
      return res.status(500).send("Error creating tracks.");
    }

    // Send email notifications to reviewers
    for (const track of tracks) {
      for (const reviewerEmail of track.track_reviewers) {
        try {
          await sendMail(
            reviewerEmail,
            `Reviewer Assignment - ${title}`,
            `You have been assigned as a reviewer for the track "${track.track_name}" in the conference "${title}". Please log in using this email address (${reviewerEmail}).`,
            `<p>Dear Reviewer,</p>
             <p>You have been assigned as a reviewer for the following:</p>
             <p><strong>Conference:</strong> ${title}</p>
             <p><strong>Track:</strong> ${track.track_name}</p>
             <p><strong>Conference Dates:</strong> ${conference_start_date} to ${conference_end_date}</p>
             <p><strong>Login Instructions:</strong> Please log in to the reviewer dashboard using this email address: <strong>${reviewerEmail}</strong></p>
             <p>You can access the reviewer panel to view submissions and begin your reviews.</p>
             <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
             <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
          );
        } catch (emailError) {
          console.error(`Error sending reviewer notification email to ${reviewerEmail}:`, emailError);
        }
      }
    }
  }

  res.redirect("/chair/dashboard");
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

  // Fetch conference
  const { data: conference, error } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  if (error) {
    console.error("Error fetching conference:", error);
    return res.status(500).send("Error fetching conference.");
  }

  // Fetch tracks for this conference
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("conference_id", req.params.id);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
    return res.status(500).send("Error fetching tracks.");
  }

  res.render("submission.ejs", {
    user: req.user,
    conferences: conference,
    tracks: tracks || [],
    message: req.query.message || null,
  });
});

app.get("/submission/invited-talk/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  // Fetch conference
  const { data: conference, error } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  if (error) {
    console.error("Error fetching conference:", error);
    return res.status(500).send("Error fetching conference.");
  }

  // Fetch tracks for this conference
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("conference_id", req.params.id);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
    return res.status(500).send("Error fetching tracks.");
  }

  res.render("invitee/submission.ejs", {
    user: req.user,
    conferences: conference,
    tracks: tracks || [],
    message: req.query.message || null,
  });
});

app.get("/submission/edit/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  try {
    // Fetch the submission first
    const { data: submission, error: submissionError } = await supabase
      .from("submissions")
      .select("*")
      .eq("submission_id", req.params.id)
      .single();

    if (submissionError || !submission) {
      console.error("Error fetching submission:", submissionError);
      return res.redirect("/dashboard?message=Submission not found.");
    }

    // Security check - ensure user can edit this submission
    if (submission.primary_author !== req.user.email) {
      const coAuthors = submission.co_authors || [];
      if (!coAuthors.includes(req.user.email)) {
        return res.redirect("/dashboard?message=You can only edit your own submissions.");
      }
    }

    // Only allow editing when submission status is "Submitted for Review"
    if (submission.submission_status !== "Submitted for Review") {
      return res.redirect("/dashboard?message=Papers can only be edited when status is 'Submitted for Review'. Current status: " + submission.submission_status);
    }

    // Fetch tracks using the conference_id from the submission
    const { data: tracks, error: tracksError } = await supabase
      .from("conference_tracks")
      .select("*") // Only select needed fields
      .eq("conference_id", submission.conference_id)
      .order("track_name"); // Order alphabetically 

    if (tracksError) {
      console.error("Error fetching tracks:", tracksError);
      // Continue without tracks data rather than failing completely
    }

    // Debug logging
    console.log("Submission data:", {
      submission_id: submission.submission_id,
      track_id: submission.track_id,
      track_id_type: typeof submission.track_id
    });
    console.log("Tracks data:", tracks?.map(t => ({
      track_id: t.track_id,
      track_name: t.track_name,
      track_id_type: typeof t.track_id
    })));

    res.render("submission3.ejs", { 
        user: req.user, 
      submission: submission, 
      tracks: tracks || [],
      message: req.query.message || null,
    });

  } catch (error) {
    console.error("Error in edit submission route:", error);
    res.redirect("/dashboard?message=An unexpected error occurred.");
  }
});

app.get("/submission/revised/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  try {
    // Fetch the submission first
    const { data: submission, error: submissionError } = await supabase
      .from("submissions")
      .select("*")
      .eq("submission_id", req.params.id)
      .single();

    if (submissionError || !submission) {
      console.error("Error fetching submission:", submissionError);
      return res.redirect("/dashboard?message=Submission not found.");
    }

    // Security check - ensure user is the primary author
    if (submission.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=Only the primary author can submit revised papers.");
    }

    // Only allow revision submission when status is "Revision Required"
    if (submission.submission_status !== "Revision Required") {
      return res.redirect("/dashboard?message=Revised papers can only be submitted for papers with 'Revision Required' status. Current status: " + submission.submission_status);
    }

    // Fetch tracks using the conference_id from the submission
    const { data: tracks, error: tracksError } = await supabase
      .from("conference_tracks")
      .select("*")
      .eq("conference_id", submission.conference_id)
      .order("track_name");

    if (tracksError) {
      console.error("Error fetching tracks:", tracksError);
    }

    // Fetch reviewer remarks and scores from peer_review table
    const { data: reviewerData, error: reviewError } = await supabase
      .from("peer_review")
      .select("*")
      .eq("submission_id", req.params.id);

    if (reviewError) {
      console.error("Error fetching reviewer remarks:", reviewError);
    }

    res.render("submission5.ejs", { 
      user: req.user, 
      submission: submission, 
      tracks: tracks || [],
      reviewerData: reviewerData || [],
      message: req.query.message || null,
    });

  } catch (error) {
    console.error("Error in revised submission route:", error);
    res.redirect("/dashboard?message=An unexpected error occurred.");
  }
});

app.get(
  "/submission/final-camera-ready/primary-author/:id",
  async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.redirect("/");
    }

    const { data, error } = await supabase
      .from("submissions")
      .select("*")
      .eq("submission_id", req.params.id)
      .single();

    if (error || !data) {
      return res.redirect("/dashboard?message=Submission not found.");
    }

    // Fetch track information
    let trackName = 'Unknown Track';
    if (data.track_id) {
      const { data: trackData, error: trackError } = await supabase
        .from("conference_tracks")
        .select("track_name")
        .eq("track_id", data.track_id)
        .single();

      if (!trackError && trackData) {
        trackName = trackData.track_name;
      }
    }

    // Fetch reviewer remarks from peer_review table
    const { data: reviewerRemarks, error: reviewError } = await supabase
      .from("peer_review")
      .select("*")
      .eq("submission_id", req.params.id);

    if (reviewError) {
      console.error("Error fetching reviewer remarks:", reviewError);
    }

    // Fetch revised submission data if it exists
    let revisedSubmissionData = null;
    const { data: revisedData, error: revisedError } = await supabase
      .from("revised_submissions")
      .select("*")
      .eq("submission_id", req.params.id)
      .single();

    if (revisedError && revisedError.code !== 'PGRST116') {
      console.error("Error fetching revised submission:", revisedError);
    }

    if (revisedData) {
      revisedSubmissionData = revisedData;
      console.log("Revised submission data found:", revisedSubmissionData);
    } else {
      console.log("No revised submission data for submission_id:", req.params.id);
    }

    // Fetch conference to check camera-ready deadline
    const { data: conferenceInfo, error: confInfoError } = await supabase
      .from('conferences')
      .select('camera_ready_paper_submission')
      .eq('conference_id', data.conference_id)
      .single();

    if (confInfoError) console.error('Error fetching conference info:', confInfoError);

    // Check camera ready deadline (IST date comparison)
    if (conferenceInfo && conferenceInfo.camera_ready_paper_submission) {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(now.getTime() + istOffset);
      const currentDate = istTime.toISOString().split('T')[0];
      const deadline = (new Date(conferenceInfo.camera_ready_paper_submission)).toISOString().split('T')[0];

      if (currentDate > deadline) {
        return res.redirect('/dashboard?message=The camera-ready submission deadline has passed.');
      }
    }

    if (data.submission_status == "Submitted for Review") {
      return res.redirect(
        "/dashboard?message=Your submission is under review."
      );
    } else if (data.submission_status == "Rejected") {
      return res.redirect(
        "/dashboard?message=Your submission has been rejected."
      );
    } else if (data.submission_status == "Submitted Final Camera Ready Paper") {
      return res.redirect(
        "/dashboard?message=You have already submitted the final camera ready paper for this submission."
      );
    } else {
      res.render("submission4.ejs", { 
        user: req.user, 
        submission: { ...data, track_name: trackName },
        reviewerRemarks: reviewerRemarks || [],
        revisedSubmissionData: revisedSubmissionData || null,
        message: req.query.message || null,
      });
    }
  }
);

app.post(
  "/final-camera-ready-submission",
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE' 
          ? 'File size exceeds 4MB limit. Please upload a smaller file.'
          : err.message;
        return res.redirect(`/dashboard?message=Error: ${message}`);
      }

      // If no error, proceed with the actual handler
      (async () => {
        if (!req.isAuthenticated()) {
          return res.redirect("/");
        }

        // Check if file was uploaded
        if (!req.file) {
          return res.redirect("/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.");
        }

        const { confid, title, abstract, areas, id, co_authors } = req.body;

        // Verify camera-ready deadline for the conference
        try {
          const { data: confRow, error: confErr } = await supabase
            .from('conferences')
            .select('camera_ready_paper_submission')
            .eq('conference_id', confid)
            .single();

          if (!confErr && confRow && confRow.camera_ready_paper_submission) {
            const now = new Date();
            const istOffset = 5.5 * 60 * 60 * 1000;
            const istTime = new Date(now.getTime() + istOffset);
            const currentDate = istTime.toISOString().split('T')[0];
            const deadline = (new Date(confRow.camera_ready_paper_submission)).toISOString().split('T')[0];

            if (currentDate > deadline) {
              return res.redirect('/dashboard?message=The camera-ready submission deadline has passed.');
            }
          }
        } catch (err) {
          console.error('Error checking camera-ready deadline:', err);
          // proceed cautiously (allow submission) or you may choose to block; we'll allow fallback
        }
        const filePath = req.file.path;
        const uploadResult = await cloudinary.uploader.upload(filePath, {
          resource_type: "auto", // auto-detect type (pdf, docx, etc.)
          folder: "submissions",
          public_id: `${req.user.name}-${Date.now()}-Final`,
        });

        const { data, error } = await supabase
          .from("final_camera_ready_submissions")
          .insert({
            conference_id: confid,
            submission_id: id,
            primary_author: req.user.name,
            title: title,
            abstract: abstract,
            track_id: areas, // Use track_id instead of area
            co_authors: co_authors,
            file_url: uploadResult.secure_url,
          });

        if (error) {
          console.error("Error inserting submission:", error);
          return res.status(500).send("Error submitting your proposal.");
        } else {
          // Fetch the submission to check if it's for oral or poster presentation
          const { data: submissionData, error: fetchError } = await supabase
            .from("submissions")
            .select("submission_status")
            .eq("submission_id", id)
            .single();

          let newStatus = "Submitted Final Camera Ready Paper";
          
          if (!fetchError && submissionData) {
            if (submissionData.submission_status === "Accepted for Poster Presentation") {
              newStatus = "Submitted Final Camera Ready Paper for Poster Presentation";
            } else if (submissionData.submission_status === "Accepted for Oral Presentation") {
              newStatus = "Submitted Final Camera Ready Paper for Oral Presentation";
            }
          }

          await supabase
            .from("submissions")
            .update({
              submission_status: newStatus,
              file_url: uploadResult.secure_url,
            })
            .eq("submission_id", id);
          res.redirect("/dashboard");
        }
      })().catch(next);
    });
  }
);

app.get("/login" , async (req,res)=>{
  res.render("login.ejs", {
    message: req.query.message || null
  });
});

app.get("/chair/dashboard", async (req, res) => {

  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }
  const { data, error } = await supabase.from("conferences").select("*");

  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.send("Database error!");
  }

    const message = req.query.message || null;


  res.render("chair/dashboard.ejs", {
    user: req.user,
    conferences: data || [],
    message: message,
  });
});

app.get("/chair/dashboard/edit-conference/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { data: conference, error } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  if (error) {
    console.error("Error fetching conference:", error);
    return res.status(500).send("Error fetching conference.");
  }

  // Fetch tracks for this conference
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("conference_id", req.params.id);

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
    return res.status(500).send("Error fetching tracks.");
  }

  res.render("chair/edit-conference.ejs", {
    user: req.user,
    conference,
    tracks: tracks || [],
    message: req.query.message || null,
  });
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

  // 1. Update conference details
  const { error: confError } = await supabase
    .from("conferences")
    .update({
      title,
      description,
      conference_start_date,
      conference_end_date,
      full_paper_submission,
      acceptance_notification,
      camera_ready_paper_submission,
    })
    .eq("conference_id", conferenceId);

  if (confError) {
    console.error("Error updating conference:", confError);
    return res.status(500).send("Error updating conference.");
  }

  // 2. Get existing tracks for this conference
  const { data: existingTracks, error: fetchError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("conference_id", conferenceId);

  if (fetchError) {
    console.error("Error fetching existing tracks:", fetchError);
    return res.status(500).send("Error fetching existing tracks.");
  }

  // 3. Collect new tracks from form
  const newTracks = [];
  let i = 1;
  while (req.body[`track_title_${i}`] && req.body[`track_reviewer_${i}`]) {
    newTracks.push({
      track_name: req.body[`track_title_${i}`],
      track_reviewers: [req.body[`track_reviewer_${i}`]],
      index: i - 1 // to match with existing tracks by position
    });
    i++;
  }

  // 4. Update existing tracks (preserve presentation data)
  for (let idx = 0; idx < Math.min(existingTracks.length, newTracks.length); idx++) {
    const existingTrack = existingTracks[idx];
    const newTrack = newTracks[idx];

    const { error: updateError } = await supabase
      .from("conference_tracks")
      .update({
        track_name: newTrack.track_name,
        track_reviewers: newTrack.track_reviewers,
        // Keep existing presentation data
        // presentation_date, presentation_start_time, presentation_end_time, panelists will remain unchanged
      })
      .eq("track_id", existingTrack.track_id);

    if (updateError) {
      console.error(`Error updating track ${existingTrack.track_id}:`, updateError);
      return res.status(500).send(`Error updating track ${existingTrack.track_name}.`);
    }

    // Check if reviewer has changed and send notification
    const oldReviewers = existingTrack.track_reviewers || [];
    const newReviewers = newTrack.track_reviewers || [];
    
    // Find newly added reviewers
    const addedReviewers = newReviewers.filter(reviewer => !oldReviewers.includes(reviewer));
    
    // Send emails to newly added reviewers
    for (const reviewerEmail of addedReviewers) {
      try {
        // Get conference details for the email
        const { data: conferenceInfo, error: confInfoError } = await supabase
          .from("conferences")
          .select("title")
          .eq("conference_id", conferenceId)
          .single();

        const conferenceName = conferenceInfo?.title || 'Conference';

        await sendMail(
          reviewerEmail,
          `Reviewer Assignment - ${conferenceName}`,
          `You have been assigned as a reviewer for the track "${newTrack.track_name}" in "${conferenceName}". Please log in using this email address (${reviewerEmail}).`,
          `<p>Dear Reviewer,</p>
           <p>You have been assigned as a reviewer for the following:</p>
           <p><strong>Conference:</strong> ${conferenceName}</p>
           <p><strong>Track:</strong> ${newTrack.track_name}</p>
           <p><strong>Login Instructions:</strong> Please log in to the reviewer dashboard using this email address: <strong>${reviewerEmail}</strong></p>
           <p>You can access the reviewer panel to view submissions and begin your reviews.</p>
           <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
           <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
        );
      } catch (emailError) {
        console.error(`Error sending reviewer notification email to ${reviewerEmail}:`, emailError);
      }
    }
  }

  // 5. If there are more new tracks than existing ones, insert the additional ones
  if (newTracks.length > existingTracks.length) {
    const tracksToInsert = newTracks.slice(existingTracks.length).map(track => ({
      conference_id: conferenceId,
      track_name: track.track_name,
      track_reviewers: track.track_reviewers,
      // New tracks will have null presentation data initially
    }));

    const { error: insertError } = await supabase
      .from("conference_tracks")
      .insert(tracksToInsert);

    if (insertError) {
      console.error("Error inserting new tracks:", insertError);
      return res.status(500).send("Error inserting new tracks.");
    }

    // Send email notifications to reviewers of new tracks
    for (const track of tracksToInsert) {
      for (const reviewerEmail of track.track_reviewers) {
        try {
          // Get conference details for the email
          const { data: conferenceInfo, error: confInfoError } = await supabase
            .from("conferences")
            .select("title")
            .eq("conference_id", conferenceId)
            .single();

          const conferenceName = conferenceInfo?.title || 'Conference';

          await sendMail(
            reviewerEmail,
            `New Reviewer Assignment - ${conferenceName}`,
            `You have been assigned as a reviewer for the new track "${track.track_name}" in "${conferenceName}". Please log in using this email address (${reviewerEmail}).`,
            `<p>Dear Reviewer,</p>
             <p>You have been assigned as a reviewer for the following new track:</p>
             <p><strong>Conference:</strong> ${conferenceName}</p>
             <p><strong>Track:</strong> ${track.track_name}</p>
             <p><strong>Login Instructions:</strong> Please log in to the reviewer dashboard using this email address: <strong>${reviewerEmail}</strong></p>
             <p>You can access the reviewer panel to view submissions and begin your reviews.</p>
             <p>In case of any technical assistance, please feel free to reach out to us at <strong>multimedia@dei.ac.in</strong> or contact us at <strong>+91 9875691340</strong>.</p>
             <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`
          );
        } catch (emailError) {
          console.error(`Error sending new reviewer notification email to ${reviewerEmail}:`, emailError);
        }
      }
    }
  }

  // 6. If there are fewer new tracks than existing ones, delete the extra ones
  if (newTracks.length < existingTracks.length) {
    const tracksToDelete = existingTracks.slice(newTracks.length);
    const trackIdsToDelete = tracksToDelete.map(track => track.track_id);

    const { error: deleteError } = await supabase
      .from("conference_tracks")
      .delete()
      .in("track_id", trackIdsToDelete);

    if (deleteError) {
      console.error("Error deleting extra tracks:", deleteError);
      return res.status(500).send("Error deleting extra tracks.");
    }
  }

  res.redirect("/chair/dashboard");
});
app.get("/chair/dashboard/view-submissions/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  // Fetch submissions separately
  const { data: submissions, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("conference_id", req.params.id);

  // Fetch tracks for this conference
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("conference_id", req.params.id);

  const { data: confdata, error: conferror } = await supabase
    .from("conferences")
    .select("*")
    .eq("conference_id", req.params.id)
    .single();

  if (error || conferror || tracksError) {
    console.error("Error fetching data:", error || conferror || tracksError);
    return res.status(500).send("Error fetching data.");
  }

  // Create a map of track_id to track_name for easy lookup
  const trackMap = {};
  (tracks || []).forEach(track => {
    trackMap[track.track_id] = track.track_name;
  });

  // Get all unique email addresses from submissions to fetch user names
  const allEmails = new Set();
  (submissions || []).forEach(sub => {
    allEmails.add(sub.primary_author);
    if (Array.isArray(sub.co_authors)) {
      sub.co_authors.forEach(email => allEmails.add(email));
    }
  });

  // Fetch user names for all emails
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("email, name")
    .in("email", Array.from(allEmails));

  // Create email to name mapping
  const emailToNameMap = {};
  (userData || []).forEach(user => {
    emailToNameMap[user.email] = user.name;
  });

  // Helper function to format name and email
  const formatNameEmail = (email) => {
    const name = emailToNameMap[email];
    return name ? `${name} (${email})` : email;
  };

  // Add track names and formatted author names to submissions
  const submissionsWithTracks = (submissions || []).map(sub => ({
    ...sub,
    track_name: trackMap[sub.track_id] || 'Unknown Track',
    primary_author_formatted: formatNameEmail(sub.primary_author),
    co_authors_formatted: Array.isArray(sub.co_authors) 
      ? sub.co_authors.map(email => formatNameEmail(email)).join(', ')
      : (sub.co_authors ? formatNameEmail(sub.co_authors) : 'None')
  }));

  // For each submission, fetch the latest peer_review (if any) and add reviewer details
  for (let i = 0; i < submissionsWithTracks.length; i++) {
    const s = submissionsWithTracks[i];
    try {
      const { data: reviewRows, error: reviewError } = await supabase
        .from('peer_review')
        .select('reviewer, mean_score, remarks')
        .eq('submission_id', s.submission_id)
        .limit(1);

      if (!reviewError && reviewRows && reviewRows.length > 0) {
        const r = reviewRows[0];
        s.reviewer = r.reviewer || null;
        s.mean_score = (r.mean_score !== undefined && r.mean_score !== null) ? parseFloat(r.mean_score).toFixed(2) : null;
        s.remarks = r.remarks || null;

        // Try to fetch reviewer's display name from users table
        if (s.reviewer) {
          const { data: reviewerUser, error: userErr } = await supabase
            .from('users')
            .select('name')
            .eq('email', s.reviewer)
            .single();
          if (!userErr && reviewerUser) {
            s.reviewer_name = reviewerUser.name;
          }
        }
      } else {
        s.reviewer = null;
        s.mean_score = null;
        s.remarks = null;
      }
    } catch (err) {
      console.error('Error fetching reviewer data for submission', s.submission_id, err);
      s.reviewer = null;
      s.mean_score = null;
      s.remarks = null;
    }
  }

  // Get unique statuses for filter dropdown
  const uniqueStatuses = [...new Set((submissions || []).map(sub => sub.submission_status))];

  res.render("chair/view-submissions.ejs", {
    user: req.user,
    submissions: submissionsWithTracks,
    tracks: tracks || [],
    uniqueStatuses: uniqueStatuses,
    conferencedata: req.params.id,
    confdata: confdata || {},
    message: req.query.message || null,
  });
});

// Route to delete a specific submission (accessible by chair)
app.post('/chair/dashboard/delete-submission/:id', async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== 'chair') {
    return res.redirect('/');
  }

  const submissionId = req.params.id;
  const conferenceId = req.query.conference_id || req.body.conference_id;

  try {
    // Delete related peer reviews
    await supabase.from('peer_review').delete().eq('submission_id', submissionId);

    // Delete any final camera ready submissions if present
    await supabase.from('final_camera_ready_submissions').delete().eq('submission_id', submissionId);

    // Finally delete the submission itself
    const { error } = await supabase.from('submissions').delete().eq('submission_id', submissionId);
    if (error) {
      console.error('Error deleting submission:', error);
      return res.redirect(`/chair/dashboard/view-submissions/${conferenceId}?message=Error deleting submission.`);
    }

    return res.redirect(`/chair/dashboard/view-submissions/${conferenceId}?message=Submission deleted successfully.`);
  } catch (err) {
    console.error('Unexpected error deleting submission:', err);
    return res.redirect(`/chair/dashboard/view-submissions/${conferenceId}?message=Error deleting submission.`);
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
    
    // If no error, proceed with the actual handler
    (async () => {
      if (!req.isAuthenticated()) {
        return res.redirect("/");
      }

      const { submission_id } = req.body;

      if (!req.file) {
        return res.redirect(`/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.`);
      }

      try {
        // Fetch the submission to verify it's in "Revision Required" status
        const { data: submission, error: submissionError } = await supabase
          .from("submissions")
          .select("*")
          .eq("submission_id", submission_id)
          .single();

        if (submissionError || !submission) {
          console.error("Error fetching submission:", submissionError);
          return res.redirect("/dashboard?message=Submission not found.");
        }

        // Security check - ensure user is the primary author
        if (submission.primary_author !== req.user.email) {
          return res.redirect("/dashboard?message=Only the primary author can submit revised papers.");
        }

        // Verify submission is in "Revision Required" status
        if (submission.submission_status !== "Revision Required") {
          return res.redirect("/dashboard?message=This submission is not waiting for revisions.");
        }

        // Upload file to Cloudinary
        const filePath = req.file.path;
        const uploadResult = await cloudinary.uploader.upload(filePath, {
          resource_type: "auto",
          folder: "revised_submissions",
          public_id: `${req.user.name}-${submission_id}-${Date.now()}`,
        });

        // Update the revised_submissions table with the file URL
        const { error: updateError } = await supabase
          .from("revised_submissions")
          .update({ file_url: uploadResult.secure_url })
          .eq("submission_id", submission_id);

        if (updateError) {
          console.error("Error updating revised submission:", updateError);
          return res.redirect("/dashboard?message=Error uploading revised paper.");
        }

        // Update the submissions table status to "Submitted Revised Paper" AND update file_url
        const { error: statusUpdateError } = await supabase
          .from("submissions")
          .update({ 
            submission_status: "Submitted Revised Paper",
            file_url: uploadResult.secure_url
          })
          .eq("submission_id", submission_id);

        if (statusUpdateError) {
          console.error("Error updating submission status:", statusUpdateError);
          return res.redirect("/dashboard?message=Error updating submission status.");
        }

        // Clean up uploaded file
        try {
          await fs.unlink(filePath);
        } catch (cleanupError) {
          console.error("Error cleaning up file:", cleanupError);
        }

        res.redirect("/dashboard?message=Revised paper submitted successfully for re-review!");

      } catch (error) {
        console.error("Error in submit revised paper:", error);
        res.redirect("/dashboard?message=Error uploading revised paper.");
      }
    })().catch(next);
  });
});

app.post("/edit-submission", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' 
        ? 'File size exceeds 4MB limit. Please upload a smaller file.'
        : err.message;
      return res.redirect(`/dashboard?message=Error: ${message}`);
    }
    
    // If no error, proceed with the actual handler
    (async () => {
      if (!req.isAuthenticated()) {
        return res.redirect("/");
      }

      let { title, abstract, areas, id } = req.body;
      
      // Debug logging
      console.log("Form data received:", {
        title,
        abstract,
        areas,
        areas_type: typeof areas,
        id
      });
      
      // Ensure areas is a string and not empty
      if (typeof areas !== 'string') areas = String(areas);

      try {
        // Prepare the update data
        const updateData = {
          title: title,
          abstract: abstract
        };
        if (areas && areas.trim() !== "" && areas !== "undefined") {
          updateData.track_id = areas;
          console.log("Setting track_id to:", areas);
        } else {
          console.log("Areas is empty, undefined, or invalid:", areas);
        }

        if (req.file) {
          const filePath = req.file.path;
          const uploadResult = await cloudinary.uploader.upload(filePath, {
            resource_type: "auto",
            folder: "submissions",
            public_id: `${req.user.name}-${Date.now()}`,
          });

          // Update file-related fields only if new file was uploaded
          updateData.file_url = uploadResult.secure_url;

          // Clean up uploaded file
          try {
            await fs.unlink(filePath);
          } catch (cleanupError) {
            console.error("Error cleaning up file:", cleanupError);
          }
        }

        // Update the submission
        const { data, error } = await supabase
          .from("submissions")
          .update(updateData)
          .eq("submission_id", id);

        if (error) {
          console.error("Error updating submission:", error);
          return res.redirect("/dashboard?message=Error updating submission.");
        }

        res.redirect("/dashboard?message=Submission updated successfully!");

      } catch (error) {
        console.error("Error in edit submission:", error);
        res.redirect("/dashboard?message=Error updating submission.");
      }
    })().catch(next);
  });
});

app.get("/submission/delete/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const { data, error } = await supabase
    .from("submissions")
    .delete()
    .eq("submission_id", req.params.id);
  res.redirect("/dashboard?message=Submission deleted Succesfully!");
});

app.get("/submission/delete/invitee/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "invitee") {
    return res.redirect("/");
  }
  const { data, error } = await supabase
    .from("invited_talk_submissions")
    .delete()
    .eq("paper_id", req.params.id);
  res.redirect("/invitee/dashboard?message=Submission deleted successfully!");
});

app.post("/submit", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' 
        ? 'File size exceeds 4MB limit. Please upload a smaller file.'
        : err.message;
      return res.redirect(`/dashboard?message=Error: ${message}`);
    }
    
    // If no error, proceed with the actual handler
    (async () => {
      if (!req.isAuthenticated()) {
        return res.redirect("/");
      }

      // Check if file was uploaded
      if (!req.file) {
        return res.redirect("/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.");
      }

      const { title, abstract, areas, id } = req.body;
      const filePath = req.file.path;
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        resource_type: "auto", // auto-detect type (pdf, docx, etc.)
        folder: "submissions",
        public_id: `${req.user.uid}-${Date.now()}`,
      });

      const { data, error } = await supabase.from("submissions").insert([
        {
          conference_id: id,
          primary_author: req.user.email,
          title: title,
          abstract: abstract,
          track_id: areas, // Use track_id instead of area
          file_url: uploadResult.secure_url,
          paper_code: crypto.randomUUID(),
        },
      ]);

      if (error) {
        console.error("Error inserting submission:", error);
        return res.status(500).send("Error submitting your proposal.");
      } else {
        res.redirect("/dashboard");
      }
    })().catch(next);
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
    
    // If no error, proceed with the actual handler
    (async () => {
      if (!req.isAuthenticated()) {
        return res.redirect("/");
      }

      // Check if file was uploaded
      if (!req.file) {
        return res.redirect("/invitee/dashboard?message=Error: No file uploaded. File size must not exceed 4MB.");
      }

      const { title, abstract, areas, id } = req.body;
      const filePath = req.file.path;
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        resource_type: "auto", // auto-detect type (pdf, docx, etc.)
        folder: "submissions",
        public_id: `${req.user.uid}-${Date.now()}`,
      });

      const { data, error } = await supabase.from("invited_talk_submissions").insert([
        {
          conference_id: id,
          invitee_email: req.user.email,
          title: title,
          abstract: abstract,
          track_id: areas, 
          file_url: uploadResult.secure_url,
          paper_id: crypto.randomUUID(),
        },
      ]);

      if (error) {
        console.error("Error inserting submission:", error);
        return res.status(500).send("Error submitting your proposal.");
      } else {
        res.redirect("invitee/dashboard");
      }
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
        // First, try to find user by uid
        const byUid = await supabase.from("users").select("*").eq("uid", profile.id).single();
        if (byUid.data) {
          const user = byUid.data;
          user.role = user.role || "author";
          return cb(null, user);
        }

        // If not found by uid, check by email to avoid duplicate accounts
        const email = profile.emails[0].value;
        const byEmail = await supabase.from("users").select("*").eq("email", email).single();
        if (byEmail.data) {
          const existing = byEmail.data;
          // If the existing user has a local password, deny Google sign-in to avoid clash
          if (existing.password_hash) {
            return cb(null, false, { message: "An account with this email already exists. Please sign in with email and password." });
          }

          // Otherwise link the Google uid to the existing user record and update profile fields if missing
          const updates = {};
          if (!existing.uid) updates.uid = profile.id;
          if (!existing.profile_picture) updates.profile_picture = profile.photos[0].value;
          if (!existing.name) updates.name = profile.displayName;
          if (Object.keys(updates).length > 0) {
            await supabase.from("users").update(updates).eq("email", email);
          }
          existing.role = existing.role || "author";
          return cb(null, existing);
        }

        // No user by uid or email: insert new user (Google-only)
        const { error } = await supabase.from("users").insert([
          {
            uid: profile.id,
            name: profile.displayName,
            email: email,
            profile_picture: profile.photos[0].value,
          },
        ]);
        if (error) {
          console.error("Error inserting user:", error);
          return cb(error);
        }
        const { data: newUser, error: fetchError } = await supabase.from("users").select("*").eq("uid", profile.id).single();
        if (fetchError) {
          console.error("Fetch after insert failed:", fetchError);
          return cb(fetchError);
        }
        newUser.role = newUser.role || "author";
        return cb(null, newUser);
      } catch (err) {
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
        // Only allow if email is in chair table
        const { data: chair, error } = await supabase
          .from("chair")
          .select("*")
          .eq("email_id", profile.emails[0].value)
          .single();

        if (error || !chair) {
          return cb(null, false, {
            message: "You are not authorized as a chair for this conference.",
          });
        }

        // NOTE: Do not block chair Google sign-in based on local password presence here.

        // Update missing fields if needed
        const updates = {};
        if (!chair.profile_picture)
          updates.profile_picture = profile.photos[0].value;
        if (!chair.name) updates.name = profile.displayName;
        if (!chair.uid) updates.uid = profile.id;
        if (Object.keys(updates).length > 0) {
          await supabase
            .from("chair")
            .update(updates)
            .eq("email_id", profile.emails[0].value);
        }

        chair.role = "chair";
        return cb(null, { ...chair, ...updates });
      } catch (err) {
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
        // Fetch all tracks
        const { data: tracks, error: tracksError } = await supabase
          .from("conference_tracks")
          .select("*");

        if (tracksError) return cb(tracksError);

        // Check if user is a reviewer for any track
        const isReviewer = (tracks || []).some(
          (track) =>
            Array.isArray(track.track_reviewers) &&
            track.track_reviewers.includes(profile.emails[0].value)
        );

        if (!isReviewer) {
          return cb(null, false, {
            message: "You are not authorized as a reviewer for any track.",
          });
        }

        const email = profile.emails[0].value;
        // Do NOT insert into users table. Just use Google profile info (reviewer role)
        const user = {
          uid: profile.id,
          name: profile.displayName,
          email: email,
          profile_picture: profile.photos[0].value,
          role: "reviewer",
        };

        return cb(null, user);
      } catch (err) {
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

        // Check if user email is in invitees table for any conference
        const { data: invitees, error: inviteesError } = await supabase
          .from("invitees")
          .select("*")
          .eq("email", userEmail);

        console.log("Invitees query result:", { invitees, error: inviteesError });

        if (inviteesError) {
          console.error("Error querying invitees:", inviteesError);
          return cb(null, false, {
            message: "Database error while checking authorization.",
          });
        }

        if (!invitees || invitees.length === 0) {
          console.log("No invitee found for email:", userEmail);
          return cb(null, false, {
            message: "You are not authorized as an invited speaker.",
          });
        }

  // Use the first invitee record if multiple exist
        const invitee = invitees[0];

        // Update invitee with name and other details if not already set
        const updates = {};
        if (!invitee.name) updates.name = profile.displayName;
        if (Object.keys(updates).length > 0) {
          await supabase
            .from("invitees")
            .update(updates)
            .eq("email", userEmail);
        }

        // Create user object with invitee role
        const user = {
          uid: profile.id,
          name: profile.displayName,
          email: userEmail,
          profile_picture: profile.photos[0].value,
          role: "invitee",
          conference_id: invitee.conference_id,
        };

        console.log("Google4 OAuth - User authenticated:", user);
        return cb(null, user);
      } catch (err) {
        console.error("Error in google4 strategy:", err);
        return cb(err);
      }
    }
  )
);

// -----------------------------
// Passport Local Strategy (email + password)
// -----------------------------
passport.use(
  "local",
  new LocalStrategy({ usernameField: "email", passwordField: "password" }, async (email, password, done) => {
    try {
      const result = await supabase.from("users").select("*").eq("email", email).single();
      const user = result.data;
      if (!user) {
        return done(null, false, { message: "Invalid email or password" });
      }

      if (!user.password_hash) {
        // User exists but has no local password set (likely Google user)
        return done(null, false, { message: "No local password set for this user" });
      }

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return done(null, false, { message: "Invalid email or password" });
      }

      // Remove sensitive fields before returning
      delete user.password_hash;
      user.role = user.role || "author";
      return done(null, user);
    } catch (err) {
      console.error("LocalStrategy error:", err);
      return done(err);
    }
  })
);

// POST /login - authenticate using passport local strategy and return JWT + set cookie
app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      const message = info && info.message ? info.message : 'Invalid email or password';
      return res.status(401).json({ error: message });
    }

    // Log the user into the session (so req.isAuthenticated() works) and also issue JWT
    req.logIn(user, (err) => {
      if (err) return next(err);

      const payload = { uid: user.uid, name: user.name, email: user.email, role: user.role || 'author' };
      const token = jwt.sign(payload, process.env.JWT_SECRET || 'dev_jwt_secret', { expiresIn: '7d' });

      // set httpOnly cookie and return token for client-side usage
      res.cookie('jwt', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
      return res.json({ token, user: payload });
    });
  })(req, res, next);
});

// JWT authentication middleware
function authenticateJWT(req, res, next) {
  const authHeader = req.headers && req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({ error: "Invalid Authorization header format" });
  }
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret");
    req.user = decoded; // attach decoded payload (uid, name, email)
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Helper: allow either session-based Passport or JWT (useful when migrating routes)
function ensureAuthenticatedOrToken(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  // else try JWT
  const authHeader = req.headers && req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") {
      try {
        const decoded = jwt.verify(parts[1], process.env.JWT_SECRET || "dev_jwt_secret");
        req.user = decoded;
        return next();
      } catch (err) {
        return res.redirect("/");
      }
    }
  }

  // If no Authorization header, try cookie named 'jwt' (simple parse)
  const cookieHeader = req.headers && req.headers.cookie;
  if (cookieHeader) {
    const jwtCookie = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('jwt='));
    if (jwtCookie) {
      const token = jwtCookie.split('=')[1];
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret");
        req.user = decoded;
        return next();
      } catch (err) {
        return res.redirect("/");
      }
    }
  }

  return res.redirect("/");
}

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

