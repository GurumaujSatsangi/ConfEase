import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { createClient } from 'redis';
import passport from "passport";
import { RedisStore } from "connect-redis";
import {PDFParse} from 'pdf-parse';
import bcrypt from "bcrypt";
import pool from "../config/db.js";
import passwordValidator from 'password-validator';
import generator from 'generate-password';

import {
  detectAIText,
  getConfidenceScore,
} from "ai-text-detector";

import jwt from "jsonwebtoken";
import session from "express-session";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { fileURLToPath } from "url";
import path from "path";
import multer from "multer";
import { Readable } from "stream";
import { name } from "ejs";
import crypto from "crypto";
import sanitizeHtml from "sanitize-html";
import { sendMail } from "../mailer.js"

// Conference descriptions are rich text from the chair editor. Only safe formatting is kept.
const DESCRIPTION_OPTIONS = {
  allowedTags: ["p","br","h1","h2","h3","h4","strong","b","em","i","u","s","ul","ol","li","blockquote","a","table","thead","tbody","tfoot","tr","th","td","caption","span","div","hr"],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    "*": ["style"]
  },
  allowedStyles: { "*": { "text-align": [/^(left|right|center|justify)$/], "font-weight": [/^(bold|normal|[1-9]00)$/] } },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener noreferrer", target: "_blank" } }) }
};
function sanitizeDescription(html) {
  return sanitizeHtml(String(html || ""), DESCRIPTION_OPTIONS);
}
import events from 'events';
// import { send } from "process";
// Increase EventEmitter default listener limit to avoid MaxListenersExceededWarning in long-running dev flow
events.defaultMaxListeners = 20;

const app = express();
app.locals.sanitizeDescription = sanitizeDescription;




dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB limit to match UI hint and handling
});

function uploadBufferToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });

    Readable.from([buffer]).pipe(uploadStream);
  });
}

async function getJsonCacheValue(key) {
  if (!redisClient) {
    return null;
  }

  try {
    const cachedValue = await redisClient.get(key);
    return cachedValue ? JSON.parse(cachedValue) : null;
  } catch (error) {
    if (!String(error?.message || "").includes("WRONGTYPE")) {
      throw error;
    }

    try {
      const keyType = await redisClient.type(key);

      if (keyType === "list") {
        const listValues = await redisClient.lRange(key, 0, -1);
        const normalizedValues = listValues.flatMap((item) => {
          try {
            const parsedItem = JSON.parse(item);
            return Array.isArray(parsedItem) ? parsedItem : [parsedItem];
          } catch {
            return [];
          }
        });

        await redisClient.set(key, JSON.stringify(normalizedValues));
        return normalizedValues;
      }

      await redisClient.del(key);
      return null;
    } catch (repairError) {
      console.warn(`Unable to repair Redis cache key ${key}:`, repairError.message);
      return null;
    }
  }
}

async function loadConferenceRoles(email) {
  const userRoles = await pool.query(
    "select conference_id, role from conference_roles where lower(email_id) = lower($1)",
    [email]
  );

  return userRoles.rows.reduce((acc, row) => {
    // 1. If the conference_id key doesn't exist yet, create it with an empty array
    if (!acc[row.conference_id]) {
      acc[row.conference_id] = [];
    }
    
    // 2. Push the current role into the array
    acc[row.conference_id].push(row.role);
    
    return acc;
  }, {});
}


const schema = new passwordValidator();

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
      return res.redirect(`/invitee/dashboard?message=Error: ${encodeURIComponent(err.message)}`);
    } else {
      return res.redirect(`/dashboard?message=Error: ${encodeURIComponent(err.message)}`);
    }
  }

  next(err);
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});


app.get("/login",async(req,res)=>{
  return res.redirect("/login/user")
})

const port = process.env.PORT || 3000;
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
app.use(express.static(path.join(rootDir, "public")));
app.set("view engine", "ejs");
app.use("/static", express.static(path.join(rootDir, "public")));

app.set("views", path.join(rootDir, "views"));
let redisClient = null;

if (process.env.VERCEL !== "1" && process.env.REDIS_HOST && process.env.REDIS_PORT) {
  const client = createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    },
  });

  client.on("error", (err) => console.log("Redis Client Error", err));

  try {
    await client.connect();
    redisClient = client;
  } catch (err) {
    console.warn("Redis unavailable; falling back to session/rate-limit bypass.", err.message);
  }
}

// Session middleware must be registered before passport.session()
const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
const sessionOptions = {
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production", // Must be true if you are using HTTPS via Nginx
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 1 day expiration
  }
};

if (redisClient) {
  sessionOptions.store = new RedisStore({ client: redisClient });
}

app.use(session(sessionOptions));

app.use(passport.initialize());
app.use(passport.session());

function getAccessTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.split(" ")[1];
  }

  return req.cookies.access_token || req.cookies.token || null;
}

function verifyAccessToken(token) {
  return assertTokenType(jwt.verify(
    token,
    process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET
  ), "access");
}

function setAccessTokenCookies(res, accessToken) {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
  };

  res.cookie("access_token", accessToken, cookieOptions);
 
}

function getChairAccessTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.split(" ")[1];
  }

  return req.cookies.chair_access_token || req.cookies.ChairToken || null;
}

function verifyChairAccessToken(token) {
  // Prefer the dedicated access token secret, fall back to legacy JWT_SECRET for compatibility
  const secret = process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
  return assertTokenType(jwt.verify(token, secret), "chair");
}

function setChairTokenCookies(res, accessToken, refreshToken) {
  const accessCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
  };

  const refreshCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };

  res.cookie("chair_access_token", accessToken, accessCookieOptions);
  res.cookie("chair_refresh_token", refreshToken, refreshCookieOptions);
}

async function refreshUserSessionFromCookie(req, res) {
  const refreshToken = req.cookies.refresh_token;

  if (!refreshToken) {
    return null;
  }

  try {
    jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_TOKEN_SECRET || process.env.JWT_SECRET
    );
    assertTokenType(jwt.decode(refreshToken), "refresh");

    const refreshTokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    const sessionResult = await pool.query(
      `
      SELECT * FROM sessions
      WHERE refresh_token_hash = $1
      AND is_revoked = FALSE
      AND expires_at > NOW()
      `,
      [refreshTokenHash]
    );

    const session = sessionResult.rows[0];

    if (!session) {
      return null;
    }

    const userResult = await pool.query(
      `SELECT email, name, id, role FROM users WHERE id = $1 LIMIT 1`,
      [session.user_id]
    );

    const user = userResult.rows[0];

    if (!user) {
      return null;
    }

    const conferenceRolesDict = await loadConferenceRoles(user.email);

// 5. Sign the JWT with the nested dictionary
const accessToken = jwt.sign(
  {
    typ: "access", email: user.email,
    name: user.name,
    user_id: user.id,
    role: user.role,
    roles: conferenceRolesDict, // <-- Attached as a dictionary object
  },

      process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET,
      {
        expiresIn: "15m",
      }
    
    );

    setAccessTokenCookies(res, accessToken);

    return {
      email: user.email,
      name: user.name,
      user_id: user.id,
      role: user.role,
      roles: conferenceRolesDict,
    };
  } catch (err) {
    return null;
  }
}

async function refreshChairSessionFromCookie(req, res) {
  const refreshToken = req.cookies.chair_refresh_token;

  if (!refreshToken) {
    return null;
  }

  try {
    jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_TOKEN_SECRET || process.env.JWT_SECRET
    );
    assertTokenType(jwt.decode(refreshToken), "refresh");

    const refreshTokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    const sessionResult = await pool.query(
      `
      SELECT * FROM chair_sessions
      WHERE refresh_token_hash = $1
      AND is_revoked = FALSE
      AND expires_at > NOW()
      `,
      [refreshTokenHash]
    );

    const session = sessionResult.rows[0];

    if (!session) {
      return null;
    }

    const chairResult = await pool.query(
      `SELECT user_id, email, name FROM chairs WHERE user_id = $1 LIMIT 1`,
      [session.chair_id]
    );

    const chair = chairResult.rows[0];

    if (!chair) {
      return null;
    }

    const accessToken = jwt.sign(
      {
        typ: "chair", email: chair.email,
        name: chair.name,
        user_id: chair.user_id,
        role: "chair",
      },
      process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET,
      {
        expiresIn: "15m",
      }
    );

    setChairTokenCookies(res, accessToken, refreshToken);

    return {
      email: chair.email,
      name: chair.name,
      user_id: chair.user_id,
      role: "chair",
    };
  } catch (err) {
    return null;
  }
}

// Middleware functions for authentication
async function checkAuth(req, res, next) {
  const token = getAccessTokenFromRequest(req);

  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      decoded.roles = await loadConferenceRoles(decoded.email).catch(() => decoded.roles || {});
      req.user = decoded;
      res.locals.user = decoded;
      return next();
    } catch (err) {
      // Fall through to refresh-token recovery below.
    }
  }

  const refreshedUser = await refreshUserSessionFromCookie(req, res);

  if (refreshedUser) {
    req.user = refreshedUser;
    res.locals.user = refreshedUser;
    return next();
  }

  return res.redirect("/login/user");
}

async function checkChairAuth(req, res, next) {
  try {
    const chairToken = getChairAccessTokenFromRequest(req);

    if (chairToken) {
      try {
        const decoded = verifyChairAccessToken(chairToken);
        req.user = decoded;
        res.locals.user = decoded;
        return next();
      } catch (err) {
        // Fall through to refresh-token recovery below.
      }
    }

    const refreshedChair = await refreshChairSessionFromCookie(req, res);

    if (refreshedChair) {
      req.user = refreshedChair;
      res.locals.user = refreshedChair;
      return next();
    }

    return res.redirect("/login/user");
  } catch (err) {
    console.error("checkChairAuth error:", err);
    return res.redirect("/login/user");
  }
}

async function checkAuthOrChair(req, res, next) {
  try {
    const chairToken = getChairAccessTokenFromRequest(req);
    const token = getAccessTokenFromRequest(req);
    
    if (chairToken) {
      try {
        req.user = verifyChairAccessToken(chairToken);
        res.locals.user = req.user;
        return next();
      } catch (err) {
        const refreshedChair = await refreshChairSessionFromCookie(req, res);

        if (refreshedChair) {
          req.user = refreshedChair;
          res.locals.user = refreshedChair;
          return next();
        }
      }
    }

    if (token) {
      try {
        req.user = verifyAccessToken(token);
        res.locals.user = req.user;
        return next();
      } catch (err) {
        const refreshedUser = await refreshUserSessionFromCookie(req, res);

        if (refreshedUser) {
          req.user = refreshedUser;
          res.locals.user = refreshedUser;
          return next();
        }
      }
    }

    if (!token && !chairToken) {
      return res.redirect("/login/user");
    }

    return res.redirect("/login/user");
  } catch (err) {
    console.error("checkAuthOrChair error:", err);
    return res.redirect("/login/user");
  }
}
app.use((req, res, next) => {
  const token = getAccessTokenFromRequest(req);

    if (!token) {
        req.user = null;
    res.locals.user = null;
        return next();
    }

    try {
    const decoded = verifyAccessToken(token);

        req.user = decoded; // attach user to request
        res.locals.user = decoded; // optional for EJS partials

    } catch (err) {
        req.user = null;
    res.locals.user = null;
    }

    next();
});


// Missing deadline = closed (fail closed); otherwise closed once the IST date is past the deadline
function deadlineClosed(deadlineValue) {
  const deadline = formatDateISO(deadlineValue);
  return !deadline || getCurrentDateIST() > deadline;
}

// Bounded in-memory limiter for authentication-sensitive POSTs. Used only when Redis is unavailable.
const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const AUTH_MAX_KEYS = 10000;
async function authRateLimitMemory(req, res, next) {
  if (redisClient) {
    try {
      const key = "authrl:" + req.path + ":" + req.ip;
      const attempts = await redisClient.incr(key);
      if (attempts === 1) await redisClient.expire(key, Math.ceil(AUTH_WINDOW_MS / 1000));
      if (attempts > AUTH_MAX_ATTEMPTS) {
        return res.status(429).send("Too Many Requests!");
      }
      return next();
    } catch (err) {
      console.warn("Auth rate limit: Redis unavailable, using in-memory fallback.", err.message);
    }
  }
  const now = Date.now();
  if (authAttempts.size >= AUTH_MAX_KEYS) {
    for (const [key, entry] of authAttempts) {
      if (entry.resetAt <= now) authAttempts.delete(key);
    }
    if (authAttempts.size >= AUTH_MAX_KEYS) authAttempts.clear();
  }
  const key = req.path + "|" + req.ip;
  let entry = authAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + AUTH_WINDOW_MS };
    authAttempts.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > AUTH_MAX_ATTEMPTS) {
    return res.status(429).send("Too Many Requests!");
  }
  return next();
}

const MAX_ALLOWED_REQ = 50;
const MAX_TIME = 60;





// Vercel is a single trusted proxy hop: only trust the last X-Forwarded-For entry it appends
app.set('trust proxy', 1);

app.use(async (req, res, next) => {
  if (!redisClient) {
    return next();
  }

  try {
    const my_ip = req.ip;

    const request = await redisClient.incr(my_ip);

    if (request === 1) {
      await redisClient.expire(my_ip, MAX_TIME);
    }

    if (request > MAX_ALLOWED_REQ) {
      return res.status(429).send("Too Many Requests!");
    }

    next();
  } catch (err) {
    console.warn("Rate limit unavailable; continuing without Redis.", err.message);
    next();
  }
});


app.get("/", async (req, res) => {
  const message = req.query.message || null;

  try {
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
    
    return res.render("home.ejs", { conferences: formattedData, message: message, user: req.user });
  } catch (err) {
    console.error("Home page load failed:", err);
    return res.status(200).render("home.ejs", { conferences: [], message: message, user: req.user });
  }
});









app.get("/reviewer/dashboard", checkAuth, async (req, res) => {
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
        track.track_reviewers.some((e) => String(e).toLowerCase() === String(req.user.email).toLowerCase())
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




app.get("/error", (req, res) => {
  res.render("error.ejs", { message: req.query.message || null });
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


async function isSessionChair(email, conference_id){
const data = await pool.query("select * from conference_tracks where $1=any(panelists)and conference_id = $2",[email,conference_id]);
let result;
if(data.rows.length>0){
  result = true;
}
else{
  result = false;
}
return result;
}

// Shared helpers (token hashing, HTML escaping, token type checks, upload checks, cache invalidation)
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Every token is minted with an explicit "typ". Untyped (legacy) tokens are rejected.
function assertTokenType(decoded, expectedType) {
  if (!decoded || decoded.typ !== expectedType) {
    throw new Error("Invalid token type");
  }
  return decoded;
}

// Public base URL for security-sensitive links. Must be HTTPS in production; null when unusable.
function getAppUrl() {
  const url = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (!url) return null;
  if (process.env.NODE_ENV === "production" && !url.startsWith("https://")) return null;
  return url;
}

function isAllowedDocument(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const head = file.buffer.subarray(0, 8);
  if (ext === ".pdf") return head.subarray(0, 4).toString("latin1") === "%PDF";
  if (ext === ".docx") return head.subarray(0, 2).toString("latin1") === "PK";
  if (ext === ".doc") return head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  return false;
}

async function invalidateConferenceSubmissionCache(emails, conferenceId) {
  if (!redisClient) return;
  const uniqueEmails = [...new Set(emails.filter(Boolean))];
  await Promise.all(uniqueEmails.map((email) => redisClient.del(`${email}_submissions_conference_${conferenceId}`)));
}

// Ownership helpers (use existing data: conferences.created_by/co_chairs, track_reviewers, panelists)
async function chairOwnsConference(email, conferenceId) {
  const result = await pool.query(
    "select 1 from conferences where conference_id = $1 and (created_by = $2 or $2 = any(co_chairs))",
    [conferenceId, email]
  );
  return result.rows.length > 0;
}

async function isTrackReviewer(email, trackId) {
  const result = await pool.query(
    "select 1 from conference_tracks where track_id = $1 and exists (select 1 from unnest(track_reviewers) r where lower(r) = lower($2))",
    [trackId, email]
  );
  return result.rows.length > 0;
}

app.get("/score-posters/:id",checkAuth,async(req,res)=>{

const posterAccess = await pool.query(
  "select 1 from poster_session p where p.conference_id = $1 and $2 = any(p.coodinators) union all select 1 from conference_tracks tr where tr.conference_id = $1 and $2 = any(tr.panelists) limit 1",
  [req.params.id, req.user.email]
);
if (posterAccess.rows.length === 0) {
  return res.redirect("/dashboard?message=You are not authorized to view this page.");
}

const data = await pool.query("select * from submissions where conference_id = $1 and submission_status=$2",[req.params.id,"Submitted Final Camera Ready Paper for Poster Presentation"]);
const  result = data.rows;
res.render("score-posters.ejs",{result, user:req.user})

})

app.post("/submit-poster-score/:conference_id/:submission_id",checkAuth, async(req,res)=>{

  const score = Number.parseInt(req.body.score, 10);
  const conference_id = req.params.conference_id;
  const submission_id = req.params.submission_id;

  // Authorization: only panelists of this submission's track or poster coordinators of its conference may score it
  const scorerCheck = await pool.query(
    "select 1 from submissions s left join conference_tracks t on t.track_id = s.track_id left join poster_session p on p.conference_id = s.conference_id where s.submission_id = $1 and s.conference_id::text = $2::text and ($3 = any(t.panelists) or $3 = any(p.coodinators)) limit 1",
    [submission_id, conference_id, req.user.email]
  );
  if (scorerCheck.rows.length === 0) {
    return res.redirect("/score-posters/" + conference_id + "?message=You are not authorized to score this poster.");
  }



  if (!Number.isInteger(score)) {
    return res.redirect("/score-posters/" + conference_id + "?message=Invalid score value.");
  }

  await pool.query(
    "update submissions set submission_status=$1 where conference_id=$2 and submission_id=$3",
    ["Poster Scored", conference_id, submission_id]
  );
  const scoredPaper = await pool.query("select primary_author, co_authors from submissions where submission_id=$1", [submission_id]);
  await invalidateConferenceSubmissionCache([scoredPaper.rows[0]?.primary_author, ...(scoredPaper.rows[0]?.co_authors || [])], conference_id);
  await pool.query(
    "update final_camera_ready_submissions set panelist_score = $2 where submission_id=$1",
    [submission_id, score]
  );

  return res.redirect("/score-posters/"+conference_id+"?message=Poster has been scored succesfully!");



});



async function fetchConference(id){
  const data = await pool.query("select * from conferences where conference_id =  $1",[id]);
  return data;
}

app.get("/submission/view-co-author-requests/:id",checkAuth, async(req,res)=>{

  const submissions = await pool.query("select * from submissions where submission_id=$1",[req.params.id]);
  if (!submissions.rows[0] || submissions.rows[0].primary_author !== req.user.email) {
    return res.redirect("/dashboard?message=You are not authorized to view these co-author requests.");
  }

  const results = await pool.query("select * from co_author_requests where submission_id=$1 and primary_author=$2",[req.params.id,req.user.email]);

  if(submissions.rows[0].submission_status!="Submitted for Review"){

    return res.redirect("/dashboard?message=Co-Author Requests cannot be viewed now. Current Submission Status: "+submissions.rows[0].submission_status);

  }

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
      // Cast conference_id to text to prevent param mismatch
      `SELECT * FROM conference_tracks
       WHERE conference_id::text = $1
       AND track_reviewers @> ARRAY[$2];`,
      [req.params.id, reviewerEmail]
    );

    const tracks = tracksResult.rows.map(track => ({
      ...track,
      presentation_date: formatDateISO(track.presentation_date)
    }));

    // 2. Fetch the conference
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id::text = $1;`,
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
  `SELECT * FROM submissions s 
   WHERE track_id::text = ANY($1) 
   AND NOT EXISTS (
     SELECT 1 FROM peer_review p 
     WHERE s.submission_id::text = p.submission_id::text 
     AND p.reviewer = $2::text 
   );`,
  [trackIds, req.user.email]
);
      userSubmissions = subResult.rows;
    }

    // 4. Fetch revised submissions for these tracks
    let revisedSubmissions = [];
    if (trackIds.length > 0) {
      const revisedResult = await pool.query(
        `SELECT * FROM submissions s
         WHERE track_id::text = ANY($1)
         AND submission_status = 'Submitted Revised Paper' AND NOT EXISTS(SELECT 1 FROM revised_submissions r where s.submission_id::text = r.submission_id::text and r.reviewer=$2::text);`,
        [trackIds,req.user.email]
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

app.get("/my-profile",checkAuth,async(req,res)=>{
  const user_data = await pool.query("select id, name, email, contact_number, address from users where email=$1",[req.user.email]);
  const session_history = await pool.query("select created_at, ip_address, user_agent from sessions where user_id=$1",[user_data.rows[0].id]);
  return res.render("my-profile.ejs",{user_data: user_data.rows[0],session_history: session_history.rows});
})

app.get("/chair/dashboard/desk/:id",checkChairAuth,async(req,res)=>{
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }


  const conference_id = req.params.id;

  const conference = await pool.query("select * from conferences where conference_id=$1",[conference_id]);
  const submissions = await pool.query("select * from submissions where conference_id=$1 and submission_status=$2",[conference_id,"Submitted for Review"]);

  return res.render("chair/desk.ejs",{conference:conference.rows[0], submissions:submissions.rows});

})

app.post("/submit-desk-decision/:id",checkChairAuth,async(req,res)=>{

  const submission_id = req.params.id;
  const {decision} = req.body;

  


  if (!["DESK ACCEPT", "DESK REJECT"].includes(decision)) {
    return res.redirect("/chair/dashboard?message=Invalid desk decision.");
  }

  const deskClient = await pool.connect();
  let data;
  try {
    await deskClient.query("BEGIN");
    data = await deskClient.query("update submissions set submission_status=$1 where submission_id=$2 returning *",[decision,submission_id]);
    if (!data.rows[0]) {
      await deskClient.query("ROLLBACK");
      return res.redirect("/chair/dashboard?message=Submission not found.");
    }
    await deskClient.query("insert into desk_review(paper_id,decision,user_email)values($1,$2,$3)",[data.rows[0].submission_id,decision,req.user.email]);
    await deskClient.query("COMMIT");
  } catch (txErr) {
    await deskClient.query("ROLLBACK");
    throw txErr;
  } finally {
    deskClient.release();
  }

  if(decision=='DESK REJECT'){
    return res.redirect("/chair/dashboard/desk/remarks-for-rejection/"+submission_id);
  }else {
    await sendMail(data.rows[0].primary_author,"DESK REVIEW DECISION: "+data.rows[0].title,null,"Dear Author,<br><br>The Desk Review for your submission titled <b>"+escapeHtml(data.rows[0].title)+"</b> is completed. Please log in to the DEI CMT portal to check the status of your submission. The decision is also given below for your convinience:<br><br><b>DECISION:</b> ACCEPTED<br><br>Incase of any technical queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit");
    return res.redirect("/chair/dashboard/desk/"+data.rows[0].conference_id+"?message=Submission Status Updated ("+decision+")");
  }
})

app.get("/chair/dashboard/desk/remarks-for-rejection/:id",checkChairAuth,async(req,res)=>{

  const submission_id = req.params.id;

  return res.render("chair/desk-rejection-remarks.ejs",{submission_id});

})

app.post("/submit-desk-rejection-remarks/:id",checkChairAuth,async(req,res)=>{

  const submission_id = req.params.id;
  const {remarks} = req.body;

  const conference = await pool.query("select conference_id from submissions where submission_id = $1",[submission_id]);

  const data = await pool.query("select title, primary_author from submissions where submission_id=$1",[submission_id]);

  await pool.query("update desk_review set remarks=$1 where paper_id = $2",[remarks,submission_id]);
      await sendMail(data.rows[0].primary_author,"DESK REVIEW DECISION: "+data.rows[0].title,null,"Dear Author,<br><br>The Desk Review for your submission titled <b>"+escapeHtml(data.rows[0].title)+"</b> is completed. Please log in to the DEI CMT portal to check the status of your submission. The decision is also given below for your convinience:<br><br><b>DECISION:</b> REJECTED<br>REMARKS:"+escapeHtml(remarks)+"<br><br>Incase of any technical queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit");

  return res.redirect("/chair/dashboard/desk/"+conference.rows[0].conference_id+"?message=Remarks Saved and Status Updated!");
})





app.get("/dashboard", checkAuth, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userRole = req.user.role; // Kept in case your EJS template needs it

    // ==========================================
    // 1. FETCH GLOBAL CONFERENCES (WITH CACHE)
    // ==========================================
    let conferences = [];
    const cache_conference = redisClient ? await redisClient.get("conferences") : null;

    if (cache_conference) {
      conferences = JSON.parse(cache_conference);
    } else {
      const dbresult = await pool.query("SELECT * FROM conferences");
      conferences = dbresult.rows;
      // Cached for 1 hour
      if (redisClient) await redisClient.set("conferences", JSON.stringify(conferences), { EX: 3600 });
    }

  

    // ==========================================
    // 3. RENDER DASHBOARD
    // ==========================================
    res.render("dashboard.ejs", {
      user: req.user,
      userRole,       // Sent to template
      conferences,   // Sent to template
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("Dashboard Route Error:", err);
    res.redirect(
      "/?message=We are facing issues connecting to the dashboard. Please try again later."
    );
  }
});


app.get("/conference/:id",checkAuth,async(req,res)=>{
  const conference = await pool.query("select * from conferences where conference_id = $1",[req.params.id]);
  const conference_tracks = await pool.query("select * from conference_tracks where conference_id=$1",[req.params.id]);
  let submissions = [];
  const conferenceSubmissionsCacheKey = `${req.user.email}_submissions_conference_${req.params.id}`;

  const cachedConferenceSubmissions = await getJsonCacheValue(conferenceSubmissionsCacheKey);
  if (cachedConferenceSubmissions) {
    submissions = cachedConferenceSubmissions;
  } else {
  
      const dbresult = await pool.query(
        "select * from submissions where conference_id = $1 and primary_author = $2",
        [req.params.id, req.user.email]
      );
      submissions = dbresult.rows;
    

    if (redisClient) {
      await redisClient.set(conferenceSubmissionsCacheKey, JSON.stringify(submissions), { EX: 3600 });
    }
  }


  const invited_talk_submissions = await pool.query("select * from invited_talk_submissions where invitee_email=$1 and conference_id = $2",[req.user.email,req.params.id]);
  return res.render("conference.ejs",{conference: conference.rows[0], conference_tracks: conference_tracks.rows, submissions, invited_talk_submissions:invited_talk_submissions.rows, user:req.user})
})

app.get("/create-new-announcement", checkChairAuth, async(req,res)=>{
  res.render("chair/new-announcement.ejs")
})

app.post("/publish-announcement",checkChairAuth,async(req,res)=>{
  const {title, body} = req.body;
  const user=req.user;

  const result = await pool.query("insert into announcements values($1,$2,$3)",[title,body,user.email]);
  if(result.rowCount){
    res.redirect("/chair/dashboard?message=Announcement Posted Succesfully!");
  }
})


app.get("/announcements", checkAuthOrChair, async(req,res)=>{
  const data = await pool.query("select * from announcements");


  res.render("announcements.ejs",{announcements:data.rows})
})

app.post("/publish/review-results", checkChairAuth, async (req, res) => {

  const pending_acceptance_notifications = [];
  const pending_acceptance_notifications_titles = [];

  const {conference_id} = req.body;


  const conference_data = await pool.query("select * from conferences where conference_id = $1",[conference_id]);

  const authors = await pool.query("select submission_id, title, submission_status, primary_author, co_authors from submissions where conference_id = $1",[conference_id]);


  for(let i=0;i<authors.rows.length;i++){

    if(authors.rows[i].submission_status=="Submitted Revised Paper" || authors.rows[i].submission_status=="Submitted for Review"){

      pending_acceptance_notifications[i] = authors.rows[i].submission_id;
      pending_acceptance_notifications_titles[i] = authors.rows[i].title;

    }
    else {
      await sendMail(authors.rows[i].primary_author,"Acceptance Notification | "+conference_data.rows[0].title,null,"Dear Primary Author, <br>This is to inform you that the Acceptance Status of your submission for "+escapeHtml(conference_data.rows[0].title)+" is now available on the DEI CMT Portal. The same is given below for your convinience. <br><br><table style='border: 1px solid black' class='table'><tr><th>Submission Title</th><th>Acceptance Status</th></tr><tr><td>"+escapeHtml(authors.rows[i].title)+"</td><td>"+authors.rows[i].submission_status+"</td></tr></table><br>Incase of any query regarding the conference, please reach out to the Conference Chairs (Email IDs are available on the portal).  <br><br>Incase of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit",authors.rows[i].co_authors);
    }
  }


  if(pending_acceptance_notifications.length>0){
    
    console.log(pending_acceptance_notifications);
    await invalidateConferenceSubmissionCache(authors.rows.flatMap((a) => [a.primary_author, ...(a.co_authors || [])]), conference_id);



    return res.render("chair/pending-acceptance.ejs",{pending_acceptance_notifications_titles, pending_acceptance_notifications});

  }

  return res.redirect("/chair/dashboard/view-submissions/"+conference_id+"?message=Acceptance Notification Published!");

});

app.get("/chair/dashboard/edit-sessions/:id", checkChairAuth, async (req, res) => {
  const sessionTrack = await pool.query("select conference_id from conference_tracks where track_id = $1", [req.params.id]);
  if (!sessionTrack.rows[0] || !(await chairOwnsConference(req.user.email, sessionTrack.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this track.");
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

app.post("/upvote-poster/:id",async(req,res)=>{
  const submission_id = req.params.id;

  const conference_id = (await pool.query("select conference_id from submissions where submission_id=$1",[submission_id])).rows[0]?.conference_id;

  console.log(req.ip+" -> "+submission_id);

  if (!conference_id) {
    return res.redirect("/?message=Submission not found.");
  }

  // One counted vote per voter per submission (atomic set membership in Redis)
  if (redisClient) {
    const firstVote = await redisClient.sAdd("votes_" + submission_id, String(req.ip));
    if (firstVote === 1) {
      await redisClient.incr(submission_id);
    }
  }

    const vpp_vote_token = jwt.sign(
      {
        typ: "vote", submission_id: submission_id,
        user_ip: req.ip,
      },
      process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );


    res.cookie("vpp_vote_token", vpp_vote_token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });


    return res.redirect("/virtual-poster-presentation/"+conference_id+"?message=Your Vote has been submitted Successfully!");


})

app.get("/virtual-poster-presentation/:id", async (req, res) => {
  try {
    const conference_id = req.params.id;
    const vpp_vote_token_from_cookie = req.cookies.vpp_vote_token;

    if (vpp_vote_token_from_cookie) {
      try {
        const result = jwt.verify(
          vpp_vote_token_from_cookie, 
          process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET
        );

        if (result) {
          return res.redirect(`/virtual-poster-presentation/${conference_id}?message=You have already Voted for a Poster, hence you are not allowed to vote. However, you can view the posters.`);
        }
      } catch (jwtError) {
        console.error("JWT Verification failed:", jwtError.message);
        res.clearCookie("vpp_vote_token"); 
      }
    }

    const posters = await pool.query(
      "SELECT * FROM submissions WHERE conference_id=$1 AND submission_status = 'Submitted Final Camera Ready Paper for Poster Presentation'",
      [conference_id]
    );
    
    const poster = await pool.query(
      "SELECT * FROM poster_session WHERE conference_id=$1",
      [conference_id]
    );
   
    const conference = await fetchConference(conference_id);

    return res.render("virtual-poster-presentation", {
      posters: posters.rows, 
      conference: conference.rows[0],
      poster: poster.rows[0]
    });

  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).send("Internal Server Error");
  }
});

app.get(
  "/chair/dashboard/manage-sessions/:id",
  checkChairAuth,
  async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
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
          const formatAuthor = (email, emailToNameMap = {}) =>
            emailToNameMap[email] ? `${emailToNameMap[email]} (${email})` : email;

          // ===== LEADERBOARD =====
          const trackLeaderboardSubs = leaderboardSubs.filter(
            (s) => s.track_id === track.track_id
          );

          const leaderboard = await Promise.all(
            trackLeaderboardSubs.map(async (sub) => {
              
              // ==========================================
              // EDITED: Fetch revised scores if present
              // ==========================================
              const reviewResult = await pool.query(
                `SELECT 
                   pr.reviewer, 
                   COALESCE(rs.mean_score, pr.mean_score) AS final_score,
                   (rs.mean_score IS NOT NULL) AS is_revised
                 FROM peer_review pr
                 LEFT JOIN revised_submissions rs 
                   ON pr.submission_id = rs.submission_id 
                   AND pr.reviewer = rs.reviewer
                 WHERE pr.submission_id = $1`,
                [sub.submission_id]
              );

              let reviewerScore = null;
              let usedRevisedScore = false;

              if (reviewResult.rows.length > 0) {
                reviewerScore =
                  reviewResult.rows.reduce((sum, r) => {
                    if (r.is_revised) usedRevisedScore = true;
                    return sum + (r.final_score || 0);
                  }, 0) / reviewResult.rows.length;
              }
              // ==========================================

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

              return {
                ...sub,
                reviewerScore:
                  reviewerScore !== null ? +reviewerScore.toFixed(2) : null,
                scoreLabel: usedRevisedScore ? 'Revised' : 'Original', // Added this line for the EJS file
                panelistScore:
                  panelistScore !== null ? +panelistScore.toFixed(2) : null,
                averageScore:
                  averageScore !== null ? +averageScore.toFixed(2) : null,
                primary_author_formatted: formatAuthor(sub.primary_author, userMap),
                co_authors_formatted: (sub.co_authors || [])
                  .map((email) => formatAuthor(email, userMap))
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
            primary_author_formatted: formatAuthor(paper.primary_author),
            co_authors_formatted: (paper.co_authors || [])
              .map((email) => formatAuthor(email))
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





app.get("/chair/dashboard/manage-poster-sessions/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
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
        
        // ==========================================
        // EDITED: Fetch all reviewers and override with revised scores if present
        // ==========================================
        const reviewResult = await pool.query(
          `SELECT 
             pr.reviewer, 
             COALESCE(rs.mean_score, pr.mean_score) AS final_score,
             (rs.mean_score IS NOT NULL) AS is_revised
           FROM peer_review pr
           LEFT JOIN revised_submissions rs 
             ON pr.submission_id = rs.submission_id 
             AND pr.reviewer = rs.reviewer
           WHERE pr.submission_id = $1`,
          [sub.submission_id]
        );

        let reviewerScore = null;
        let usedRevisedScore = false; // Track if any revised score was used

        if (reviewResult.rows.length > 0) {
          reviewerScore =
            reviewResult.rows.reduce((sum, r) => {
              if (r.is_revised) usedRevisedScore = true;
              return sum + (r.final_score || 0);
            }, 0) / reviewResult.rows.length;
        }
        // ==========================================

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
          reviewerScore: reviewerScore !== null ? +reviewerScore.toFixed(2) : null,
          scoreLabel: usedRevisedScore ? 'Revised' : 'Original', // <--- ADD THIS LINE
          panelistScore: panelistScore !== null ? +panelistScore.toFixed(2) : null,
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
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  

  const { session_date, start_time, end_time, conference_id,coordinators } = req.body;
 try {
  // Split comma-separated coordinators into an array
  const coordinatorArray = coordinators
    ? coordinators.split(',').map(e => e.trim()).filter(e => e !== '')
    : [];

const posterClient = await pool.connect();
try {
  await posterClient.query("BEGIN");
  await posterClient.query(
  `UPDATE poster_session
   SET date = $1,
       start_time = $2,
       end_time = $3,
       coodinators = $4
   WHERE conference_id = $5;`,
  [session_date, start_time, end_time, coordinatorArray, conference_id]
  );
  for(const coordinator of coordinatorArray){
    await posterClient.query("insert into conference_roles values($1, $2, $3)",[req.params.id, coordinator,"poster_presentation_coordinator"]);
  }
  await posterClient.query("COMMIT");
} catch (txErr) {
  await posterClient.query("ROLLBACK");
  throw txErr;
} finally {
  posterClient.release();
}

await sendMail(coordinatorArray,"Poster Presentation Coordinator Role Assigned",null,"Dear Coordinator, <br><br>You have been asigned a Poster Presentation Coordinator Role for a conference being hosted on DEI CMT Portal. The Session Details are as follows:<br><br><b>Date:</b> "+escapeHtml(session_date)+"<br><b>Timings:</b> "+escapeHtml(start_time)+" - "+escapeHtml(end_time)+" <br><br>If you do not have an account on the portal, please visit https://cmt.gurumaujsatsangi.in/registration/user to create one else login using the credentials. <br><br>Incase of any technical assistance,please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit")

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


app.post("/chair/dashboard/set-session/:id", checkChairAuth, async (req, res) => {
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
    // 1. Fetch the tracks assigned to this panelist for the conference
    const trackResult = await pool.query(
      `SELECT * FROM conference_tracks
       WHERE conference_id = $1
       AND $2 = ANY(panelists)`,
      [req.params.id, req.user.email]
    );
    const trackinfo = trackResult.rows;

    if (trackinfo.length === 0) {
      return res.redirect("/dashboard?message=Track not found.");
    }

    const trackIds = trackinfo.map((track) => track.track_id);

    // 2. Session time enforcement
    let session_end_iso = null;
    try {
      const activeTrack = trackinfo.find(
        (track) =>
          track.presentation_date &&
          track.presentation_start_time &&
          track.presentation_end_time
      );

      if (activeTrack) {
        const istOffset = 5.5 * 60 * 60 * 1000;
        const dateStr = activeTrack.presentation_date instanceof Date
          ? activeTrack.presentation_date.toISOString().slice(0, 10)
          : String(activeTrack.presentation_date);
        const [y, mo, d] = dateStr.split("-").map(Number);
        const startTimeStr = String(activeTrack.presentation_start_time);
        const endTimeStr = String(activeTrack.presentation_end_time);
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

    // 3. Fetch approved oral presentation submissions for only the assigned tracks
    const sessionResult = await pool.query(
      `SELECT * FROM submissions
       WHERE track_id = ANY($1)
       AND submission_status = 'Submitted Final Camera Ready Paper for Oral Presentation'`,
      [trackIds]
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
      paper.panelist_score = finalRow?.panelist_score ?? null;
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

app.post("/send-password-reset-link", authRateLimitMemory, async(req,res)=>{

  const {email} = req.body;

  const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );



    const user = userResult.rows[0];

    if(!user){
      res.redirect("/login/user?message=Password Reset Link has been sent to your Email ID. Kindly reset your password using that link and login using the updated credentials.");
    }
    else {
          const token = crypto.randomBytes(32).toString("hex");

    // Fail closed when the public base URL is not configured (never build links from defaults)
    if (!getAppUrl()) {
      console.error("APP_URL is missing or not HTTPS in production; password reset email not sent.");
      return res.redirect("/login/user?message=Password reset is temporarily unavailable. Please try again later.");
    }

    const expiresAt = new Date(Date.now() + 1000 * 60 * 15);

    await pool.query(
        `INSERT INTO password_resets (email, token, expires_at)
         VALUES ($1, $2, $3)`,
        [email, hashToken(token), expiresAt]
    );

    const resetLink = `${getAppUrl()}/reset-password/${token}`;

    await sendMail(email,"Password Reset Link",null,"Dear User, <br><br>Please click on this link to update your password for your DEI CMT account:<br> "+resetLink+" <br><br>If you did not request for this link, kindly ignore. DO NOT SHARE THIS LINK WITH ANYONE. <br><br>Incase of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit")
    return res.redirect("/login/user?message=Password Reset Link has been sent to your Email ID. Kindly reset your password using that link and login using the updated credentials.")

    }

    



})

app.get("/reset-password/:token", async (req, res) => {
    const { token } = req.params;
  const message = req.query.message || null;

    const result = await pool.query(
        `SELECT * FROM password_resets
         WHERE token=$1 AND expires_at > NOW()`,
        [hashToken(token)]
    );

    if (result.rows.length === 0) {
        return res.redirect("/login/user?message=This password reset link has expired. Please try again.");
    }

    res.render("login/reset-password.ejs", {
      result: result.rows[0],
      message,
    });
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

        return res.redirect(`/panelist/active-session/${track.conference_id}`);
      }
    } else {
      return res.redirect("/panelist/dashboard?message=Session date mismatch.");
    }

  } catch (err) {
    console.error("Error in /start-session:", err);
    return res.redirect("/panelist/dashboard?message=Error starting session.");
  }
});


app.get("/reviewer/dashboard/review/:id", checkAuth, async (req, res) => {
 

  try {
    const paperCode = req.params.id;


    // await pool.query
    // ("insert into peer_review_vault(paper_id,status,locked_by) values ($1,$2,$3)",
    //   [req.params.id,"locked",req.user.email]);


    //
    // 1. Fetch submission by paper_code
    //
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE paper_code = $1 and submission_status=$2 LIMIT 1;`,
      [paperCode,"DESK ACCEPT"]
    );

    const submissionData = submissionResult.rows[0];

    // 2. Handle missing submission
    if (!submissionData) {
      return res.render("error.ejs", {
        message: "The submission you are trying to view does not exist.",
      });
    }

    //
    // Authorization: only reviewers assigned to this paper's track may review it
    if (!(await isTrackReviewer(req.user.email, submissionData.track_id))) {
      return res.render("error.ejs", {
        message: "You are not assigned as a reviewer for this submission.",
      });
    }

    // 3. Check if it was already reviewed
    //

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
    // Authorization: only reviewers assigned to this paper's track may re-review it
    if (!(await isTrackReviewer(req.user.email, submissionData.track_id))) {
      return res.render("error.ejs", {
        message: "You are not assigned as a reviewer for this submission.",
      });
    }

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
      // Authorization: only reviewers assigned to this paper's track may review it
      if (!(await isTrackReviewer(req.user.email, submissionData.track_id))) {
        return res.redirect("/reviewer/dashboard?message=You are not assigned as a reviewer for this submission.");
      }

    //
    // 2. Compute mean score
    //
    if (![originality_score, relevance_score, technical_quality_score, clarity_score, impact_score].every((s) => Number.isFinite(parseFloat(s)))) {
      return res.redirect("/reviewer/dashboard?message=All review scores must be valid numbers.");
    }
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
      "insert into revised_submissions(submission_id, originality_score, relevance_score,technical_quality_score, clarity_score, impact_score, mean_score, acceptance_status,review_status,reviewer,remarks) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[
        submission_id,
        originality_score,
        relevance_score,
        technical_quality_score,
        clarity_score,
        impact_score,
        mean_score,
        status,
        "Re-Reviewed",  
        req.user.email,
        remarks
      ]
    );

    //
    // 4. Update submissions table status, mean_score, and remarks
    //
   

    //  await pool.query(
    //   `UPDATE submissions
    //    SET submission_status = $1
    //    WHERE submission_id = $2;`,
    //   [status,submission_id]
    // );

    //
    // 5. Send email notification
    //
    // try {
    //   const conferenceResult = await pool.query(
    //     `SELECT acceptance_notification, title
    //      FROM conferences WHERE conference_id = $1 LIMIT 1;`,
    //     [conference_id]
    //   );
    //   const conferenceData = conferenceResult.rows[0];

    //   const acceptanceDate = conferenceData?.acceptance_notification
    //     ? new Date(conferenceData.acceptance_notification).toLocaleDateString("en-US", {
    //         year: "numeric",
    //         month: "long",
    //         day: "numeric",
    //       })
    //     : "the scheduled acceptance notification date";

    //   const conferenceTitle = conferenceData?.title || "the conference";

    //   const coAuthors = Array.isArray(submissionData.co_authors)
    //     ? submissionData.co_authors
    //     : [];
    //   const ccEmails = coAuthors.length > 0 ? coAuthors.join(",") : null;

    //   await sendMail(
    //     submissionData.primary_author,
    //     `Re-review Completed - ${submissionData.title}`,
    //     `Your revised paper "${submissionData.title}" has been re-reviewed. Results will be published on ${acceptanceDate}.`,
    //     `<p>Dear Author,</p>
    //      <p>Your revised paper titled <strong>"${submissionData.title}"</strong> has now been re-reviewed.</p>
    //      <p>Final acceptance results will be announced on <strong>${acceptanceDate}</strong>.</p>
    //      <p>Best Regards,<br>DEI Conference Management Toolkit Team</p>`,
    //     ccEmails
    //   );
    // } catch (emailError) {
    //   console.error("Email send error (ignored):", emailError);
    // }

    return res.redirect("/reviewer/"+conference_id+"?message=Revised paper review submitted successfully.");

  } catch (err) {
    console.error("Error during re-review:", err);
    return res.redirect("/reviewer/dashboard?message=Error processing re-review.");
  }
});


app.post("/resolve-re-review-conflicts/:id/:confid",checkChairAuth,async(req,res)=>{

  const submission_id = req.params.id;
  const conference_id = req.params.confid;

  const {final_remarks,status} = req.body;

  const data = await pool.query("update submissions set submission_status=$1, remarks=$2 where submission_id=$3 returning *",[status,final_remarks,submission_id]);

  if(data.rows[0]){
    return res.redirect("/chair/dashboard/view-submissions/"+conference_id+"?message=Submitted Final Decision!")
  }
  return res.redirect("/chair/dashboard?message=Submission not found.");

})



app.post("/chair/dashboard/manage-sessions/:id", checkChairAuth, async (req, res) => {
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
             <p><strong>Track:</strong> ${escapeHtml(track.track_name)}</p>
             <p><strong>Presentation Date:</strong> ${escapeHtml(session_date)}</p>
             <p><strong>Time:</strong> ${escapeHtml(session_start_time)} to ${escapeHtml(session_end_time)}</p>
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
    const { name, email, contact_number, address, password } = req.body;

    // hash password (IMPORTANT: await)
    const hashed_password = await bcrypt.hash(password, 10);

    const check = await pool.query("select * from users where email = $1",[email]);

    if(check.rows.length===0){

      schema
.is().min(8)                                    // Minimum length 8
.is().max(100)                                  // Maximum length 100
.has().uppercase()                              // Must have uppercase letters
.has().lowercase()                              // Must have lowercase letters
.has().digits(2)                                // Must have at least 2 digits
.has().not().spaces()                           // Should not have spaces
.is().not().oneOf(['Passw0rd', 'Password123']);

const result = schema.validate(password);

if(result==true){

 await pool.query(
      "INSERT INTO users (name, email, password, status, contact_number, address) VALUES ($1, $2, $3,$4,$5,$6)",
      [name, email, hashed_password,"ACTIVATION PENDING",contact_number, address]
    );

    const activation_code = crypto.randomUUID();
    await pool.query("insert into activation_requests(email, activation_code) values($1, $2)",[email,activation_code]);
     await sendMail(email,name+", Welcome to DEI CMT!",null,"Dear "+escapeHtml(name)+"! <br><br>Your DEI CMT account has been created succesfully but needs to be activated before you can use it. Please visit https://cmt.gurumaujsatsangi.in/account-activation and enter the Account Activation Code.<br><br><b>Account Activation Code:</b> "+activation_code+" <br><br>Incase of any technical assistance please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit").catch((mailErr) => console.error("Welcome email failed:", mailErr));

    return res.redirect("/login/user?message=Your account has been created succesfully, please check your Email inbox for an Email with the subject 'Welcome to DEI CMT!' for the account activation code.");


}
else{
  return res.redirect("/login/user?message=Your password does not match our Password Policy. Please use 8 to 100 characters with at least one uppercase letter, one lowercase letter, two digits, and no spaces.")
}




       

    }
    else{
          return res.redirect("/registration/user?message=Account with this Email Address already exists.");


    }

  
  } catch (err) {
    // console.error(err);
    return res.redirect("/registration/user?message=Something went wrong, please try again later.");
  }
});

app.get("/account-activation", async (req, res) => {

  res.render("login/activation.ejs", {message:req.query.message || null});
});

app.post("/activate-account", async (req, res) => {
  try {
    const { activation_code } = req.body;

    // Check if activation code exists
    const data = await pool.query(
      "SELECT * FROM activation_requests WHERE activation_code = $1",
      [activation_code]
    );

    if (!data.rows.length) {
      return res.redirect("/login/user?message=Invalid or expired activation code.");
    }

    const email = data.rows[0].email;

    // Update user status
    const data2 = await pool.query(
      "UPDATE users SET status = $1 WHERE email = $2 RETURNING *",
      ["ACCOUNT ACTIVATED", email]
    );

    if (!data2.rows.length) {
      return res.redirect("/login/user?message=User not found.");
    }

    // Delete activation request
    await pool.query(
      "DELETE FROM activation_requests WHERE activation_code = $1",
      [activation_code]
    );

    await sendMail(email,"Account Activated",null, "Dear User, <br><br>Your DEI CMT account linked to this Email Address has been ACTIVATED. <br><br>Incase of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit");

    return res.redirect(
      "/login/user?message=Account Activated Successfully! Please login."
    );

  } catch (error) {
    console.error(error);
    return res.status(500).send("Server Error");
  }
});


app.get("/login/user", async (req,res)=>{

  const token = req.cookies['access_token'] || req.cookies['token'];
  if(token){
    return res.redirect("/dashboard");
  }
  const chairtoken = req.cookies['chair_access_token'] || req.cookies['ChairToken'];
  if(chairtoken){
   return  res.redirect("/chair/dashboard");
  }
  const message = req.query.message || null;
  res.render("login/user", { message });
})

app.get("/registration/user", async (req,res)=>{
  const message = req.query.message || null;
  res.render("login/user2", { message });
})



app.get("/user-login", (req, res) => {
  return res.redirect("/login/user");
});


app.post("/user-login", authRateLimitMemory, async (req, res) => {
  try {

    const { email, password } = req.body;

    // FETCH USER
    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.redirect(
        "/login/user?message=Invalid email or password"
      );
    }

    const user = userResult.rows[0];


    // CHECK ACTIVATION
    if (user.status === "ACTIVATION PENDING") {
      return res.redirect(
        "/login/user?message=Account not activated. Check your email."
      );
    }

    // COMPARE PASSWORD
    const isMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!isMatch) {
      return res.redirect(
        "/login/user?message=Invalid email or password"
      );
    }

    // ACCESS TOKEN
    const conferenceRolesDict = await loadConferenceRoles(user.email);
    const access_token = jwt.sign(
      {
        typ: "access", email: user.email,
        name: user.name,
        user_id: user.id,
        role: user.role,
        roles: conferenceRolesDict,
      },
      process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET,
      {
        expiresIn: "15m"
      }
    );

    // REFRESH TOKEN
    const refresh_token = jwt.sign(
      {
        typ: "refresh", user_id: user.id
      },
      process.env.JWT_REFRESH_TOKEN_SECRET || process.env.JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    // HASH REFRESH TOKEN
    const hashed_refresh_token = crypto
      .createHash("sha256")
      .update(refresh_token)
      .digest("hex");

    // STORE SESSION
    await pool.query(
      `
      INSERT INTO sessions (
        user_id,
        refresh_token_hash,
        ip_address,
        user_agent,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        NOW() + INTERVAL '7 days'
      )
      `,
      [
        user.id,
        hashed_refresh_token,
        req.ip,
        req.headers["user-agent"]
      ]
    );

    // STORE REFRESH TOKEN COOKIE
    res.cookie("refresh_token", refresh_token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });

    // STORE ACCESS TOKEN COOKIE
    setAccessTokenCookies(res, access_token);

    // REDIRECT
    return res.redirect("/dashboard");

  } catch (err) {

    console.error(err);

    return res.status(500).send("Server error");

  }
});


app.post("/activation-check",async(req,res)=>{
  const {email} = req.body;
  const data = await pool.query("select * from users where email=$1 and status=$2",[email,"ACTIVATION PENDING"]);
  
  if(data.rows[0]){

      const data2 = await pool.query("select * from activation_requests where email=$1",[email]);
    if(data2.rows[0]){
      return res.redirect("/account-activation?message=Account Activation Code has been sent to the requested Email ID");
    }
  } else{
    return res.redirect("/account-activation?message=Account Activation Code has been sent to the requested Email ID");
  }
})



async function handleRefresh(req, res) {

  try {

    const refresh_token = req.cookies.refresh_token;
    if (!refresh_token) {
      return res.status(401).json({
        message: "No refresh token"
      });
    }

    // VERIFY REFRESH TOKEN
    const decoded = jwt.verify(
      refresh_token,
      process.env.JWT_REFRESH_TOKEN_SECRET || process.env.JWT_SECRET
    );
    assertTokenType(decoded, "refresh");

    // HASH TOKEN
    const refreshTokenHash = crypto
      .createHash("sha256")
      .update(refresh_token)
      .digest("hex");

    // CHECK SESSION
    const sessionResult = await pool.query(
      `
      SELECT * FROM sessions
      WHERE refresh_token_hash = $1
      AND is_revoked = FALSE
      AND expires_at > NOW()
      `,
      [refreshTokenHash]
    );

    const session = sessionResult.rows[0];

    if (!session) {
      return res.status(401).json({
        message: "Invalid session"
      });
    }

    const userResult = await pool.query(
      `SELECT email, name, id, role FROM users WHERE id = $1 LIMIT 1`,
      [session.user_id]
    );
    const user = userResult.rows[0];

    if (!user) {
      return res.status(401).json({
        message: "User not found"
      });
    }

    // CREATE NEW ACCESS TOKEN
    const conferenceRolesDict = await loadConferenceRoles(user.email);
    const accessToken = jwt.sign(
      {
        typ: "access", email: user.email,
        name: user.name,
        user_id: user.id,
        role: user.role,
        roles: conferenceRolesDict
      },
      process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET,
      {
        expiresIn: "15m"
      }
    );

    setAccessTokenCookies(res, accessToken);

    // SEND NEW ACCESS TOKEN
    res.json({
      accessToken
    });

  } catch (err) {

    console.error(err);

    return res.status(401).json({
      message: "Invalid refresh token"
    });

  }
}

app.post("/refresh", handleRefresh);
app.post("/auth/refresh", handleRefresh);




app.get("/admin",  async(req,res)=>{


const chairs = await pool.query("select name, email, contact_number, faculty, department, status from chairs");
const conferences = await pool.query("select conference_id, title, created_by from conferences");
res.render("admin",{chairs:chairs.rows,conferences:conferences.rows,message:req.query.message || null});
})

// Admin authorization: explicit allow-list in ADMIN_EMAILS (comma-separated). Fails closed when unset or empty.
// Chair status, reviewer roles, and client-supplied fields never grant admin access.
function isAdmin(req) {
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = String(req.user?.email || "").trim().toLowerCase();
  return email !== "" && allowed.includes(email);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(403).render("error.ejs");
  }
  return next();
}

// Issues a 24-hour one-time setup link for a chair. Only the SHA-256 hash of the token is stored.
async function issueAccountSetupLink(email) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query("DELETE FROM password_resets WHERE email = $1", [email]);
  await pool.query(
    "INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)",
    [email, hashToken(token), new Date(Date.now() + 1000 * 60 * 60 * 24)]
  );
  return `${getAppUrl()}/chair-password-setup?token=${token}`;
}

app.post("/create-chair-credentials",  async(req,res)=>{

  const {name,email,contact_number, faculty, department} = req.body;

  if (!getAppUrl()) {
    return res.redirect("/admin?message=" + encodeURIComponent("APP_URL is missing or not HTTPS in production; the setup link cannot be sent."));
  }

  // The chair starts with an unusable random password and sets their own via the setup link
  const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const result = await pool.query("insert into chairs(name,email,contact_number,faculty,department, password,status) values($1,$2,$3,$4,$5,$6,$7)",[name,email,contact_number, faculty,department, unusablePassword,"ACCOUNT ACTIVATED"]);

  if(!result.rowCount){
    return res.send("Error");
  }

  const setupLink = await issueAccountSetupLink(email);
  await sendMail(email,"DEI CMT Chair Portal Access",null,"Dear "+escapeHtml(name)+" <br><br>You have been granted DEI CMT - CHAIR PORTAL access. Please set your password using the link below. The link is valid for 24 hours. <br><br><a href=\"" + setupLink + "\">Set your password</a> <br><br>Incase of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit");

  res.redirect("/admin?message=" + encodeURIComponent("Chair Portal access granted to " + name + " (" + email + "). A password setup link has been sent to the user."));
});

app.get("/chair-password-setup", async (req, res) => {
  const token = String(req.query.token || "");
  const result = token ? await pool.query("select 1 from password_resets where token=$1 and expires_at > NOW()", [hashToken(token)]) : { rows: [] };
  if (result.rows.length === 0) {
    return res.redirect("/login/user?message=This setup link is invalid or has expired.");
  }
  return res.render("chair-password-setup.ejs", { token, message: req.query.message || null });
});

app.post("/chair-password-setup", authRateLimitMemory, async (req, res) => {
  const { token, password } = req.body;
  const policy = new passwordValidator()
    .is().min(8)
    .is().max(100)
    .has().uppercase()
    .has().lowercase()
    .has().digits(2)
    .has().not().spaces()
    .is().not().oneOf(['Passw0rd', 'Password123']);
  if (!policy.validate(String(password || ""))) {
    return res.redirect("/chair-password-setup?token=" + encodeURIComponent(String(token || "")) + "&message=" + encodeURIComponent("Your password does not match our policy. Ensure it is 8-100 characters long, contains uppercase and lowercase letters, at least 2 digits, and no spaces."));
  }

  const tokenResult = await pool.query("select email from password_resets where token=$1 and expires_at > NOW()", [hashToken(String(token || ""))]);
  const tokenRow = tokenResult.rows[0];
  if (!tokenRow) {
    return res.redirect("/login/user?message=This setup link is invalid or has expired.");
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const updated = await pool.query("update chairs set password=$1 where email=$2 returning email", [hashedPassword, tokenRow.email]);
  await pool.query("DELETE FROM password_resets WHERE email = $1", [tokenRow.email]);

  if (!updated.rowCount) {
    return res.redirect("/login/user?message=This setup link is invalid or has expired.");
  }
  return res.redirect("/login/user?message=Password set. Please log in to the chair portal.");
});

app.post("/reset-chair-password/:id", checkAuth, requireAdmin, async(req,res)=>{
  const email = req.params.id;

  if (!getAppUrl()) {
    return res.redirect("/admin?message=" + encodeURIComponent("APP_URL is missing or not HTTPS in production; the setup link cannot be sent."));
  }

  const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const data = await pool.query("update chairs set password=$1 where email=$2 returning email",[unusablePassword,email]);

  if(!data.rows[0]){
    return res.redirect("/admin?message=Chair not found.");
  }

  const setupLink = await issueAccountSetupLink(email);
  await sendMail(email,"Chair Portal Password Reset",null,"Dear Chair, <br><br>The Admin has reset your DEI CMT Chair Portal password. Please set a new password using the link below. The link is valid for 24 hours. <br><br><a href=\"" + setupLink + "\">Set your password</a> <br><br>Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards, <br>Team DEI Conference Management Toolkit");

  return res.redirect("/admin?message=" + encodeURIComponent("A password setup link has been sent to " + email + "."));
});

app.post("/grant-access/:id", checkAuth, requireAdmin, async(req,res)=>{

  const email = req.params.id;
  const data = await pool.query("update chairs set status=$1 where email=$2 returning *",["ACCOUNT ACTIVATED",email]);

  if(data.rows[0]){

    await sendMail(email,"Chair Portal Access Re-Granted",null,"Dear Chair, The Admin has Re-Granted you the access to the DEI CMT Chair Portal. Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.");
    return res.redirect("/admin?message=" + encodeURIComponent("Chair Portal Access Re-Granted to " + email + "!"));
  }
  return res.redirect("/admin?message=Chair not found.");

})

app.post("/select-room/:id", checkChairAuth, async(req,res)=>{

  const uid = req.params.id;

  if (redisClient) await redisClient.set("S-101",uid);
  return res.sendStatus(204);

})

app.post("/revoke-access/:id", checkAuth, requireAdmin, async(req,res)=>{

  const email = req.params.id;

  const pre_data = await pool.query("select * from chairs where email=$1 and status=$2",[email,"ACCOUNT ACTIVATED"]);

  if(pre_data.rows.length){

     const data = await pool.query("update chairs set status=$1 where email=$2 returning *",["ACCESS REVOKED",email]);
  if(data.rows[0]){

    await sendMail(email,"Chair Portal Access Revoked",null,"Dear Chair, The Admin has revoked your DEI CMT Chair Portal Access. Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.");
    return res.redirect("/admin?message=" + encodeURIComponent("Chair Access Revoked for " + email));
  }

  } else{
    return res.redirect("/admin?message=User not Found with 'Account Activated' status!");
  }

})

app.post("/delete-account/:id", checkAuth, requireAdmin, async(req,res)=>{
  const email = req.params.id;

  const data = await pool.query("delete from chairs where email = $1 returning *",[email]);

  if(data.rows[0]){
    return res.redirect("/admin?message=" + encodeURIComponent("Account (" + email + ") Deleted!"));
  }
  return res.redirect("/admin?message=Chair not found.");
})


app.post("/chair-login", authRateLimitMemory, async (req, res) => {
  try {
    const { email, password } = req.body;

    // fetch user
    const userResult = await pool.query(
      "SELECT * FROM chairs WHERE email = $1 and status=$2",
      [email,"ACCOUNT ACTIVATED"]
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
    const chairAccessToken = jwt.sign(
      { typ: "chair", email: user.email, name: user.name, user_id: user.user_id, role: "chair" },
      process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const chairRefreshToken = jwt.sign(
      { typ: "refresh", email: user.email, name: user.name },
      process.env.JWT_REFRESH_TOKEN_SECRET || process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // set cookie with consistent options
    setChairTokenCookies(res, chairAccessToken, chairRefreshToken);



    // HASH CHAIR REFRESH TOKEN and store session with role_type='chair'
    const hashed_chair_refresh_token = crypto
      .createHash("sha256")
      .update(chairRefreshToken)
      .digest("hex");

    const chairUserId = user.user_id || null;

    if (chairUserId) {
      await pool.query(
        `
        INSERT INTO chair_sessions (
          chair_id,
          refresh_token_hash,
          ip_address,
          user_agent,
          expires_at,
          is_revoked
        
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NOW() + INTERVAL '7 days',
          $5
        
        )
        `,
        [chairUserId, hashed_chair_refresh_token, req.ip, req.headers["user-agent"],false]
      );
    } else {
      console.error("Could not determine chair user id; skipping session insert for chair.");
    }

    // ✅ redirect instead of render
    return res.redirect("/chair/dashboard?message=Welcome, " + user.name + " !");

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

async function handleChairRefresh(req, res) {
  try {
    const refreshToken = req.cookies.chair_refresh_token;
    if (!refreshToken) {
      return res.status(401).json({ message: "No refresh token" });
    }

    // HASH THE PROVIDED REFRESH TOKEN
    const refreshTokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    // CHECK SESSION FOR CHAIR
    const sessionResult = await pool.query(
      `
      SELECT * FROM chair_sessions
      WHERE refresh_token_hash = $1
      AND is_revoked = FALSE
      AND expires_at > NOW()
    
      `,
      [refreshTokenHash]
    );

    const session = sessionResult.rows[0];

    if (!session) {
      return res.status(401).json({ message: "Invalid session" });
    }

    // Resolve the chair directly from chairs.user_id.
    const chairResult = await pool.query(
      `SELECT user_id, email, name FROM chairs WHERE user_id = $1 LIMIT 1`,
      [session.chair_id]
    );

    const chair = chairResult.rows[0];

    if (!chair) {
      return res.status(401).json({ message: "Chair not found" });
    }

    // CREATE NEW ACCESS TOKEN
    const accessToken = jwt.sign(
      { typ: "chair", email: chair.email, name: chair.name, user_id: chair.user_id, role: "chair" },
      process.env.JWT_ACCESS_TOKEN_SECRET || process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    setChairTokenCookies(res, accessToken, refreshToken);

    return res.json({ accessToken });
  } catch (err) {
    console.error(err);
    return res.status(401).json({ message: "Invalid refresh token" });
  }
}

app.post("/chair/refresh", handleChairRefresh);
app.post("/auth/chair/refresh", handleChairRefresh);

app.post("/update-password", authRateLimitMemory, async (req, res) => {
  try {
    // SECURITY: Do not accept 'email' from req.body. Rely entirely on the token.
    const { new_password, token } = req.body;

     schema
.is().min(8)                                    // Minimum length 8
.is().max(100)                                  // Maximum length 100
.has().uppercase()                              // Must have uppercase letters
.has().lowercase()                              // Must have lowercase letters
.has().digits(2)                                // Must have at least 2 digits
.has().not().spaces()                           // Should not have spaces
.is().not().oneOf(['Passw0rd', 'Password123']);
    
    // 1. Validate the new password
    const isValidPassword = schema.validate(new_password);

    if (!isValidPassword) {
      // Updated message to match the actual schema (2 digits, no special char mentioned yet)
      return res.redirect(`/reset-password/${token}?message=Your password does not match our policy. Ensure it is 8-100 characters long, contains uppercase and lowercase letters, at least 2 digits, and no spaces.`);
    }

    // 2. Validate the token and get the associated email FIRST
    const tokenRecord = await pool.query(
      "SELECT email FROM password_resets WHERE token=$1 AND expires_at > NOW()",
      [hashToken(token)]
    );

    // If no token is found, it's invalid or expired
    if (tokenRecord.rowCount === 0) {
      return res.redirect("/login/user?message=Your reset link is invalid or has expired. Please request a new one.");
    }

    const verifiedEmail = tokenRecord.rows[0].email;

    // 3. Hash the new password
    const hashed_new_password = await bcrypt.hash(new_password, 10);

    // 4. Update the user's password using the VERIFIED email
    await pool.query(
      "UPDATE users SET password=$1 WHERE email=$2", 
      [hashed_new_password, verifiedEmail]
    );

    // 5. Delete the used token to prevent reuse
    await pool.query(
      "DELETE FROM password_resets WHERE token=$1", 
      [hashToken(token)]
    );

    // 6. Send confirmation email (Removed the stray '+')
    await sendMail(
      verifiedEmail, 
      "Password Updated", null, 
      "Hi, <br><br>The password for your DEI CMT account linked to this Email ID was successfully updated. <br><br>In case of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit"
    );

    // 7. Send success response
    return res.redirect("/login/user?message=Password Updated. Please login with your updated credentials.");

  } catch (error) {
    console.error("Error during password update:", error);
    // Send a generic error so the user doesn't hang
    return res.redirect("/login/user?message=An internal server error occurred while updating your password. Please try again later.");
  }
});



app.post("/chair/dashboard/update-track/:trackId", checkChairAuth, async (req, res) => {
  try {
    const { trackId } = req.params;

    const trackOwner = await pool.query("select conference_id from conference_tracks where track_id = $1", [trackId]);
    if (!trackOwner.rows[0] || !(await chairOwnsConference(req.user.email, trackOwner.rows[0].conference_id))) {
      return res.redirect("/chair/dashboard?message=You are not authorized to modify this track.");
    }
    const {
      track_title,
      reviewers,
      session_date,
      start_time,
      end_time,
      panelists
    } = req.body;

    // 1. Clean up comma-separated values (filter out empty strings to avoid [""])
    const reviewersArray = reviewers ? reviewers.split(",").map(r => r.trim()).filter(r => r) : [];
    const panelistsArray = panelists ? panelists.split(",").map(p => p.trim()).filter(p => p) : [];

    const subjectRow = await pool.query("select conference_id, group_id from conference_tracks where track_id = $1", [trackId]);
    const newSubjectName = String(track_title || "").trim();
    if (!newSubjectName) return res.redirect(manageTracksUrl(subjectRow.rows[0].conference_id, "Subject area name cannot be empty."));
    const subjectDup = await pool.query("select 1 from conference_tracks where conference_id = $1 and track_name = $2 and group_id is not distinct from $3 and track_id <> $4", [subjectRow.rows[0].conference_id, newSubjectName, subjectRow.rows[0].group_id, trackId]);
    if (subjectDup.rows.length) return res.redirect(manageTracksUrl(subjectRow.rows[0].conference_id, "A subject area with this name already exists in this track."));

    // 2. FETCH OLD ROLES FIRST (Crucial for invalidating users who are being removed)
    const oldTrackData = await pool.query(
      `SELECT track_reviewers, panelists FROM conference_tracks WHERE track_id = $1`,
      [trackId]
    );
    
    const oldReviewers = oldTrackData.rows[0]?.track_reviewers || [];
    const oldPanelists = oldTrackData.rows[0]?.panelists || [];

    // 3. Update the database
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
    console.error("Error updating track:", err);
    res.redirect("/chair/dashboard?message=Failed to update Track!");
  }
});




app.get("/chair/dashboard/invited-talks/:id", checkChairAuth,async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
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

app.post("/add-invitee", checkChairAuth,async (req, res) => {
  
  const { email, conference_id,name } = req.body;
  if (!email || !conference_id) {
    return res.status(400).send("Email and conference ID are required.");
  }

  try {
    // 1. Insert invitee row
    const data2= await pool.query("select * from invitees where conference_id=$1 and email=$2",[conference_id,email]);

    const data = await pool.query("select * from users where email=$1",[email]);
    if(data.rows[0] && !data2.rows[0]){
      await pool.query(
      `INSERT INTO invitees (conference_id, name, email)
       VALUES ($1, $2, $3);`,
      [conference_id, name, email]
    );
     await sendMail(email,name+", You are invited!",null,"Dear "+escapeHtml(name)+" <br>Greetings from DEI Conference Management Toolkit! <br><br>You have been invited as an Invited Speaker to present your paper. Please visit, https://cmt.gurumaujsatsangi.in/registration/user to create your account and submit your paper for the Invited Talk. <br><br>Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit")
    return res.redirect("/chair/dashboard/invited-talks/"+conference_id+"?message=Succesfully Added Invitee. Invitee already has an account on CMT.");
    }
    else if (data.rows[0] && data2.rows[0]){

    return res.redirect("/chair/dashboard/invited-talks/"+conference_id+"?message=The Email you are trying to add already has been invited as an Invited Speaker for this conference and has an account on CMT.");
    
    }
    else {
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
        // One-time setup token (valid 24 hours), bound to this invitee's email
        const inviteToken = crypto.randomBytes(32).toString("hex");
        await pool.query(
          `INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)`,
          [email, hashToken(inviteToken), new Date(Date.now() + 1000 * 60 * 60 * 24)]
        );
        await sendMail(email,name+", You are invited!",null,"Dear "+escapeHtml(name)+" <br>Greetings from DEI Conference Management Toolkit! <br><br>You have been invited as an Invited Speaker to present your paper. Please visit the link below to set up your account password and then submit your paper for the Invited Talk. <br><br><a href='"+(getAppUrl() || "")+"/invited-user/password-update/"+encodeURIComponent(email)+"?token="+inviteToken+"'>Set up your account</a> <br><br>This link is valid for 24 hours.<br><br>Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit").catch((mailErr) => console.error("Invitee setup email failed:", mailErr));
        return res.redirect("/chair/dashboard/invited-talks/"+conference_id+"?message=Succesfully Added Invitee. Instructions to set up account has been sent to Invitee via Email.");

    }
    


  } catch (err) {
    console.error("Error adding invitee:", err);
    return res.redirect(`/chair/dashboard/invited-talks/${conference_id}?message=Error adding invitee.`);
  }


});


app.get("/invited-user/password-update/:email",async(req,res)=>{

  const email = req.params.email;
  const token = req.query.token || "";

  const tokenResult = await pool.query('select 1 from password_resets where email=$1 and token=$2 and expires_at > NOW()',[email,hashToken(token)]);
  if (tokenResult.rows.length === 0) {
    return res.redirect("/?message=Not Eligible!");
  }

  const result = await pool.query('select * from users where email=$1 and password=$2',[email,"Invited User"]);

     if (result.rows.length === 0) {
      return res.redirect("/?message=Not Eligible!");
    }

    else{

       res.render("invited-user-password-update.ejs", {
      user: email,
      token: token
    });

    }

})

app.post("/update-invited-user-password", authRateLimitMemory, async(req,res)=>{

  const { email, password, token } = req.body;

  const tokenResult = await pool.query("select 1 from password_resets where email=$1 and token=$2 and expires_at > NOW()",[email,hashToken(token || "")]);
  if (tokenResult.rows.length === 0) {
    return res.redirect("/login/user?message=Your password setup link is invalid or has expired.");
  }

  const hashed_password = await bcrypt.hash(password, 10);

  const result = await pool.query("update users set password = $1 where email = $2 and password = $3",[hashed_password,email,"Invited User"]);

  await pool.query("DELETE FROM password_resets WHERE email = $1",[email]);

  if(result.rowCount){
    return res.redirect("/login/user?message=Password for your account has been updated. Please login with the login credentials.");
  }
  return res.redirect("/login/user?message=Your password setup link is invalid or has expired.");

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
      // Authorization: only reviewers assigned to this paper's track may review it
      if (!(await isTrackReviewer(req.user.email, submissionData.track_id))) {
        return res.redirect("/reviewer/dashboard?message=You are not assigned as a reviewer for this submission.");
      }

    //
    // 3. Insert review into peer_review
    //
    if (![originality_score, relevance_score, technical_quality_score, clarity_score, impact_score].every((s) => Number.isFinite(parseFloat(s)))) {
      return res.redirect("/reviewer/dashboard?message=All review scores must be valid numbers.");
    }
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
    // 5. If revision required → insert record for revision
    //
    // if (status === "Revision Required") {
    //   await pool.query(
    //     `INSERT INTO revised_submissions (submission_id) 
    //      VALUES ($1) ON CONFLICT DO NOTHING;`,
    //     [submission_id]
    //   );
    // }

    return res.redirect("/dashboard?message=Submission has been successfully marked as reviewed.");

  } catch (err) {
    console.error("Mark-as-reviewed error:", err);
    return res.redirect("/reviewer/dashboard?message=We are facing some issues in marking this submission as reviewed.");
  }
});

// ...existing code...
// ---------- Tracks (top-level groups of subject areas) ----------
function manageTracksUrl(conferenceId, message) {
  return "/chair/dashboard/manage-tracks/" + conferenceId + "?message=" + encodeURIComponent(message);
}

app.post("/chair/dashboard/create-group/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  const groupName = String(req.body.group_name || "").trim();
  if (!groupName) return res.redirect(manageTracksUrl(req.params.id, "Track name cannot be empty."));
  const dup = await pool.query("select 1 from conference_groups where conference_id = $1 and group_name = $2", [req.params.id, groupName]);
  if (dup.rows.length) return res.redirect(manageTracksUrl(req.params.id, "A track with this name already exists in this conference."));
  await pool.query("insert into conference_groups (conference_id, group_name) values ($1, $2)", [req.params.id, groupName]);
  return res.redirect(manageTracksUrl(req.params.id, "Track created."));
});

app.post("/chair/dashboard/update-group/:groupId", checkChairAuth, async (req, res) => {
  const owner = await pool.query("select conference_id from conference_groups where group_id = $1", [req.params.groupId]);
  if (!owner.rows[0] || !(await chairOwnsConference(req.user.email, owner.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this track.");
  }
  const conferenceId = owner.rows[0].conference_id;
  const groupName = String(req.body.group_name || "").trim();
  if (!groupName) return res.redirect(manageTracksUrl(conferenceId, "Track name cannot be empty."));
  const dup = await pool.query("select 1 from conference_groups where conference_id = $1 and group_name = $2 and group_id <> $3", [conferenceId, groupName, req.params.groupId]);
  if (dup.rows.length) return res.redirect(manageTracksUrl(conferenceId, "A track with this name already exists in this conference."));
  await pool.query("update conference_groups set group_name = $1 where group_id = $2", [groupName, req.params.groupId]);
  return res.redirect(manageTracksUrl(conferenceId, "Track updated."));
});

app.post("/chair/dashboard/delete-group/:groupId", checkChairAuth, async (req, res) => {
  const owner = await pool.query("select conference_id from conference_groups where group_id = $1", [req.params.groupId]);
  if (!owner.rows[0] || !(await chairOwnsConference(req.user.email, owner.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to delete this track.");
  }
  const conferenceId = owner.rows[0].conference_id;
  const subjects = await pool.query("select 1 from conference_tracks where group_id = $1 limit 1", [req.params.groupId]);
  if (subjects.rows.length) return res.redirect(manageTracksUrl(conferenceId, "This track still has subject areas and cannot be deleted."));
  await pool.query("delete from conference_groups where group_id = $1", [req.params.groupId]);
  return res.redirect(manageTracksUrl(conferenceId, "Track deleted."));
});

app.post("/create-track/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  try {
    const {
      track_title,
      reviewers,
      session_date,
      session_start_time,
      session_end_time,
      session_chairs,
      group_id
    } = req.body;

    const normalizeEmails = (value) => {
      if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
      return String(value || "")
        .split(",")
        .map(v => v.trim())
        .filter(Boolean);
    };

    const reviewersArray = normalizeEmails(reviewers);
    const sessionChairsArray = normalizeEmails(session_chairs);

    const subjectName = String(track_title || "").trim();
    if (!subjectName) return res.redirect(manageTracksUrl(req.params.id, "Subject area name cannot be empty."));
    const trackGroupId = String(group_id || "").trim() || null;
    if (trackGroupId) {
      const groupOwned = await pool.query("select 1 from conference_groups where group_id = $1 and conference_id = $2", [trackGroupId, req.params.id]);
      if (groupOwned.rows.length === 0) return res.redirect(manageTracksUrl(req.params.id, "The selected track does not belong to this conference."));
    }
    const duplicateSubject = await pool.query("select 1 from conference_tracks where conference_id = $1 and track_name = $2 and group_id is not distinct from $3", [req.params.id, subjectName, trackGroupId]);
    if (duplicateSubject.rows.length) return res.redirect(manageTracksUrl(req.params.id, "A subject area with this name already exists in this track."));

    await pool.query(
      `INSERT INTO conference_tracks
       (track_name, track_reviewers, presentation_date, presentation_start_time, presentation_end_time, panelists, conference_id, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        subjectName,
        reviewersArray,
        session_date,
        session_start_time,
        session_end_time,
        sessionChairsArray,
        req.params.id,
        trackGroupId
      ]
    );


    for (const reviewerEmail of reviewersArray) {

    await pool.query("insert into conference_roles values($1, $2, $3)",[req.params.id, reviewerEmail, "reviewer"]);

      await sendMail(
        reviewerEmail,"Reviewer Role Assigned",null,
        
        "Hi,<br><br> You have assigned as a reviewer for a conference at the DEI CMT. If you do not have an account on the portal, please visit https://cmt.gurumaujsatsangi.in/registration/user to create one else login using the credentials. <br><br>Incase of any technical assistance,please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit"
      );
    }

    for (const chairEmail of sessionChairsArray) {

      await pool.query("insert into conference_roles values ($1,$2,$3)",[req.params.id,chairEmail,"session_chair"]);
      await sendMail(
        chairEmail,
        "Session Chair Role Assigned",null,
        
        "Hi, <br><br>You have assigned as a Session Chair for a conference at the DEI CMT. If you do not have an account on the portal, please visit https://cmt.gurumaujsatsangi.in/registration/user to create one else login using the credentials. <br><br>Incase of any technical assistance,please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit"
      );
    }


    return res.redirect("/chair/dashboard?message=Track Added Succesfully!");
  } catch (err) {
    console.error("create-track error:", err);
    return res.redirect("/chair/dashboard?message=Error creating track.");
  }
});
// ...existing code...

app.get("/meta-reviewer/dashboard/:id",checkAuth,async(req,res)=>{

  const conference_id = req.params.id;

  const assigned_tracks = await pool.query("select * from conference_tracks where meta_reviewer=$1 and conference_id = $2",[req.user.email,conference_id]);


    const cache_data = redisClient ? await redisClient.get("meta_reviewer_"+req.user.email+"_conference_id") : null;

    if(cache_data){
      console.log("Conference ID already present in cache.");
    }
    else{

      if (redisClient) await redisClient.set("meta_reviewer_"+req.user.email+"_conference_id",JSON.stringify(conference_id));
      
    }

  const data = await pool.query("select submission_id from submissions where track_id = $1",[assigned_tracks.rows[0]?.track_id]);
  const peer_review = await pool.query("select * from peer_review where conference_id = $1",[conference_id]);


  

  return res.render("meta-reviewer.ejs",{peer_review: peer_review.rows,assigned_tracks:assigned_tracks.rows});

})

app.get("/meta-reviewer/dashboard/recommendation-submission/:id",checkAuth,async(req,res)=>{

  const submission_id = req.params.id;

  const peer_review = await pool.query("select * from peer_review where submission_id = $1",[submission_id]);

  return res.render("meta-reviewer-form.ejs",{peer_review:peer_review.rows,submission_id});

})

app.post("/submit-meta-reviewer-decision/:id",checkAuth,async(req,res)=>{

  // Authorization: only the meta-reviewer assigned to this submission's track may submit a decision
  const metaCheck = await pool.query(
    "select 1 from submissions s join conference_tracks t on t.track_id = s.track_id where s.submission_id = $1 and t.meta_reviewer = $2 limit 1",
    [req.params.id, req.user.email]
  );
  if (metaCheck.rows.length === 0) {
    return res.redirect("/dashboard?message=You are not assigned as the meta-reviewer for this submission.");
  }

  const submission_id = req.params.id;

  // const conferenceid_cache = await redisClient.get("meta_reviewer_"+req.user.email+"_conference_id");


  const {status, remarks} = req.body;


  const data = await pool.query("insert into meta_reviewer_decision values($1,$2,$3)",[submission_id,status,remarks]);


if(data){
  return res.redirect("/dashboard?message=Meta-Reviewer recommendation successfully saved!");
}




})

app.post("/chair/dashboard/delete-track/:id", checkChairAuth,async(req,res)=>{
  const trackOwner = await pool.query("select conference_id from conference_tracks where track_id = $1", [req.params.id]);
  if (!trackOwner.rows[0] || !(await chairOwnsConference(req.user.email, trackOwner.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to delete this track.");
  }
  const linkedSubmissions = await pool.query("select 1 from submissions where track_id = $1 limit 1", [req.params.id]);
  if (linkedSubmissions.rows.length) return res.redirect(manageTracksUrl(trackOwner.rows[0].conference_id, "This subject area has submissions and cannot be deleted."));
  const result = await pool.query("delete from conference_tracks where track_id = $1",[req.params.id]);
  if(!result.rowCount){
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

    // Authorization: only a panelist assigned to this submission's track may mark it complete
    const panelistCheck = await pool.query(
      "select 1 from submissions s join conference_tracks t on t.track_id = s.track_id where s.submission_id = $1 and $2 = any(t.panelists) limit 1",
      [paper_id, req.user.email]
    );
    if (panelistCheck.rows.length === 0) {
      return res.render("error.ejs", {
        message: "You are not an assigned panelist for this submission.",
      });
    }

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
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }

  const conference = await fetchConference(req.params.id);
  const tracks = await pool.query("select * from conference_tracks where conference_id = $1",[req.params.id]);
  

  const groups = await pool.query("select group_id, group_name from conference_groups where conference_id = $1 order by group_name", [req.params.id]);
  return res.render("chair/manage-tracks",{tracks:tracks.rows,groups:groups.rows,conference:conference.rows[0]});


})

app.post("/send-email-alert", checkChairAuth, async(req,res)=>{

  const data = await pool.query("SELECT email FROM users WHERE email NOT IN ( SELECT primary_author FROM submissions);");
  console.log(data.rows[0]);
  return res.sendStatus(204);

})


app.post("/chair/dashboard/delete-conference/:id", checkChairAuth,async (req, res) => {


  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to delete this conference.");
  }

  const conferenceClient = await pool.connect();
  try {
    await conferenceClient.query("BEGIN");
    await conferenceClient.query(`DELETE FROM conference_tracks WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM conferences WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query("COMMIT");

    if (redisClient) await redisClient.del("conferences");
    res.redirect("/chair/dashboard?message=Conference Deleted Succesfully.");
  } catch (err) {
    await conferenceClient.query("ROLLBACK");
    console.error("Error deleting conference:", err);
    res.status(500).send("Error deleting conference.");
  } finally {
    conferenceClient.release();
  }
});



app.get("/submission/co-author/:id", checkAuth, async (req, res) => {

    const isReviewerResult = await isReviewer(req.user.email);
    const isSessionChairResult = await isSessionChair(req.user.email, req.params.id);
    const isInviteeResult = await isInvitee(req.user.email);

    if(isInviteeResult === true || isReviewerResult===true || isSessionChairResult===true){
      return res.redirect("/dashboard?message=Please note, Reviewers / Session Chairs / Invited Speakers are not allowed to submit papers. If you think this is an error, please reach out to us at multimedia@dei.ac.in.")
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

    // Fetch conference
    const conferenceResult = await pool.query(
      `SELECT * FROM conferences WHERE conference_id = $1 LIMIT 1;`,
      [req.params.id]
    );

    const conferenceRaw = conferenceResult.rows[0];


    const currentDate = getCurrentDateIST();
      const deadline = formatDateISO(conferenceRaw.full_paper_submission);

      // Check if current date is AFTER the deadline (not on the deadline day)
      if (!deadline || currentDate > deadline) {
        return res.redirect("/dashboard?message=The full paper submission deadline has passed.");
      }

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
       WHERE submission_id = $1 AND co_author = $2 AND status!=$3
       LIMIT 1;`,
      [submission.submission_id, req.user.email,"Rejected"]
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
         <p>A co-author has requested to join your paper titled <strong>"${escapeHtml(submission.title)}"</strong>.</p>
         <p><strong>Co-Author Email:</strong> ${escapeHtml(req.user.email)}</p>
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

    if (coAuthorRequest.status !== "Pending") {
      return res.redirect("/dashboard?message=This co-author request is no longer pending.");
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
   await sendMail(coAuthorRequest.co_author,"Co-Author Request Approved | "+submission.title,null,"Dear Author, <br><br>your request to join the paper titled "+ escapeHtml(submission.title)+" has been approved by the Primary Author. The submission will now be available on your Dashboard under the My Submissions section. <br><br>Incase of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit",submission.primary_author);

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

    if (coAuthorRequest.status !== "Pending") {
      return res.redirect("/dashboard?message=This co-author request is no longer pending.");
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
       await sendMail(coAuthorRequest.co_author,"Co-Author Request Rejected | "+submission.title,null,"Dear Author, <br><br>your request to join the paper titled "+ escapeHtml(submission.title)+" has been rejected by the Primary Author. If you think this was an error, please speak to the Primary Author. <br><br>Incase of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit",submission.primary_author);


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
    co_chairs,
    communication
  } = req.body;

  try {
    // 1. Insert conference and return row
    const confResult = await pool.query(
      `INSERT INTO conferences
      (title, description, conference_start_date, conference_end_date, full_paper_submission, acceptance_notification, camera_ready_paper_submission,deadline_peer_review,co_chairs,created_by,communication)
      VALUES ($1, $2, $3, $4, $5, $6, $7,$8,array[$9],$10,array[$11])
      RETURNING conference_id;`,
      [
        title,
        sanitizeDescription(description),
        conference_start_date,
        conference_end_date,
        full_paper_submission,
        acceptance_notification,
        camera_ready_paper_submission,
        deadline_peer_review,
        co_chairs,
        req.user.email,
        communication
      ]
    );

    const conference_id = confResult.rows[0].conference_id;

    // 2. Insert poster session placeholder row
    await pool.query(
      `INSERT INTO poster_session (conference_id, date, start_time, end_time, coodinators)
       VALUES ($1, null, null, null, ARRAY[]::text[]);`,
      [conference_id]
    );



    if (redisClient) await redisClient.del("conferences");



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
    const isSessionChairResult = await isSessionChair(req.user.email, req.params.id);
    const isInviteeResult = await isInvitee(req.user.email);

    if(isInviteeResult === true || isReviewerResult===true || isSessionChairResult===true){
      return res.redirect("/dashboard?message=Please note, Reviewers / Session Chairs / Invited Speakers are not allowed to submit papers. If you think this is an error, please reach out to us at multimedia@dei.ac.in.")
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


     const currentDate = getCurrentDateIST();
      const deadline = formatDateISO(conferenceRaw.full_paper_submission);

      // Check if current date is AFTER the deadline (not on the deadline day)
      if (!deadline || currentDate > deadline) {
        return res.redirect("/dashboard?message=The full paper submission deadline has passed.");
      }

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

     const currentDate = getCurrentDateIST();
      const deadline = formatDateISO(conferenceRaw.full_paper_submission);

      // Check if current date is AFTER the deadline (not on the deadline day)
      if (!deadline || currentDate > deadline) {
        return res.redirect("/dashboard?message=The full paper submission deadline has passed.");
      }

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

    const isReviewerResult = await isReviewer(req.user.email);
    const isSessionChairResult = await isSessionChair(req.user.email, (await pool.query("select conference_id from submissions where submission_id = $1", [req.params.id])).rows[0]?.conference_id);
    const isInviteeResult = await isInvitee(req.user.email);

    if(isInviteeResult === true || isReviewerResult===true || isSessionChairResult===true){
      return res.redirect("/dashboard?message=Please note, Reviewers / Session Chairs / Invited Speakers are not allowed to submit papers. If you think this is an error, please reach out to us at multimedia@dei.ac.in.")
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
    if (submission.primary_author !== req.user.email && !(Array.isArray(submission.co_authors) && submission.co_authors.includes(req.user.email))) {
      return res.redirect("/dashboard?message=You are not authorized to view this submission.");
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
      `SELECT * FROM revised_submissions WHERE submission_id = $1;`,
      [req.params.id]
    );
    if (revisedResult.rows.length > 0) {
      revisedSubmissionData = revisedResult.rows;
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
    if (!conferenceInfo || !conferenceInfo.camera_ready_paper_submission) {
      return res.redirect("/dashboard?message=The camera-ready deadline is not configured for this conference.");
    }
    {
      const currentDate = getCurrentDateIST();
      const deadline = formatDateISO(conferenceInfo.camera_ready_paper_submission);

      // Check if current date is AFTER the deadline (not on the deadline day)
      if (!deadline || currentDate > deadline) {
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
    if(submission.submission_status === "Presentation Completed") {
      return res.redirect("/dashboard?message=You have already submitted your Final Camera Ready Paper and your Presentation is also over.")
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


app.get("/remarks/:id", checkAuth, async (req, res) => {

    const isReviewerResult = await isReviewer(req.user.email);
    const isSessionChairResult = await isSessionChair(req.user.email, (await pool.query("select conference_id from submissions where submission_id = $1", [req.params.id])).rows[0]?.conference_id);
    const isInviteeResult = await isInvitee(req.user.email);

    if(isInviteeResult === true || isReviewerResult===true || isSessionChairResult===true){
      return res.redirect("/dashboard?message=Please note, Reviewers / Session Chairs / Invited Speakers are not allowed to submit papers. If you think this is an error, please reach out to us at multimedia@dei.ac.in.")
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
    if (submission.primary_author !== req.user.email && !(Array.isArray(submission.co_authors) && submission.co_authors.includes(req.user.email))) {
      return res.redirect("/dashboard?message=You are not authorized to view this submission.");
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
      `SELECT * FROM revised_submissions WHERE submission_id = $1;`,
      [req.params.id]
    );
    if (revisedResult.rows.length > 0) {
      revisedSubmissionData = revisedResult.rows;
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
    if (!conferenceInfo || !conferenceInfo.camera_ready_paper_submission) {
      return res.redirect("/dashboard?message=The camera-ready deadline is not configured for this conference.");
    }
    {
      const currentDate = getCurrentDateIST();
      const deadline = formatDateISO(conferenceInfo.camera_ready_paper_submission);

      // Check if current date is AFTER the deadline (not on the deadline day)
      if (!deadline || currentDate > deadline) {
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
    if(submission.submission_status === "Presentation Completed") {
      return res.redirect("/dashboard?message=You have already submitted your Final Camera Ready Paper and your Presentation is also over.")
    }

    // 8. Render page
    res.render("remarks.ejs", {
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

      // Authorization: only the primary author of this submission (in this conference) may submit its camera-ready paper
      const finalOwnerResult = await pool.query(
        `SELECT primary_author, submission_status FROM submissions WHERE submission_id = $1 AND conference_id = $2 LIMIT 1;`,
        [id, confid]
      );
      const finalOwnerRow = finalOwnerResult.rows[0];
      if (!finalOwnerRow || finalOwnerRow.primary_author !== req.user.email) {
        return res.redirect("/dashboard?message=You are not authorized to submit a camera-ready paper for this submission.");
      }
      if (["Submitted for Review", "Rejected", "Submitted Final Camera Ready Paper", "Presentation Completed"].includes(finalOwnerRow.submission_status)) {
        return res.redirect("/dashboard?message=Camera-ready paper cannot be submitted at the current submission status.");
      }

      // 1. Verify camera-ready deadline
      try {
        const confResult = await pool.query(
          `SELECT camera_ready_paper_submission 
           FROM conferences 
           WHERE conference_id = $1 LIMIT 1;`,
          [confid]
        );

        const confRow = confResult.rows[0];

        if (!confRow || !confRow.camera_ready_paper_submission) {
          return res.redirect("/dashboard?message=The camera-ready deadline is not configured for this conference.");
        }
        {
          const currentDate = getCurrentDateIST();
          const deadline = formatDateISO(confRow.camera_ready_paper_submission);

          // Check if current date is AFTER the deadline (not on the deadline day)
          if (!deadline || currentDate > deadline) {
            return res.redirect("/dashboard?message=The camera-ready submission deadline has passed.");
          }
        }
      } catch (deadlineErr) {
        console.error("Deadline check error:", deadlineErr);
        return res.redirect("/dashboard?message=Unable to verify the camera-ready deadline. Please try again later.");
      }

      // 2. Upload to Cloudinary
      if (!isAllowedDocument(req.file)) {
        return res.redirect("/dashboard?message=Error: Only PDF, DOC and DOCX files are allowed.");
      }
      const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
        resource_type: "auto",
        folder: "submissions",
        public_id: `${req.user.user_id}-${Date.now()}-Final`,
      });

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


// app.get("/login" , async (req,res)=>{
//   res.render("login.ejs", {
//     message: req.query.message || null
//   });
// });

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
    var conferences;
    const data = redisClient ? redisClient.get(req.user.email+"_initiated_conferences") : null;
    if(data && data.length>0){
      const parsed_data =  JSON.parse(data);
      conferences = parsed_data.rows.map(conference => ({
      ...conference,
      conference_start_date: formatDate(conference.conference_start_date),
      conference_end_date: formatDate(conference.conference_end_date),
      full_paper_submission: formatDate(conference.full_paper_submission),
      acceptance_notification: formatDate(conference.acceptance_notification),
      camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission),
      deadline_peer_review:formatDate(conference.deadline_peer_review)
    }));

    } else{

      conferences = result.rows.map(conference => ({
      ...conference,
      conference_start_date: formatDate(conference.conference_start_date),
      conference_end_date: formatDate(conference.conference_end_date),
      full_paper_submission: formatDate(conference.full_paper_submission),
      acceptance_notification: formatDate(conference.acceptance_notification),
      camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission),
      deadline_peer_review:formatDate(conference.deadline_peer_review)
    }));

      const enter_data = redisClient ? redisClient.set(req.user.email+"_initiated_conferences",JSON.stringify(conferences)) : null;

    }

    
    

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
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
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


app.post("/chair/dashboard/update-conference/:id", checkChairAuth, async (req, res) => {
  const conferenceId = req.params.id;

  if (!(await chairOwnsConference(req.user.email, conferenceId))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to modify this conference.");
  }

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
        sanitizeDescription(description),
        conference_start_date,
        conference_end_date,
        full_paper_submission,
        acceptance_notification,
        camera_ready_paper_submission,
        conferenceId
      ]
    );


    if (redisClient) await redisClient.del("conferences");
  return res.redirect("/chair/dashboard?message=Conference Updated Successfully!");

  } catch (err) {
    console.error("Update conference error:", err);
    return res.status(500).send("Error updating conference.");
  }
});

app.get("/chair/dashboard/resolve-re-review-conflicts/:id",checkChairAuth,async(req,res)=>{

  const submission_id = req.params.id;
  const submission = await pool.query("select * from submissions where submission_id=$1 and submission_status=$2",[submission_id,'Submitted Revised Paper']);

  if(!submission || submission.rows.length==0){
    return res.redirect("/chair/dashboard?message=Chair has already submitted the Final Decision for this Submission");
  }

  const re_reviews = await pool.query("select * from revised_submissions where submission_id=$1",[submission_id]);

  if(re_reviews){
    return res.render("chair/re-review-conflicts.ejs",{re_reviews:re_reviews.rows,submission:submission.rows[0]});
  }

})

app.get("/chair/dashboard/resolve-conflicts/:id", checkChairAuth, async (req, res) => {
  try {
    const submission_id = req.params.id;

    // 1. Fetch the submission once
    const result = await pool.query(
      "SELECT * FROM submissions WHERE submission_id = $1", 
      [submission_id]
    );

    // 2. Check if it exists at all
    if (result.rows.length === 0) {
      return res.redirect("/chair/dashboard?message=Submission not found!");
    }

    const currentData = result.rows[0];
    const status = currentData.submission_status;

    // 3. Define a base payload with null fallbacks so the EJS template doesn't crash
    const renderPayload = {
      submission: null,
      submission2: null,
      reviews: null,
      meta_reviewer:null,
      re_reviews: null
    };

    // 4. Handle based on the specific status
    if (status === 'Submitted for Review') {
        const reviews = await pool.query(
          "SELECT * FROM peer_review WHERE submission_id = $1", 
          [submission_id]
        );

        const meta_reviewer = await pool.query("select * from meta_reviewer_decision where submission_id=$1",[submission_id]);
        
        renderPayload.submission = currentData;
        renderPayload.reviews = reviews.rows;
        renderPayload.meta_reviewer = meta_reviewer.rows;
        
        return res.render("chair/resolve-conflicts.ejs", renderPayload);

    } else if (status === 'Submitted Revised Paper') {
        const re_reviews = await pool.query(
          "SELECT * FROM revised_submissions WHERE submission_id = $1", 
          [submission_id]
        );

                const meta_reviewer = await pool.query("select * from meta_reviewer_decision where submission_id=$1",[submission_id]);

        
        renderPayload.submission2 = currentData;
        renderPayload.re_reviews = re_reviews.rows;
                renderPayload.meta_reviewer = meta_reviewer.rows;

        
        return res.render("chair/resolve-conflicts.ejs", renderPayload);

    } else {
        // 5. If it's neither of the above statuses, a decision was likely already made
        return res.redirect("/chair/dashboard?message=Chair has already submitted the Final Decision for this Submission!");
    }

  } catch (error) {
    // 6. Catch any database errors
    console.error("Error fetching conflict resolution data:", error);
    return res.status(500).send("Internal Server Error");
  }
});

app.post("/resolve-conflict/:id/:conf_id",checkChairAuth,async(req,res)=>{

  const {final_remarks, status} = req.body;

  const conference_id = req.params.conf_id;

  const submission_id = req.params.id;

  const submission = await pool.query("update submissions set remarks=$1, submission_status=$2 where submission_id=$3",[final_remarks,status,submission_id]);

  if(submission.rowCount){
    return res.redirect("/chair/dashboard/view-submissions/"+conference_id+"?message=Submission Updated Succesfully!");
  }
  return res.redirect("/chair/dashboard?message=Submission not found.");



})


app.get("/chair/dashboard/view-submissions/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
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


    // const revised_submissions = await pool.query("select * from revised_submissions where conference_id=$1",[req.params.id]);

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

    // Fetch all review details for each submission
    for (let s of submissionsWithTracks) {
      const reviewResult = await pool.query(
        `SELECT reviewer, mean_score, remarks 
         FROM peer_review 
         WHERE submission_id = $1;`,
        [s.submission_id]
      );

      // Initialize an array to hold all reviews for this submission
      s.reviews = [];

      if (reviewResult.rows.length > 0) {
        // Map through all returned review rows
        for (let r of reviewResult.rows) {
          let reviewerName = r.reviewer;

          // Fetch the name for each specific reviewer
          if (r.reviewer) {
            const reviewerNameResult = await pool.query(
              `SELECT name FROM users WHERE email = $1 LIMIT 1;`,
              [r.reviewer]
            );
            if (reviewerNameResult.rows.length > 0) {
              reviewerName = reviewerNameResult.rows[0].name;
            }
          }

          // Push the formatted review object into the array
          s.reviews.push({
            email: r.reviewer,
            name: reviewerName,
            mean_score: r.mean_score !== null ? parseFloat(r.mean_score).toFixed(2) : null,
            remarks: r.remarks
          });
        }
      }
    }

    const uniqueStatuses = [...new Set(submissions.map(sub => sub.submission_status))];

    // if(revised_submissions.rows){

    //   res.render("chair/view-submissions.ejs", {
    //   user: req.user,
    //   submissions: submissionsWithTracks,
    //   tracks,
    //   uniqueStatuses,
    //   conferencedata: req.params.id,
    //   confdata,
    //   message: req.query.message || "There are Re-Review Conflicts that have to be resolved. Please set the 'Status' filter to 'Submitted Revised Paper' to view such submissions.",
    // })
      
    // }

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


app.post('/chair/dashboard/delete-submission/:id', checkChairAuth, async (req, res) => {
  
  const submissionId = req.params.id;
  const conferenceId = req.query.conference_id;

  console.log('Delete submission request:', { submissionId, conferenceId, query: req.query });

  if (!conferenceId) {
    console.error('Conference ID is missing');
    return res.redirect('/chair/dashboard?message=Error: Conference ID is required.');
  }


  const submission = await deleteClient.query("select submission_status, conference_id from submissions where submission_id=$1",[submissionId]);

  if (!submission.rows[0] || !(await chairOwnsConference(req.user.email, submission.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to delete this submission.");
  }

  if(submission.rows[0].submission_status!='Submitted for Review'){
    return res.redirect("/chair/dashboard?message=This submission cannot be deleted at the moment. Any submission can be deleted only when the submission status is 'Submitted for Review'. Current Submission Status: "+submission.rows[0].submission_status);
  }

  const deleteClient = await pool.connect();
  try {
    await deleteClient.query("BEGIN");
    // 1. Delete co-author requests
    await deleteClient.query(
      `DELETE FROM co_author_requests WHERE submission_id = $1;`,
      [submissionId]
    );

    // 2. Delete revised submissions
    await deleteClient.query(
      `DELETE FROM revised_submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    // 3. Delete related peer reviews
    await deleteClient.query(
      `DELETE FROM peer_review WHERE submission_id = $1;`,
      [submissionId]
    );

    // 4. Delete any final camera-ready submission entry
    await deleteClient.query(
      `DELETE FROM final_camera_ready_submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    // 5. Delete submission itself
    await deleteClient.query(
      `DELETE FROM submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    await deleteClient.query("COMMIT");
    console.log('Submission deleted successfully:', submissionId);
    return res.redirect(
      `/chair/dashboard/view-submissions/${conferenceId}?message=Submission deleted successfully.`
    );

  } catch (err) {
    await deleteClient.query("ROLLBACK");
    console.error('Error deleting submission:', err);
    return res.redirect(
      `/chair/dashboard/view-submissions/${conferenceId}?message=Error deleting submission.`
    );
  } finally {
    deleteClient.release();
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
        if (!isAllowedDocument(req.file)) {
          return res.redirect("/dashboard?message=Error: Only PDF, DOC and DOCX files are allowed.");
        }
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
          resource_type: "auto",
          folder: "revised_submissions",
          public_id: `${req.user.name}-${submission_id}-${Date.now()}`,
        });

        // //
        // // 4. Update revised_submissions file_url
        // //
        // await pool.query(
        //   `UPDATE revised_submissions SET file_url = $1 WHERE submission_id = $2`,
        //   [uploadResult.secure_url, submission_id]
        // );

        //
        // 5. Update submissions status + file_url
        //
        await pool.query(
          `UPDATE submissions SET submission_status = 'Submitted Revised Paper', file_url = $1 WHERE submission_id = $2`,
          [uploadResult.secure_url, submission_id]
        );

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

      // Authorization: only the primary author or a co-author may edit this submission
      const editOwnerResult = await pool.query(
        `SELECT primary_author, co_authors, submission_status, conference_id FROM submissions WHERE submission_id = $1 LIMIT 1;`,
        [id]
      );
      const editRow = editOwnerResult.rows[0];
      if (!editRow || (editRow.primary_author !== req.user.email && !(Array.isArray(editRow.co_authors) && editRow.co_authors.includes(req.user.email)))) {
        return res.redirect("/dashboard?message=You can only edit your own submissions.");
      }
      if (editRow.submission_status !== "Submitted for Review") {
        return res.redirect("/dashboard?message=Papers can only be edited when status is Submitted for Review.");
      }

      // Deadline (same full-paper deadline enforced by the submission pages); fail closed
      const editConfResult = await pool.query(
        `SELECT full_paper_submission FROM conferences WHERE conference_id = $1 LIMIT 1;`,
        [editRow.conference_id]
      );
      if (!editConfResult.rows[0] || deadlineClosed(editConfResult.rows[0].full_paper_submission)) {
        return res.redirect("/dashboard?message=The full paper submission deadline has passed.");
      }

      // Track must belong to the submission's conference
      if (areas && areas !== "undefined" && areas !== "") {
        const editTrackResult = await pool.query(
          `SELECT 1 FROM conference_tracks WHERE track_id = $1 AND conference_id = $2 LIMIT 1;`,
          [areas, editRow.conference_id]
        );
        if (editTrackResult.rows.length === 0) {
          return res.redirect("/dashboard?message=Invalid track selection for the chosen conference.");
        }
      }
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
        if (!isAllowedDocument(req.file)) {
          return res.redirect("/dashboard?message=Error: Only PDF, DOC and DOCX files are allowed.");
        }
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
          resource_type: "auto",
          folder: "submissions",
          public_id: `${req.user.user_id}-${Date.now()}`,
        });

        updateFields.push(`file_url = $${index++}`);
        updateValues.push(uploadResult.secure_url);
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


app.post("/submission/delete/primary-author/:id", checkAuth, async (req, res) => {


  try {
    // Authorization: only the primary author may delete, and only while the paper is awaiting review
    const ownerResult = await pool.query(
      `SELECT primary_author, submission_status FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const ownerRow = ownerResult.rows[0];
    if (!ownerRow || ownerRow.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=You are not authorized to delete this submission.");
    }
    if (ownerRow.submission_status !== "Submitted for Review") {
      return res.redirect("/dashboard?message=This submission cannot be deleted at its current status.");
    }

    const conference = await pool.query(
      `DELETE FROM submissions WHERE submission_id = $1 AND primary_author = $2 returning conference_id;`,
      [req.params.id, req.user.email]
    );

    if (redisClient && conference.rows[0]) await redisClient.del(req.user.email+"_submissions_conference_"+conference.rows[0].conference_id);

    return res.redirect("/dashboard?message=Submission deleted Successfully!");
  } catch (err) {
    console.error("Error deleting submission:", err);
    return res.redirect("/dashboard?message=Error deleting submission.");
  }
});

app.post("/submission/delete/invitee/:id", checkAuth, async (req, res) => {


  try {
    await pool.query(
      `DELETE FROM invited_talk_submissions WHERE paper_id = $1 AND invitee_email = $2`,
      [req.params.id, req.user.email]
    );

    return res.redirect("/dashboard?message=Submission deleted successfully!");
  } catch (err) {
    console.error("Error deleting invited talk submission:", err);
    return res.redirect("/?message=Error deleting submission.");
  }
});

app.post("/submit", checkAuth, async (req, res) => {
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

      if (!title || !abstract || !areas || !id) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("All fields are required: Title, Abstract, Area and Conference."));
      }

      if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("Upload service is not configured. Please contact the administrator."));
      }

      // Track Validation
      const trackCheck = await pool.query(
        `SELECT 1 FROM conference_tracks WHERE track_id = $1 AND conference_id = $2 LIMIT 1;`,
        [areas, id]
      );
      if (trackCheck.rows.length === 0) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("Invalid track selection for the chosen conference."));
      }

      // Deadline (same full-paper deadline enforced by the submission page); fail closed
      const submitConfResult = await pool.query(`SELECT full_paper_submission FROM conferences WHERE conference_id = $1 LIMIT 1;`, [id]);
      if (!submitConfResult.rows[0] || deadlineClosed(submitConfResult.rows[0].full_paper_submission)) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("The full paper submission deadline has passed."));
      }

      // Cloudinary Upload
      if (!isAllowedDocument(req.file)) {
        return res.redirect("/dashboard?message=Error: Only PDF, DOC and DOCX files are allowed.");
      }
      const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
        resource_type: "auto",
        folder: "submissions",
        public_id: `${(req.user && (req.user.user_id || req.user.email)) || "user"}-${Date.now()}`,
      });

      // --- FIXED: Thread-safe Unique Paper Code Generation via Redis Sets ---
      let paperCode;
      let isUnique = false;
      for (let attempt = 0; !isUnique; attempt++) {
        if (attempt >= 20) throw new Error("Could not allocate a unique paper code");
        paperCode = generator.generate({ length: 6, numbers: true });
        // SADD adds to a Set and returns 1 if element is new, or 0 if it already exists
        const addedCount = redisClient
          ? await redisClient.sAdd("paper_codes_set", paperCode)
          : ((await pool.query("select 1 from submissions where paper_code = $1 limit 1", [paperCode])).rows.length === 0 ? 1 : 0);
        if (addedCount === 1) {
          isUnique = true;
        }
      }
      console.log(`Generated and safely saved unique code: ${paperCode}`);

      // PDF & AI Text Parsing
      const parser = new PDFParse({ url: uploadResult.secure_url });
      const result = await Promise.race([
        parser.getText(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("PDF parsing timed out")), 20000)),
      ]);
      const aidetection = detectAIText(result.text);
      const confidence = getConfidenceScore(result.text);

      // Insert into PostgreSQL
      let submission_result;
      for (let insertAttempt = 1; ; insertAttempt++) {
      try {
      submission_result = await pool.query(
        `INSERT INTO submissions 
         (conference_id, primary_author, title, abstract, track_id, file_url, paper_code, ai_score, is_ai)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *;`,
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
      break;
      } catch (insertErr) {
        if (insertErr.code !== "23505" || insertAttempt >= 5) throw insertErr;
        paperCode = generator.generate({ length: 6, numbers: true });
      }
      }

      const conference_data = await pool.query("select * from conferences where conference_id=$1", [id]); 
      console.log("ADDED TO DB!");

      // --- FIXED: Consistent User Submissions Cache handling ---
      const cacheKey = `${req.user.email}_submissions_conference_${id}`;
      const newSubmissionItem = submission_result.rows[0];

      const cacheSubmissions = await getJsonCacheValue(cacheKey);

      if (cacheSubmissions) {
        // If cache exists, parse it, push item, rewrite string
        const submissionsArray = cacheSubmissions;
        submissionsArray.push(newSubmissionItem);
        if (redisClient) {
          await redisClient.set(cacheKey, JSON.stringify(submissionsArray), { EX: 3600 });
        }
      } else {
        // If cache is empty, seed a brand new array containing the item
        if (redisClient) {
          await redisClient.set(cacheKey, JSON.stringify([newSubmissionItem]), { EX: 3600 });
        }
      }
      console.log("ADDED TO CACHE!");

      // Send Confirmation Email
      await sendMail(
        req.user.email,
        "Submission Created | " + title,
        null,
        `Hi, <br><br>Your paper titled <b>${escapeHtml(title)}</b> has been submitted successfully for <b>${escapeHtml(conference_data.rows[0].title)}</b> and will be reviewed by the Peer Reviewers soon. If your submission has any Co-Authors, please share the Paper Code (available on the Dashboard under 'My Submissions' section) with your Co-Authors. Once your Co-Authors try to join your submission using the Paper Code, you being the Primary Author will have to approve their requests from the Dashboard. You can check the status of your submission at the DEI CMT Dashboard. <br><br>In case of technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit`
      );

      return res.redirect("/dashboard?message=Paper Submitted Successfully, You can now share the Paper Code with your Co-Authors. Keep checking the status of your submission from the dashboard.");
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

      // Only invitees of this conference may submit an invited talk, and only before the deadline
      const inviteeCheckResult = await pool.query(
        `SELECT 1 FROM invitees WHERE conference_id = $1 AND email = $2 LIMIT 1;`,
        [conference_id, req.user.email]
      );
      if (inviteeCheckResult.rows.length === 0) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("We could not find your Email ID in the list of Invited Speakers."));
      }
      const inviteConfResult = await pool.query(
        `SELECT full_paper_submission FROM conferences WHERE conference_id = $1 LIMIT 1;`,
        [conference_id]
      );
      if (!inviteConfResult.rows[0] || deadlineClosed(inviteConfResult.rows[0].full_paper_submission)) {
        return res.redirect("/dashboard?message=" + encodeURIComponent("The full paper submission deadline has passed."));
      }

      if (!isAllowedDocument(req.file)) {
        return res.redirect("/dashboard?message=Error: Only PDF, DOC and DOCX files are allowed.");
      }
      const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
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



async function handleLogout(req, res) {

  try {

    // GET REFRESH TOKEN FROM COOKIE
    const refresh_token = req.cookies.refresh_token;

    // IF TOKEN EXISTS
    if (refresh_token) {

      // HASH TOKEN
      const hashed_refresh_token = crypto
        .createHash("sha256")
        .update(refresh_token)
        .digest("hex");

      // REVOKE SESSION
      await pool.query(
        `
        UPDATE sessions
        SET is_revoked = TRUE
        WHERE refresh_token_hash = $1
        `,
        [hashed_refresh_token]
      );

    }

    // ALSO REVOKE CHAIR REFRESH TOKEN IF PRESENT
    const chair_refresh_token = req.cookies.chair_refresh_token;
    if (chair_refresh_token) {
      const hashed_chair_refresh_token = crypto
        .createHash("sha256")
        .update(chair_refresh_token)
        .digest("hex");

      await pool.query(
        `
        UPDATE chair_sessions
        SET is_revoked = TRUE
        WHERE refresh_token_hash = $1
        `,
        [hashed_chair_refresh_token]
      );
    }

    // CLEAR COOKIES
    res.clearCookie("access_token");
    res.clearCookie("refresh_token");
    res.clearCookie("token");
    res.clearCookie("ChairToken");
    res.clearCookie("chair_access_token");
    res.clearCookie("chair_refresh_token");

    // REDIRECT
    return res.redirect("/login/user");

  } catch (err) {

    console.error(err);

    return res.status(500).send("Logout failed");

  }

}

app.post("/logout", handleLogout);



app.use(function(req, res) {
    res.status(404).render("error.ejs");
});

app.use((err, req, res, next) => {
  console.error("Unhandled application error:", err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).render("error.ejs");
});

if (process.env.VERCEL !== "1") {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export default app;

