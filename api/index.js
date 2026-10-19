import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { createClient } from 'redis';
import passport from "passport";
import { RedisStore } from "connect-redis";
import bcrypt from "bcrypt";
import pool from "../config/db.js";
import { sleep } from "../retry.js";
import passwordValidator from 'password-validator';
import generator from 'generate-password';
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
import * as canva from "../canva.js"
import ExcelJS from "exceljs";

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

// REL-07 (security-audit/COMPLETE_FINDINGS_REGISTER.md): previously nothing
// validated that required configuration was actually present at startup -
// a misconfigured deployment (e.g. both JWT_ACCESS_TOKEN_SECRET and
// JWT_SECRET unset) would start successfully and only fail later, per
// request, with a confusing runtime error the first time a token was
// signed/verified, rather than failing fast and clearly at boot.
// Skipped entirely under the test harness (SKIP_AUTOLISTEN=1), since test
// files deliberately set only the specific env vars each one needs, not
// the full production set, and skipped (logged, not fatal) outside
// NODE_ENV=production so local/dev setups with a partial .env still start
// - only a production boot is actually blocked, and never by printing the
// missing values themselves, only their names.
function validateRequiredEnv() {
  if (process.env.SKIP_AUTOLISTEN === "1") return;
  const required = ["DB_USER", "DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT"];
  const missing = required.filter((name) => !process.env[name]);
  if (!process.env.JWT_ACCESS_TOKEN_SECRET && !process.env.JWT_SECRET) missing.push("JWT_ACCESS_TOKEN_SECRET (or JWT_SECRET)");
  if (!process.env.JWT_REFRESH_TOKEN_SECRET && !process.env.JWT_SECRET) missing.push("JWT_REFRESH_TOKEN_SECRET (or JWT_SECRET)");
  if (missing.length === 0) return;

  console.error(`FATAL: missing required environment variable(s): ${missing.join(", ")}. See .env.example for the full list.`);
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}
validateRequiredEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
// FILE-01 (security-audit/COMPLETE_FINDINGS_REGISTER.md): previously any
// mimetype/extension was buffered into memory up to the 4MB cap before the
// app's own magic-byte check (isAllowedDocument) ran. This extension-level
// fileFilter rejects obviously-wrong uploads before they're buffered at
// all, as defense-in-depth alongside that existing content check (which
// still runs afterward and remains the authoritative check). Raised as a
// genuine multer.MulterError (with its message overridden) rather than a
// plain Error so it flows through the existing `err instanceof
// multer.MulterError` handling already present at every upload.single("file")
// call site, instead of silently leaving req.file undefined - which at
// least one call site (edit-submission) would otherwise misinterpret as
// "no new file was attached" rather than "a disallowed file was rejected".
function rejectDisallowedFileExtension(req, file, cb) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (![".pdf", ".docx", ".doc"].includes(ext)) {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "file");
    err.message = "Only PDF, DOC, and DOCX files are allowed.";
    return cb(err);
  }
  return cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB limit to match UI hint and handling
  fileFilter: rejectDisallowedFileExtension,
});

// Small deliberate pause between one bulk certificate generation and the
// next (see the enable-pdf-download route below) - each one is ~4+ Canva
// API calls, and Canva's published usage policy enforces a per-minute rate
// limit per user. This spreads a large batch's call volume out over time
// so it's less likely to approach that limit at all; canvaApiRequest's own
// retry-with-backoff (canva.js) is what actually guarantees recovery on
// the rare occasion it's hit anyway.
const CERTIFICATE_BATCH_PACING_MS = 400;

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

// FILE-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md): the paper itself
// (submissions.file_url / final_camera_ready_submissions.file_url) is
// uploaded with `type: "private"` (see the upload call sites below).
// A plain, un-signed URL to a private asset is correctly rejected - but
// verified directly against Cloudinary that the upload response's own
// `secure_url` is NOT such a plain URL: Cloudinary embeds a (non-expiring)
// signature in it automatically, so that stored value is itself a
// permanently-working link and must NEVER be sent to a browser or API
// response. The only value safe to expose is this function's own output:
// a signed, time-limited download link via Cloudinary's download API
// action (verified: a tampered or expired one is rejected with 401) -
// signed locally with the account's api_secret, no network call and no
// special account feature required - which the caller must only ever
// call AFTER its own role/ownership check has already authorized this
// specific viewer, the same as every other gated resource in this file.
// Returns null (not the row's stored, never-to-be-rendered file_url) when
// there's nothing to sign, so templates' existing `if (x.file_url)`
// guards keep working unchanged.
function getSignedPaperUrl(row, { expiresInSeconds = 600 } = {}) {
  if (!row || !row.file_public_id) return null;
  return cloudinary.utils.private_download_url(row.file_public_id, row.file_format || undefined, {
    resource_type: row.file_resource_type || "image",
    type: "private",
    attachment: false,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}

// Applied to every submissions/final_camera_ready_submissions row handed
// to a view, right before rendering - overwrites file_url with a fresh
// signed link (or null) rather than the permanent one still stored on the
// row itself.
function withSignedPaperUrl(row) {
  if (!row) return row;
  return { ...row, file_url: getSignedPaperUrl(row) };
}

// Certificates use a different Canva Brand Template per submission status /
// role (see /chair/dashboard/enable-pdf-download/:id and GET
// /admin/canva/dataset). Some of these are deliberately empty until their
// template is created in Canva - callers must check for that and skip,
// not assume every role is configured.
const CANVA_TEMPLATE_IDS = {
  poster: process.env.BRAND_TEMPLATE_ID_POSTER,
  paper: process.env.BRAND_TEMPLATE_ID_PAPER,
  reviewer: process.env.BRAND_TEMPLATE_ID_REVIEWER,
  session_chair: process.env.BRAND_TEMPLATE_ID_SESSION_CHAIR,
  invited_speaker: process.env.BRAND_TEMPLATE_ID_INVITED_SPEAKER,
};

// Field names in each connected Canva Brand Template's own dataset (see GET
// /admin/canva/dataset) - whatever the templates' placeholders are actually
// named. A field below that doesn't match a real dataset key is simply
// ignored by Canva's Autofill API, not an error, so these must be kept in
// sync with the templates by hand. Assumed to be the same field names
// across all five templates for now (confirmed for poster/paper; TBD for
// the other three once those templates exist).
const CANVA_CERTIFICATE_FIELDS = {
  name: "Name",
  conferenceTitle: "Conference Title",
  paperTitle: "Paper Title",
};

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

// conference_roles has no notion of WHICH subject area granted a role - it's
// just (conference_id, email, role). So when a chair edits a subject area's
// reviewer/session-chair list, a plain "replace the array" update (which is
// all conference_tracks.track_reviewers/panelists ever did) left this table
// completely out of sync: a newly added reviewer never got a role row (so
// their JWT never grants them "reviewer" and /reviewer/dashboard rejects
// them), and a removed reviewer kept their stale role row forever. These two
// helpers keep conference_roles in sync whenever a subject area's
// reviewer/session-chair list (or the subject area itself) changes.
//
// Grants `role` to `email` for `conferenceId` if they don't already have it.
// Returns true if this call is what granted it (so the caller knows whether
// to send a "Role Assigned" notification).
async function ensureConferenceRole(conferenceId, email, role) {
  const existing = await pool.query(
    "select 1 from conference_roles where conference_id = $1 and lower(email_id) = lower($2) and role = $3 limit 1",
    [conferenceId, email, role]
  );
  if (existing.rows.length > 0) return false;
  await pool.query("insert into conference_roles values($1,$2,$3)", [conferenceId, email, role]);
  return true;
}

// Revokes `role` from `email` for `conferenceId`, UNLESS some other subject
// area in the same conference (any track_id other than `excludeTrackId`)
// still lists them in `arrayColumn` (track_reviewers or panelists) - since
// that would mean they still legitimately hold this role via that other
// assignment. `arrayColumn` is always one of those two fixed, hardcoded
// strings (never request input), so building it into the query text is safe.
async function pruneConferenceRoleIfUnassigned(conferenceId, excludeTrackId, email, role, arrayColumn) {
  const stillAssignedElsewhere = await pool.query(
    `select 1 from conference_tracks
     where conference_id = $1 and track_id <> $2
       and exists (select 1 from unnest(${arrayColumn}) x where lower(x) = lower($3))
     limit 1`,
    [conferenceId, excludeTrackId, email]
  );
  if (stillAssignedElsewhere.rows.length > 0) return;
  await pool.query(
    "delete from conference_roles where conference_id = $1 and lower(email_id) = lower($2) and role = $3",
    [conferenceId, email, role]
  );
}

// Diffs an old vs new list of emails (case-insensitively) into what was
// added and what was removed.
function diffEmailLists(oldList, newList) {
  const oldLower = (oldList || []).map((e) => String(e).toLowerCase());
  const newLower = (newList || []).map((e) => String(e).toLowerCase());
  return {
    added: (newList || []).filter((e) => !oldLower.includes(String(e).toLowerCase())),
    removed: (oldList || []).filter((e) => !newLower.includes(String(e).toLowerCase())),
  };
}

// JWT-only role checks (no DB lookup): used to gate dashboards/pages whose
// authorization is coarse ("does this user hold this role anywhere / for this
// conference"). The roles claim is only as fresh as the access token - a role
// granted after the token was issued won't show up until the user logs out
// and back in (or the token naturally expires and refreshes). This is
// intentional: it keeps these checks off the database. Per-record decisions
// (which conference a chair owns, which track a reviewer is assigned to,
// etc.) still query the database, since the JWT has no room to safely encode
// that without becoming stale in the other, more dangerous direction.
function hasConferenceRole(user, conferenceId, role) {
  const roles = (user && user.roles && user.roles[conferenceId]) || [];
  return roles.includes(role);
}

function hasAnyConferenceRole(user, role) {
  const roles = (user && user.roles) || {};
  return Object.values(roles).some((list) => Array.isArray(list) && list.includes(role));
}

// Sequential, per-conference, human-facing paper number. Independent of the
// unique paper_code used for co-author linking. Allocation is atomic via an
// upsert on conference_paper_counters, so concurrent submissions to the same
// conference never collide.
async function nextPaperNumber(conferenceId) {
  const result = await pool.query(
    `INSERT INTO conference_paper_counters (conference_id, last_number)
     VALUES ($1, 1)
     ON CONFLICT (conference_id) DO UPDATE SET last_number = conference_paper_counters.last_number + 1
     RETURNING last_number`,
    [conferenceId]
  );
  return result.rows[0].last_number;
}

// Zero-padded to at least 4 digits (0001, 0002, ...); grows past 9999 instead
// of truncating once a conference passes that many submissions.
function formatPaperId(paperNumber) {
  return paperNumber == null ? null : String(paperNumber).padStart(4, "0");
}

// " | Paper ID: 0001", or "" when the submission has none (e.g. legacy rows
// from before this column existed, before the backfill migration runs).
function paperIdSubjectSuffix(paperNumber) {
  const paperId = formatPaperId(paperNumber);
  return paperId ? ` | Paper ID: ${paperId}` : "";
}

// Email salutation: always "Dear <name>," - never "Hi"/"Hello"/"Dear <name>!".
// Many role-assignment emails only have the recipient's email (entered by a
// chair), not their name, so this looks the account up when needed and falls
// back to "Dear User," only when no account/name exists yet.
async function getUserDisplayName(email) {
  if (!email) return null;
  const result = await pool.query(
    "select name from users where lower(email) = lower($1) limit 1",
    [email]
  );
  return result.rows[0]?.name || null;
}

function greeting(name) {
  return `Dear ${escapeHtml(name || "User")},`;
}

const ROLE_INVITATION_EMAILS = {
  reviewer: (name) => ({
    subject: `Invitation to Serve as a Reviewer – ${name}`,
    body:
      `Dear Sir/Ma'am,<br><br>` +
      `Greetings from the <b>${name}</b> Organizing Committee.<br><br>` +
      `We are pleased to inform you that you have been invited to serve as a <b>Reviewer</b> for ${name}.<br><br>` +
      `We highly value your academic expertise and experience, and we believe that your contribution to the review process will be instrumental in maintaining the quality and academic standards of the conference.<br><br>` +
      `We kindly request you to visit the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to create your account using this email address and access the reviewer facilities.<br><br>` +
      `We look forward to your valuable contribution to the conference and appreciate your willingness to support the academic review process.`,
  }),
  session_chair: (name) => ({
    subject: `Appointment as Session Chair – ${name}`,
    body:
      `Dear Sir/Ma'am,<br><br>` +
      `Greetings from the ${name} Organizing Committee.<br><br>` +
      `We are pleased to inform you that you have been appointed as a <b>Session Chair</b> for ${name}.<br><br>` +
      `Your role will be important in ensuring the smooth and effective conduct of the assigned session, facilitating academic discussions, managing the presentation schedule, and encouraging meaningful interaction between presenters and participants.<br><br>` +
      `We kindly request you to visit the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to create your account using this email address and access the reviewer facilities.<br><br>` +
      `Further information regarding the session schedule, assigned presentations, and other responsibilities will be communicated to you through the conference portal or by the organizing team.<br><br>` +
      `We look forward to your valuable contribution to the successful conduct of the conference.`,
  }),
  poster_presentation_coordinator: (name) => ({
    subject: `Appointment as Poster Presentation Coordinator – ${name}`,
    body:
      `Dear Sir/Ma'am,<br><br>` +
      `Greetings from the ${name} Organizing Committee.<br><br>` +
      `We are pleased to inform you that you have been appointed as the <b>Poster Presentation Coordinator</b> for ${name}.<br><br>` +
      `In this role, you will help coordinate the poster presentation sessions and facilitate the smooth conduct of poster presentations. Your responsibilities include communicating relevant instructions, managing presentation schedules and scoring the posters.<br><br>` +
      `We kindly request you to visit the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to create your account using this email address and access the reviewer facilities.<br><br>` +
      `Further details regarding the assigned sessions, schedules, and coordination responsibilities will be shared through the conference portal or by the organizing team.<br><br>` +
      `We look forward to your support and valuable contribution to the successful organization of the conference.`,
  }),
  meta_reviewer: (name) => ({
    subject: `Invitation to Serve as a Meta-Reviewer – ${name}`,
    body:
      `Dear Sir/Ma'am,<br><br>` +
      `Greetings from the ${name} Organizing Committee.<br><br>` +
      `We are pleased to inform you that you have been invited to serve as a <b>Meta-Reviewer</b> for ${name}.<br><br>` +
      `We highly value your academic expertise and experience, and we believe that your contribution will be valuable in ensuring a fair, consistent, and high-quality paper evaluation process.<br><br>` +
      `As a Meta-Reviewer, you will be expected to review the feedback provided by the assigned reviewers, assess their recommendations, and provide an overall evaluation to assist the conference committee in making informed decisions regarding paper acceptance.<br><br>` +
      `We kindly request you to visit the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to create your account using this email address and access the reviewer facilities.<br><br>` +
      `We look forward to your valuable contribution to maintaining the academic quality and integrity of the conference.`,
  }),
};

async function sendRoleInvitationEmail(email, role, conferenceId) {
  const conferenceRow = (await pool.query("select title from conferences where conference_id=$1", [conferenceId])).rows[0];
  const conferenceName = escapeHtml(conferenceRow?.title || "the conference");
  const { subject, body } = ROLE_INVITATION_EMAILS[role](conferenceName);
  return sendMail(email, subject, null, body);
}

function submissionDetailsBlock(label, items) {
  const rows = items
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `<li><b>${key}:</b> ${value}</li>`)
    .join("");
  return `<b>${label}</b><ul>${rows}</ul>`;
}

const SUBMISSION_LIFECYCLE_EMAILS = {
  submission_created: ({ conferenceName, authorName, title, paperId, paperCode }) => ({
    subject: `Submission Confirmation – ${paperId} | ${conferenceName}`,
    body:
      `${greeting(authorName)}<br><br>` +
      `Greetings from the ${conferenceName} Organizing Committee.<br><br>` +
      `This email is to confirm that your paper has been successfully submitted to ${conferenceName}. The details of your submission are provided below:<br><br>` +
      submissionDetailsBlock("Submission Details", [["Paper Title", title], ["Paper ID", paperId], ["Paper Code", paperCode]]) +
      `<br><br>Please retain these details for future reference. The Paper ID can be used to identify your submission, while the Paper Code can be shared with your co-authors to enable them to join the paper through the DEI CMT portal.<br><br>` +
      `You may log in to the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to view your submission details and track its progress.<br><br>` +
      `Please ensure that all the information provided in your submission is accurate and complete.<br><br>` +
      `We appreciate your interest in ${conferenceName} and look forward to your participation.`,
  }),
  submission_edited: ({ conferenceName, authorName, title, paperId, paperCode, updatedAt }) => ({
    subject: `Submission Updated Successfully – ${paperId} | ${conferenceName}`,
    body:
      `${greeting(authorName)}<br><br>` +
      `Greetings from the ${conferenceName} Organizing Committee.<br><br>` +
      `This email is to inform you that your submission has been successfully updated on the DEI CMT portal.<br><br>` +
      submissionDetailsBlock("Submission Details", [["Paper Title", title], ["Paper ID", paperId], ["Paper Code", paperCode], ["Last Updated On", updatedAt]]) +
      `<br><br>The latest changes have been saved successfully. You may log in to the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to review the updated submission details.<br><br>` +
      `Thank you for your continued engagement with ${conferenceName}.`,
  }),
  desk_review_decision: ({ conferenceName, authorName, title, paperId, decision, remarks }) => ({
    subject: `Desk Review Decision – ${paperId} | ${conferenceName}`,
    body:
      `${greeting(authorName)}<br><br>` +
      `Greetings from the ${conferenceName} Organizing Committee.<br><br>` +
      `We would like to inform you that the desk review of your submission has been completed. The decision and relevant details are provided below.<br><br>` +
      submissionDetailsBlock("Submission Details", [["Paper Title", title], ["Paper ID", paperId], ["Desk Review Decision", decision], ["Remarks", remarks]]) +
      `<br><br>Please log in to the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to view the complete decision and any instructions or actions required from your end.<br><br>` +
      `If revisions are requested, we kindly ask you to follow the instructions provided and adhere to the specified deadline, if applicable.`,
  }),
  peer_review_decision: ({ conferenceName, authorName, title, paperId, decision, reviewerComments }) => ({
    subject: `Peer Review Decision – ${paperId} | ${conferenceName}`,
    body:
      `${greeting(authorName)}<br><br>` +
      `Greetings from the ${conferenceName} Organizing Committee.<br><br>` +
      `We are writing to inform you that the peer review process for your submission to ${conferenceName} has been completed. The decision regarding your paper is provided below.<br><br>` +
      submissionDetailsBlock("Submission Details", [["Paper Title", title], ["Paper ID", paperId], ["Peer Review Decision", decision], ["Reviewer Comments", reviewerComments]]) +
      `<br><br>Please log in to the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to view the complete decision, reviewer feedback, and any further instructions.<br><br>` +
      `If your paper has been accepted subject to revisions, please carefully review the comments and submit the revised manuscript within the specified deadline. If your paper has been accepted, further instructions regarding presentation and other conference requirements will be communicated through the portal, as applicable.<br><br>` +
      `We appreciate your contribution to ${conferenceName} and thank you for your interest in the conference.`,
  }),
  certificate_available: ({ conferenceName, authorName, title, paperId, certificateType }) => ({
    subject: `Certificate for ${paperId} – ${conferenceName}`,
    body:
      `${greeting(authorName)}<br><br>` +
      `Greetings from the ${conferenceName} Organizing Committee.<br><br>` +
      `We are pleased to inform you that your certificate for ${conferenceName} is now available for download through the DEI CMT portal.<br><br>` +
      submissionDetailsBlock("Certificate Details", [["Paper Title", title], ["Paper ID", paperId], ["Certificate Type", certificateType]]) +
      `<br><br>You may log in to the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> and navigate to the relevant section to view and download your certificate.<br><br>` +
      `We appreciate your participation in ${conferenceName} and hope the conference has been a valuable academic experience for you.`,
  }),
};

// event-specific raw params are escaped here (except authorName, which
// greeting() already escapes) so every call site can pass plain DB values.
async function sendSubmissionLifecycleEmail(email, event, rawParams, cc) {
  const params = { authorName: rawParams.authorName };
  for (const [key, value] of Object.entries(rawParams)) {
    if (key === "authorName") continue;
    params[key] = typeof value === "string" ? escapeHtml(value) : value;
  }
  const { subject, body } = SUBMISSION_LIFECYCLE_EMAILS[event](params);
  return sendMail(email, subject, null, body, cc);
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

// NOTE: this app now deploys as a single persistent server process (no
// longer Vercel serverless - see Procfile), so this connects exactly once,
// for the life of that one process. The VERCEL env var name is legacy; it
// now just means "lightweight/test mode" (see test/authz.test.mjs and
// test/security-smoke.test.mjs, which set it to skip Redis and run without
// a database) and is never set in normal/dev/production operation.
if (process.env.VERCEL !== "1" && process.env.REDIS_HOST && process.env.REDIS_PORT) {
  const client = createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      // REL-04 (security-audit/PRODUCTION_RELIABILITY.md, "R4"): bounded,
      // explicit reconnection instead of relying on the client library's
      // own default - capped exponential backoff (max 3s between
      // attempts), and gives up for good after 10 attempts rather than
      // retrying forever. Every call site already guards with
      // `if (redisClient)` and its own try/catch (rate limiting, caching,
      // cooldowns all fall back to safe defaults), so once reconnection is
      // exhausted the app keeps running in that already-established
      // degraded mode rather than hammering a Redis that may be gone for
      // good.
      reconnectStrategy: (retries) => (retries > 10 ? false : Math.min(retries * 300, 3000)),
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
  // Same test-only reasoning as the global rate limiter above - see its
  // comment. This one is keyed by path+IP too, so concurrently-running
  // test files sharing 127.0.0.1 and the same real Redis can trip it just
  // as easily.
  if (process.env.SKIP_AUTOLISTEN === "1") {
    return next();
  }
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

// BL-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md): the bulk
// certificate-generation route, the three Excel-export routes, and the
// bulk email-alert route had no rate limiting beyond the blunt global
// per-IP limiter (which does nothing to stop one authenticated chair from
// repeatedly triggering an expensive operation on their own conference).
// This is deliberately per (operation, conference, account) rather than
// per-IP - the global limiter already covers the IP dimension, and keying
// on the account too means rotating source IPs doesn't help bypass it.
// Same bounded in-memory/Redis-fallback architecture as
// authRateLimitMemory above, reused rather than introducing a new
// mechanism.
const conferenceOpAttempts = new Map();
const CONFERENCE_OP_MAX_KEYS = 10000;
function conferenceOperationCooldown(operationName, cooldownSeconds) {
  return async function (req, res, next) {
    if (process.env.SKIP_AUTOLISTEN === "1") return next();

    const conferenceId = req.params.id || "unknown";
    const account = (req.user && req.user.email) || req.ip;
    const key = `conferenceop:${operationName}:${conferenceId}:${account}`;

    if (redisClient) {
      try {
        const setResult = await redisClient.set(key, "1", { NX: true, EX: cooldownSeconds });
        if (setResult === null) {
          return res.status(429).send("This operation was just run for this conference - please wait a few seconds and try again.");
        }
        return next();
      } catch (err) {
        console.warn("Conference operation cooldown: Redis unavailable, using in-memory fallback.", err.message);
      }
    }

    const now = Date.now();
    if (conferenceOpAttempts.size >= CONFERENCE_OP_MAX_KEYS) {
      for (const [k, resetAt] of conferenceOpAttempts) {
        if (resetAt <= now) conferenceOpAttempts.delete(k);
      }
      if (conferenceOpAttempts.size >= CONFERENCE_OP_MAX_KEYS) conferenceOpAttempts.clear();
    }
    const resetAt = conferenceOpAttempts.get(key);
    if (resetAt && resetAt > now) {
      return res.status(429).send("This operation was just run for this conference - please wait a few seconds and try again.");
    }
    conferenceOpAttempts.set(key, now + cooldownSeconds * 1000);
    return next();
  };
}

// Account lockout: 3 failed login attempts locks that account (not just that
// IP) out of logging in for 5 minutes. Separate from authRateLimitMemory
// above, which throttles total login *requests* per IP+route; this tracks
// *failures* per account, since the concern here is credential-stuffing /
// brute-forcing one specific account, which can come from many different
// IPs. Keyed by "scope" (user vs chair) + lowercased email, so the two
// separate credential stores never collide on the same email string.
const LOGIN_LOCKOUT_MAX_ATTEMPTS = 3;
const LOGIN_LOCKOUT_SECONDS = 5 * 60;
const loginAttemptsMemory = new Map(); // fallback when Redis is unavailable
const loginLockoutsMemory = new Map();

function loginLockoutKeys(scope, email) {
  const id = scope + ":" + String(email || "").trim().toLowerCase();
  return { failKey: "loginfail:" + id, lockKey: "loginlock:" + id };
}

// Returns the number of seconds left on this account's lockout (0 if it
// isn't locked), so the login page can show an accurate countdown rather
// than always assuming the full 5 minutes - the account may already be
// partway through its lockout when this is checked.
async function getLoginLockRemainingSeconds(scope, email) {
  const { lockKey } = loginLockoutKeys(scope, email);
  if (redisClient) {
    try {
      const ttl = await redisClient.ttl(lockKey);
      return ttl > 0 ? ttl : 0;
    } catch (err) {
      console.warn("Login lockout check: Redis unavailable, using in-memory fallback.", err.message);
    }
  }
  const entry = loginLockoutsMemory.get(lockKey);
  if (entry && entry.until > Date.now()) return Math.ceil((entry.until - Date.now()) / 1000);
  if (entry) loginLockoutsMemory.delete(lockKey);
  return 0;
}

// Call after a failed password check. Locks the account once the attempt
// count reaches LOGIN_LOCKOUT_MAX_ATTEMPTS. Returns the lockout's remaining
// seconds if this failure just triggered it, 0 otherwise.
async function recordFailedLogin(scope, email) {
  const { failKey, lockKey } = loginLockoutKeys(scope, email);
  if (redisClient) {
    try {
      const attempts = await redisClient.incr(failKey);
      if (attempts === 1) await redisClient.expire(failKey, LOGIN_LOCKOUT_SECONDS);
      if (attempts >= LOGIN_LOCKOUT_MAX_ATTEMPTS) {
        await redisClient.set(lockKey, "1", { EX: LOGIN_LOCKOUT_SECONDS });
        await redisClient.del(failKey);
        return LOGIN_LOCKOUT_SECONDS; // just got locked out
      }
      return 0;
    } catch (err) {
      console.warn("Login lockout record: Redis unavailable, using in-memory fallback.", err.message);
    }
  }
  const now = Date.now();
  let entry = loginAttemptsMemory.get(failKey);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + LOGIN_LOCKOUT_SECONDS * 1000 };
    loginAttemptsMemory.set(failKey, entry);
  }
  entry.count += 1;
  if (entry.count >= LOGIN_LOCKOUT_MAX_ATTEMPTS) {
    loginLockoutsMemory.set(lockKey, { until: now + LOGIN_LOCKOUT_SECONDS * 1000 });
    loginAttemptsMemory.delete(failKey);
    return LOGIN_LOCKOUT_SECONDS;
  }
  return 0;
}

// Redirect target for a locked-out login attempt. Carries the exact
// remaining seconds (not just a static message) so the login page can run a
// live, non-dismissable countdown - see partials/header copy.ejs.
function loginLockedRedirect(seconds) {
  return "/login/user?locked=1&seconds=" + encodeURIComponent(seconds);
}

// Call after a successful login, so a later unrelated failure doesn't
// inherit a stale attempt count.
async function clearLoginAttempts(scope, email) {
  const { failKey, lockKey } = loginLockoutKeys(scope, email);
  if (redisClient) {
    try {
      await redisClient.del(failKey);
      await redisClient.del(lockKey);
      return;
    } catch (err) {
      console.warn("Login lockout clear: Redis unavailable, using in-memory fallback.", err.message);
    }
  }
  loginAttemptsMemory.delete(failKey);
  loginLockoutsMemory.delete(lockKey);
}

// Global per-IP request limit (abuse/scraping backstop, not a precise
// per-user budget). Previously 50 req/60s - fine behind Vercel's
// per-invocation isolation, but this app is now a single persistent server
// serving everyone from one process, and the key is just the raw IP: anyone
// behind a shared IP (campus/office NAT, a mobile carrier, a VPN exit node)
// shares one budget across every one of their users. 50/min was easily
// exhausted by one active user, let alone several sharing an IP. Raised to
// a much more generous ceiling that still meaningfully blocks scripted
// abuse from a single address.
const MAX_ALLOWED_REQ = 300;
const MAX_TIME = 60;

// How long the "conferences" list and a user's "My Submissions" list stay
// cached before they expire on their own. Every mutation that changes this
// data already invalidates the relevant key immediately (see
// invalidateConferenceSubmissionCache and the "conferences" cache dels), so
// this TTL is a safety net, not the primary freshness mechanism - it just
// bounds how stale a read could ever be if some future code path forgets to
// invalidate. Kept short for that reason rather than the hour it used to be.
const DATA_CACHE_TTL_SECONDS = 300;





// Vercel is a single trusted proxy hop: only trust the last X-Forwarded-For entry it appends
app.set('trust proxy', 1);

app.use(async (req, res, next) => {
  // SKIP_AUTOLISTEN (test-only - see the module-level app.listen below) also
  // means this request is coming from one of many concurrently-running
  // test files, all of which appear as the same client IP (127.0.0.1) and
  // share the same real Redis instance. Without this, their combined
  // request volume routinely trips this limiter and fails unrelated tests
  // with a 429 - never a real concern in production, where SKIP_AUTOLISTEN
  // is never set.
  if (!redisClient || process.env.SKIP_AUTOLISTEN === "1") {
    return next();
  }

  try {
    const key = "reqrl:" + req.ip; // namespaced so it can't collide with any other key

    const request = await redisClient.incr(key);

    if (request === 1) {
      await redisClient.expire(key, MAX_TIME);
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









// REL-06 (security-audit/COMPLETE_FINDINGS_REGISTER.md): "/" is a
// deliberate liveness-only check (it catches its own DB errors and still
// returns 200 with an empty conference list, so the process stays "alive"
// even when the database is unreachable - that's its intended, unchanged
// behavior as documented in the Dockerfile). This is a separate readiness
// check: a lightweight `SELECT 1` that returns 503 if Postgres isn't
// reachable, so an orchestrator can tell "process is up" apart from
// "process can actually serve real requests" instead of routing traffic to
// a container that's alive but failing nearly everything. Redis is
// reported but never fails readiness - the app is designed to run without
// it (degraded, not down). No schema/query details are ever included in
// the response, only up/down booleans.
app.get("/healthz/ready", async (req, res) => {
  let dbReady = false;
  try {
    await pool.query("SELECT 1");
    dbReady = true;
  } catch (err) {
    console.error("Readiness check: database unreachable:", err.message);
  }

  let redisReady = false;
  if (redisClient) {
    try {
      await redisClient.ping();
      redisReady = true;
    } catch (err) {
      console.error("Readiness check: Redis unreachable:", err.message);
    }
  }

  const status = dbReady ? 200 : 503;
  return res.status(status).json({
    status: dbReady ? "ready" : "not ready",
    database: dbReady,
    redis: redisClient ? redisReady : "not configured",
  });
});

app.get("/reviewer/dashboard", checkAuth, async (req, res) => {
  if (!hasAnyConferenceRole(req.user, "reviewer")) {
    return res.redirect("/dashboard?message=Reviewer role not found in your current session. If a chair has just assigned you as a reviewer, please log out and log back in. If you think this is an error, please reach out to the conference chair.");
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
    const trackResult = await pool.query(`SELECT t.*, g.group_name AS track_group_name FROM conference_tracks t LEFT JOIN conference_groups g ON g.group_id = t.group_id`);
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
        "/?message=You are not authorized as a reviewer for any subject area."
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

    // Submissions this specific reviewer has already reviewed, so the
    // "Start Review" button can be hidden for them specifically (the status
    // column is shared across all reviewers of a track and must not be used
    // for this - see the submission_status fix in /mark-as-reviewed).
    const reviewedResult = await pool.query(
      "select submission_id from peer_review where lower(reviewer) = lower($1)",
      [req.user.email]
    );
    const reviewedSubmissionIds = new Set(reviewedResult.rows.map((r) => r.submission_id));

    // Fetch revised submissions for these tracks
    let revisedSubmissions = [];
    if (trackIds.length > 0) {
      const placeholders = trackIds.map((_, i) => `$${i + 1}`).join(",");
      const revisedQuery = `SELECT * FROM submissions WHERE track_id IN (${placeholders}) AND submission_status = $${trackIds.length + 1}`;
      const revisedResult = await pool.query(revisedQuery, [...trackIds, "Submitted Revised Paper"]);
      revisedSubmissions = revisedResult.rows;
    }

    // Same per-reviewer "already done" tracking for re-reviews.
    const reReviewedResult = await pool.query(
      "select submission_id from revised_submissions where lower(reviewer) = lower($1)",
      [req.user.email]
    );
    const reReviewedSubmissionIds = new Set(reReviewedResult.rows.map((r) => r.submission_id));

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

    tracksWithConferences.sort((a, b) =>
      String(a.conference_id).localeCompare(String(b.conference_id)) ||
      String(a.track_group_name || "").localeCompare(String(b.track_group_name || "")) ||
      String(a.track_name).localeCompare(String(b.track_name)));

    return res.render("reviewer/dashboard", {
      user: req.user,
      tracks: tracksWithConferences,
      userSubmissions: submissiondata,
      revisedSubmissions: revisedSubmissions,
      reviewedSubmissionIds,
      reReviewedSubmissionIds,
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
  if (!hasAnyConferenceRole(req.user, "invitee")) {
    return res.redirect("/dashboard?message=Invitee role not found in your current session. If a chair has just invited you, please log out and log back in. If you think this is an error, please reach out to the conference chair.");
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
function formatConferenceDateRange(startDate, endDate) {
  const fmt = (d) => {
    if (!d) return null;
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  };
  const start = fmt(startDate);
  const end = fmt(endDate);
  if (start && end) return start === end ? start : `${start} - ${end}`;
  return start || end || "the scheduled dates";
}

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

function getCurrentDateTimeIST() {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istTime.getUTCDate()).padStart(2, "0");
  const hours = String(istTime.getUTCHours()).padStart(2, "0");
  const minutes = String(istTime.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes} IST`;
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

// FILE-03 (security-audit/COMPLETE_FINDINGS_REGISTER.md): Cloudinary
// treats "/" as a folder separator in public_id, so building one from
// unsanitized user-controlled text (e.g. a free-text display name entered
// at registration) could land an upload in an unintended folder within the
// account's asset tree. Strips anything that isn't alphanumeric/_/- before
// it's used in a public_id - the folder itself is still set separately via
// the `folder` option, this only sanitizes the filename-like segment.
function sanitizeCloudinaryIdSegment(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "user";
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
  if (ext === ".docx") {
    // FILE-02: the generic ZIP signature alone is true of any ZIP archive,
    // not specifically a DOCX. Every real OOXML document (docx/xlsx/pptx)
    // stores its manifest entry name "[Content_Types].xml" as a literal,
    // uncompressed string in its ZIP local file headers, so a direct byte
    // search for it - without adding a ZIP-parsing dependency - confirms
    // this is actually an Office document and not just any same-signature
    // ZIP file (e.g. a renamed .zip).
    return head.subarray(0, 2).toString("latin1") === "PK" && file.buffer.includes("[Content_Types].xml");
  }
  if (ext === ".doc") return head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  return false;
}

// Case-normalized so a submission's primary_author/co_authors (typed by a
// chair, possibly with different casing than the account's own login email)
// always maps to the same cache key as the viewer's own req.user.email -
// otherwise invalidation can silently miss the key the viewer actually reads
// from, leaving their "My Submissions" view stale.
function submissionsCacheKey(email, conferenceId) {
  return `${String(email || "").trim().toLowerCase()}_submissions_conference_${conferenceId}`;
}

async function invalidateConferenceSubmissionCache(emails, conferenceId) {
  if (!redisClient) return;
  const uniqueKeys = [...new Set(emails.filter(Boolean).map((email) => submissionsCacheKey(email, conferenceId)))];
  await Promise.all(uniqueKeys.map((key) => redisClient.del(key)));
}

// Ownership helpers (use existing data: conferences.created_by, track_reviewers, panelists)
async function chairOwnsConference(email, conferenceId) {
  const result = await pool.query(
    "select 1 from conferences where conference_id = $1 and created_by = $2",
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

// True once every reviewer assigned to a submission's Subject Area has
// submitted a review (peer_review) or re-review (revised_submissions) for
// it - not as soon as the first one has. Used to gate the Meta-Reviewer's
// recommendation page/submission so a recommendation is never made on an
// incomplete set of reviews.
async function allReviewersSubmitted(submissionId, { revised }) {
  const table = revised ? "revised_submissions" : "peer_review";
  const result = await pool.query(
    `select not exists (
       select 1 from unnest(t.track_reviewers) as required(email)
       where not exists (select 1 from ${table} r where r.submission_id = s.submission_id and lower(r.reviewer) = lower(required.email))
     ) as complete
     from submissions s
     join conference_tracks t on t.track_id = s.track_id
     where s.submission_id = $1`,
    [submissionId]
  );
  return result.rows.length > 0 && result.rows[0].complete === true;
}

async function checkPosterCoordinatorAccess(conferenceId, email) {
  const posterAccess = await pool.query(
    "select 1 from poster_session p where p.conference_id = $1 and $2 = any(p.coodinators) union all select 1 from conference_tracks tr where tr.conference_id = $1 and $2 = any(tr.panelists) limit 1",
    [conferenceId, email]
  );
  return posterAccess.rows.length > 0;
}

// Checks whether "now" (IST) falls inside [start_time - 5min buffer, end_time]
// on `date`. Returns { blocked: 'not_started' | 'ended' | null, sessionEndIso }.
// Lenient by design: if date/startTime/endTime aren't all set yet (chair
// hasn't scheduled this session), returns { blocked: null }, imposing no
// restriction - same behavior /panelist/active-session already relied on.
function checkSessionTimeWindow(date, startTime, endTime) {
  if (!date || !startTime || !endTime) return { blocked: null, sessionEndIso: null };
  try {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const dateStr = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
    const [y, mo, d] = dateStr.split("-").map(Number);
    const [sh, sm] = String(startTime).split(":").map(Number);
    const [eh, em] = String(endTime).split(":").map(Number);

    const startUtcMs = Date.UTC(y, mo - 1, d, sh, sm) - istOffset;
    const endUtcMs = Date.UTC(y, mo - 1, d, eh, em) - istOffset;
    const nowUtcMs = Date.now();
    const bufferMs = 5 * 60 * 1000;

    if (nowUtcMs < (startUtcMs - bufferMs)) return { blocked: "not_started", sessionEndIso: null };
    if (nowUtcMs > endUtcMs) return { blocked: "ended", sessionEndIso: null };
    return { blocked: null, sessionEndIso: new Date(endUtcMs).toISOString() };
  } catch (timeErr) {
    console.error("Session window parse error:", timeErr);
    return { blocked: null, sessionEndIso: null };
  }
}

// Keeps only submissions that have a row in `registration` - an accepted
// paper whose author never completed registration isn't actually
// presenting, so it shouldn't appear wherever this is used.
async function filterToRegisteredSubmissions(submissions) {
  const submissionIds = submissions.map((s) => s.submission_id);
  if (submissionIds.length === 0) return [];
  const registered = await pool.query(
    "select submission_id from registration where submission_id = ANY($1)",
    [submissionIds]
  );
  const registeredIds = new Set(registered.rows.map((r) => r.submission_id));
  return submissions.filter((s) => registeredIds.has(s.submission_id));
}

app.get("/score-posters/:id",checkAuth,async(req,res)=>{

if (!(await checkPosterCoordinatorAccess(req.params.id, req.user.email))) {
  return res.redirect("/dashboard?message=You are not authorized to view this page.");
}

const data = await loadPosterSessionsDashboardData(req.params.id);
if (!data) {
  return res.redirect("/dashboard?message=Conference not found.");
}

// Same session-time enforcement as /panelist/active-session: a poster
// coordinator shouldn't be able to score outside the scheduled poster
// session window. Lenient if no window has been scheduled yet (see
// checkSessionTimeWindow).
const posterWindow = checkSessionTimeWindow(
  data.posterSession?.date,
  data.posterSession?.start_time,
  data.posterSession?.end_time
);
if (posterWindow.blocked === "not_started") {
  return res.redirect("/dashboard?message=Session not started yet.");
}
if (posterWindow.blocked === "ended") {
  return res.redirect("/dashboard?message=Session has ended.");
}

// An accepted poster whose author never completed registration isn't
// actually presenting, so it shouldn't be offered for scoring here - unlike
// the chair's manage-poster-sessions view (same shared loader), which still
// needs to show every accepted submission to follow up on registration.
const registeredSubmissions = await filterToRegisteredSubmissions(data.submissions);

res.render("score-posters.ejs",{
  result: registeredSubmissions,
  conference: data.conference,
  posterSession: data.posterSession,
  leaderboard: data.leaderboard,
  user: req.user,
  message: req.query.message || null,
  session_end_iso: posterWindow.sessionEndIso,
})

})

app.get("/score-posters/:id/export", checkAuth, conferenceOperationCooldown("score-posters-export", 10), async (req, res) => {
  if (!(await checkPosterCoordinatorAccess(req.params.id, req.user.email))) {
    return res.redirect("/dashboard?message=You are not authorized to view this page.");
  }
  try {
    const data = await loadPosterSessionsDashboardData(req.params.id);
    if (!data) {
      return res.redirect("/dashboard?message=Conference not found.");
    }

    const registeredSubmissions = await filterToRegisteredSubmissions(data.submissions);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Final Camera Ready Papers");
    sheet.columns = [
      { header: "Paper ID", key: "paperId", width: 12 },
      { header: "Paper Title", key: "title", width: 40 },
      { header: "Primary Author", key: "primaryAuthor", width: 30 },
      { header: "Co-Authors", key: "coAuthors", width: 30 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const sub of registeredSubmissions) {
      sheet.addRow({
        paperId: sub.paperId,
        title: sub.title,
        primaryAuthor: sub.primary_author_formatted,
        coAuthors: sub.co_authors_formatted,
      });
    }

    const fileName = `score-posters-${req.params.id}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error("Error exporting score-posters data:", err);
    return res.redirect("/dashboard?message=Error exporting data.");
  }
});

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
  submission: submissions.rows[0],
  message: req.query.message || null
});

})

app.get("/reviewer/:id", checkAuth, async(req,res)=>{
  if (!hasConferenceRole(req.user, req.params.id, "reviewer")) {
    return res.redirect("/dashboard?message=Reviewer role not found in your current session for this conference. If a chair has just assigned you as a reviewer, please log out and log back in. If you think this is an error, please reach out to the conference chair.");
  }

  try {
    const reviewerEmail = req.user.email;

    // 1. Get tracks where this reviewer is assigned for this conference
    const tracksResult = await pool.query(
      // Cast conference_id to text to prevent param mismatch
      `SELECT t.*, g.group_name AS track_group_name FROM conference_tracks t LEFT JOIN conference_groups g ON g.group_id = t.group_id
       WHERE t.conference_id::text = $1
       AND t.track_reviewers @> ARRAY[$2]
       ORDER BY g.group_name NULLS LAST, t.track_name;`,
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

  return res.render("chair/desk.ejs",{conference:conference.rows[0], submissions:submissions.rows.map(withSignedPaperUrl)});

})

app.post("/submit-desk-decision/:id",checkChairAuth,async(req,res)=>{

  const submission_id = req.params.id;
  const {decision} = req.body;

  


  if (!["DESK ACCEPT", "DESK REJECT"].includes(decision)) {
    return res.redirect("/chair/dashboard?message=Invalid desk decision.");
  }

  const ownerCheck = await pool.query("select conference_id from submissions where submission_id = $1", [submission_id]);
  if (!ownerCheck.rows[0]) {
    return res.redirect("/chair/dashboard?message=Submission not found.");
  }
  if (!(await chairOwnsConference(req.user.email, ownerCheck.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
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

  await invalidateConferenceSubmissionCache(
    [data.rows[0].primary_author, ...(data.rows[0].co_authors || [])],
    data.rows[0].conference_id
  );

  if(decision=='DESK REJECT'){
    return res.redirect("/chair/dashboard/desk/remarks-for-rejection/"+submission_id);
  }else {
    const authorName = await getUserDisplayName(data.rows[0].primary_author);
    const deskConference = await pool.query("select title from conferences where conference_id = $1", [data.rows[0].conference_id]);
    await sendSubmissionLifecycleEmail(
      data.rows[0].primary_author,
      "desk_review_decision",
      {
        authorName,
        conferenceName: deskConference.rows[0]?.title || "the conference",
        title: data.rows[0].title,
        paperId: formatPaperId(data.rows[0].paper_number),
        decision: "ACCEPTED",
      },
      data.rows[0].co_authors
    );
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
  if (!conference.rows[0]) {
    return res.redirect("/chair/dashboard?message=Submission not found.");
  }
  if (!(await chairOwnsConference(req.user.email, conference.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }

  const data = await pool.query("select title, primary_author, co_authors, paper_number, conference_id from submissions where submission_id=$1",[submission_id]);

  await pool.query("update desk_review set remarks=$1 where paper_id = $2",[remarks,submission_id]);
      const authorName = await getUserDisplayName(data.rows[0].primary_author);
      const deskRejectConference = await pool.query("select title from conferences where conference_id = $1", [data.rows[0].conference_id]);
      await sendSubmissionLifecycleEmail(
        data.rows[0].primary_author,
        "desk_review_decision",
        {
          authorName,
          conferenceName: deskRejectConference.rows[0]?.title || "the conference",
          title: data.rows[0].title,
          paperId: formatPaperId(data.rows[0].paper_number),
          decision: "REJECTED",
          remarks,
        },
        data.rows[0].co_authors
      );

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
      // Cached briefly; invalidated immediately on create/update/delete (see DATA_CACHE_TTL_SECONDS)
      if (redisClient) await redisClient.set("conferences", JSON.stringify(conferences), { EX: DATA_CACHE_TTL_SECONDS });
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
  const conference_tracks = await pool.query("select t.*, g.group_name from conference_tracks t left join conference_groups g on g.group_id = t.group_id where t.conference_id=$1 order by g.group_name nulls last, t.track_name",[req.params.id]);
  let submissions = [];
  const conferenceSubmissionsCacheKey = submissionsCacheKey(req.user.email, req.params.id);

  const cachedConferenceSubmissions = await getJsonCacheValue(conferenceSubmissionsCacheKey);
  if (cachedConferenceSubmissions) {
    submissions = cachedConferenceSubmissions;
  } else {

      // Co-authors see the submission too (read-only: no edit/delete/final
      // camera-ready/registration - those stay primary-author-only), not
      // just the primary author.
      const dbresult = await pool.query(
        "select * from submissions where conference_id = $1 and (primary_author = $2 or $2 = any(co_authors))",
        [req.params.id, req.user.email]
      );
      submissions = dbresult.rows;


    if (redisClient) {
      await redisClient.set(conferenceSubmissionsCacheKey, JSON.stringify(submissions), { EX: DATA_CACHE_TTL_SECONDS });
    }
  }

  // Computed fresh every request, never cached: a pre-existing cache entry
  // written before this field existed (or written for a different viewer,
  // if the cache key itself were ever reused) would otherwise serve it as
  // undefined - which silently hid Edit/Delete/Co-Author Requests from the
  // real primary author, since those checks read isPrimaryAuthor straight
  // off the submission object.
  submissions = submissions.map((s) => ({ ...s, isPrimaryAuthor: s.primary_author === req.user.email }));


  // Presentation schedule, shown under the status once a final camera-ready
  // paper has been submitted. Looked up live on every request (not stored
  // in the submissions cache above) since a chair can set/change this
  // schedule (poster_session, or a subject area's presentation_date/time)
  // independently of the submission row itself - caching it inside that
  // JSON would just be a second, harder-to-invalidate staleness source.
  const formatScheduleDate = (d) => {
    if (!d) return null;
    const date = new Date(d);
    const day = String(date.getUTCDate()).padStart(2, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${day}-${month}-${date.getUTCFullYear()}`;
  };
  const formatScheduleTime = (t) => (t ? String(t).slice(0, 5) : null);
  const buildScheduleText = (label, date, startTime, endTime) => {
    const d = formatScheduleDate(date);
    const st = formatScheduleTime(startTime);
    const et = formatScheduleTime(endTime);
    return d && st && et ? `${label} Presentation Schedule: ${d} from ${st} to ${et}` : "(Schedule Not Released Yet)";
  };

  let posterSchedule = null;
  if (submissions.some((s) => s.submission_status === "Submitted Final Camera Ready Paper for Poster Presentation")) {
    const posterResult = await pool.query(
      "select date, start_time, end_time, vc_link from poster_session where conference_id = $1",
      [req.params.id]
    );
    posterSchedule = posterResult.rows[0] || null;
  }

  const oralTrackIds = [...new Set(
    submissions
      .filter((s) => s.submission_status === "Submitted Final Camera Ready Paper for Oral Presentation" && s.track_id)
      .map((s) => s.track_id)
  )];
  const oralScheduleByTrack = {};
  if (oralTrackIds.length > 0) {
    const trackScheduleResult = await pool.query(
      "select track_id, presentation_date, presentation_start_time, presentation_end_time from conference_tracks where track_id = ANY($1)",
      [oralTrackIds]
    );
    trackScheduleResult.rows.forEach((t) => { oralScheduleByTrack[t.track_id] = t; });
  }

  // Registration status, shown (as a disabled button + an accordion of what
  // was filled in) once a submission has been registered. Also looked up
  // live rather than cached, same reasoning as the schedule above.
  const registeredSubmissionIds = submissions
    .filter((s) => s.submission_status === "Submitted Final Camera Ready Paper for Oral Presentation" || s.submission_status === "Submitted Final Camera Ready Paper for Poster Presentation")
    .map((s) => s.submission_id);
  const registrationBySubmission = {};
  if (registeredSubmissionIds.length > 0) {
    const registrationResult = await pool.query(
      "select * from registration where submission_id = ANY($1)",
      [registeredSubmissionIds]
    );
    registrationResult.rows.forEach((r) => { registrationBySubmission[r.submission_id] = r; });
  }

  // Certificate availability, shown (as a Download Certificate button, or
  // "Not Yet Generated") once a submission has been scored/presented. Live
  // lookup, same reasoning as schedule/registration above: certificate
  // generation happens independently of the submission row.
  const certificateEligibleSubmissionIds = submissions
    .filter((s) => s.submission_status === "Poster Scored" || s.submission_status === "Presentation Completed")
    .map((s) => s.submission_id);
  const generatedCertificateSubmissionIds = new Set();
  if (certificateEligibleSubmissionIds.length > 0) {
    const certificatesResult = await pool.query(
      "select submission_id from certificates where submission_id = ANY($1) and status = 'GENERATED'",
      [certificateEligibleSubmissionIds]
    );
    certificatesResult.rows.forEach((c) => generatedCertificateSubmissionIds.add(c.submission_id));
  }

  submissions = submissions.map((s) => {
    let scheduleText = null;
    if (s.submission_status === "Submitted Final Camera Ready Paper for Poster Presentation") {
      scheduleText = buildScheduleText("Poster", posterSchedule?.date, posterSchedule?.start_time, posterSchedule?.end_time);
    } else if (s.submission_status === "Submitted Final Camera Ready Paper for Oral Presentation") {
      const t = oralScheduleByTrack[s.track_id];
      scheduleText = buildScheduleText("Oral", t?.presentation_date, t?.presentation_start_time, t?.presentation_end_time);
    }
    return {
      ...withSignedPaperUrl(s),
      scheduleText,
      registration: registrationBySubmission[s.submission_id] || null,
      certificateGenerated: generatedCertificateSubmissionIds.has(s.submission_id),
    };
  });

  const invited_talk_submissions = await pool.query("select * from invited_talk_submissions where invitee_email=$1 and conference_id = $2",[req.user.email,req.params.id]);

  // The "Submit Invited Talk Paper" section used to be shown based only on
  // the "invitee" role baked into the user's JWT at login/token-refresh
  // time - a stale credential, not a live check: if that role no longer
  // matches a real row in invitees (the role claim predates the invitee
  // being removed, or the two ever fell out of sync), the button kept
  // showing with nothing real behind it. invitees is the authoritative
  // source for this conference, so check it directly instead of trusting
  // the token's cached role.
  const isInvitee = (await pool.query(
    "select 1 from invitees where conference_id = $1 and lower(email) = lower($2) limit 1",
    [req.params.id, req.user.email]
  )).rows.length > 0;

  // The other role buttons (reviewer/session-chair/poster-coordinator/
  // meta-reviewer) and the "no role -> show default author UI" fallback
  // used to be driven by the roles baked into the JWT at login time - the
  // same staleness problem isInvitee above was fixed for. Reading
  // conference_roles fresh here means a revoked role (or one cleaned up by
  // a grant/prune helper since this token was issued) can never leave the
  // user stuck with neither their old role's buttons nor the author default.
  const liveRoles = (await pool.query(
    "select distinct role from conference_roles where conference_id = $1 and lower(email_id) = lower($2)",
    [req.params.id, req.user.email]
  )).rows.map((r) => r.role);

  return res.render("conference.ejs",{conference: conference.rows[0], conference_tracks: conference_tracks.rows, submissions, invited_talk_submissions:invited_talk_submissions.rows, user:req.user, isInvitee, liveRoles, posterSchedule})
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

  const authors = await pool.query("select submission_id, title, submission_status, primary_author, co_authors, paper_number, remarks from submissions where conference_id = $1",[conference_id]);

  // Apply any outstanding meta-reviewer decisions now, at publish time - and
  // only now. The chair must not be aware of a meta-reviewer's recommendation
  // before choosing to publish (privacy): it sits in meta_reviewer_decision,
  // untouched, until this point. Fetch it, copy it onto the submission, then
  // clear the row so a later publish doesn't reapply (and potentially
  // overwrite a chair decision made since) the same recommendation.
  //
  // DB-06 (security-audit/COMPLETE_FINDINGS_REGISTER.md): this used to be
  // a loop of individual pool.query() UPDATEs followed by a separate bulk
  // DELETE, with no transaction - a crash or error partway through left
  // some submissions updated with their meta-reviewer decision applied
  // while the corresponding meta_reviewer_decision rows were never
  // deleted, so the same decision could be silently reapplied (or
  // double-counted) on a later publish. Now all-or-nothing in one
  // transaction, matching the pattern already used elsewhere in this file
  // (desk review, poster-session save, conference delete).
  const submissionIds = authors.rows.map((a) => a.submission_id);
  if (submissionIds.length > 0) {
    const metaDecisions = await pool.query(
      "select submission_id, status, remarks from meta_reviewer_decision where submission_id = ANY($1)",
      [submissionIds]
    );
    if (metaDecisions.rows.length > 0) {
      const metaClient = await pool.connect();
      try {
        await metaClient.query("BEGIN");
        for (const decision of metaDecisions.rows) {
          await metaClient.query(
            "update submissions set submission_status = $1, remarks = $2 where submission_id = $3",
            [decision.status, decision.remarks, decision.submission_id]
          );
        }
        await metaClient.query(
          "delete from meta_reviewer_decision where submission_id = ANY($1)",
          [metaDecisions.rows.map((d) => d.submission_id)]
        );
        await metaClient.query("COMMIT");
      } catch (txErr) {
        await metaClient.query("ROLLBACK");
        throw txErr;
      } finally {
        metaClient.release();
      }
      for (const decision of metaDecisions.rows) {
        const author = authors.rows.find((a) => a.submission_id === decision.submission_id);
        if (author) {
          author.submission_status = decision.status;
          author.remarks = decision.remarks;
        }
      }
    }
  }

  // Invalidate right after the only database writes in this route, and
  // before any email is sent. The mutation (if any) has already committed at
  // this point; a later sendMail failure (e.g. SMTP unavailable) must not
  // leave an already-changed status stuck in a stale cache - that failure
  // would otherwise abort the request before reaching an invalidation call
  // placed after the email loop below.
  await invalidateConferenceSubmissionCache(authors.rows.flatMap((a) => [a.primary_author, ...(a.co_authors || [])]), conference_id);

  for(let i=0;i<authors.rows.length;i++){

    if(authors.rows[i].submission_status=="Submitted Revised Paper" || authors.rows[i].submission_status=="Submitted for Review" || authors.rows[i].submission_status=="DESK ACCEPT"){

      pending_acceptance_notifications[i] = authors.rows[i].submission_id;
      pending_acceptance_notifications_titles[i] = authors.rows[i].title;

    }
    else {
      const authorName = await getUserDisplayName(authors.rows[i].primary_author);
      await sendSubmissionLifecycleEmail(
        authors.rows[i].primary_author,
        "peer_review_decision",
        {
          authorName,
          conferenceName: conference_data.rows[0].title,
          title: authors.rows[i].title,
          paperId: formatPaperId(authors.rows[i].paper_number),
          decision: authors.rows[i].submission_status,
          reviewerComments: authors.rows[i].remarks,
        },
        authors.rows[i].co_authors
      );
    }
  }

  if(pending_acceptance_notifications.length>0){

    console.log(pending_acceptance_notifications);

    return res.render("chair/pending-acceptance.ejs",{pending_acceptance_notifications_titles, pending_acceptance_notifications});

  }

  return res.redirect("/chair/dashboard/view-submissions/"+conference_id+"?message=Acceptance Notification Published!");

});

app.get("/chair/dashboard/edit-sessions/:id", checkChairAuth, async (req, res) => {
  const sessionTrack = await pool.query("select conference_id from conference_tracks where track_id = $1", [req.params.id]);
  if (!sessionTrack.rows[0] || !(await chairOwnsConference(req.user.email, sessionTrack.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this subject area.");
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
      return res.status(404).send("Subject area not found.");
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

// Shared by the chair's manage-sessions (oral presentation) page and its
// Excel export - same per-track leaderboard / Final Camera Ready Papers
// data the page already builds.
async function loadOralSessionsDashboardData(conferenceId) {
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
    [conferenceId]
  );
  const conferenceRaw = confResult.rows[0];
  if (!conferenceRaw) return null;

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
    [conferenceId]
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
    [conferenceId, "Presentation Completed"]
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

  // ---------- FCRP submissions for every track in this conference, in one query ----------
  const fcrpResult = await pool.query(
    `SELECT * FROM submissions
     WHERE conference_id = $1
     AND submission_status = $2`,
    [conferenceId, "Submitted Final Camera Ready Paper for Oral Presentation"]
  );

  const data = await buildLeaderboardAndFcrpByTrack(tracks, leaderboardSubs, fcrpResult.rows);

  const tracksWithData = tracks.map((track) => ({
    ...track,
    leaderboard: data.leaderboardByTrack[track.track_id] || [],
    finalCameraReadyPapers: data.fcrpByTrack[track.track_id] || [],
  }));

  return { conference, tracks: tracksWithData, count };
}

// DB-08 (security-audit/COMPLETE_FINDINGS_REGISTER.md): shared by the oral
// and poster session dashboards. Previously each leaderboard submission ran
// 3 separate queries (review scores, panelist score, author names) inside a
// per-submission loop - for N submissions that's up to 3N+ queries per page
// load, and since peer_review.submission_id had no index at the time this
// was written, each one was a full table scan (fixed separately in
// migration 013/DB-07). This version runs exactly 3 queries total
// (review scores, panelist scores, author names), batched across every
// leaderboard submission via = ANY($1), then groups the results in JS -
// same displayed data, same sorting/ranking semantics, far fewer queries.
async function buildLeaderboardAndFcrpByTrack(tracks, leaderboardSubs, fcrpSubs, groupKeyFn = (s) => s.track_id) {
  const formatAuthor = (email, emailToNameMap = {}) =>
    emailToNameMap[email] ? `${emailToNameMap[email]} (${email})` : email;

  const leaderboardIds = leaderboardSubs.map((s) => s.submission_id);

  const reviewRows = leaderboardIds.length
    ? (await pool.query(
        `SELECT
           pr.submission_id,
           pr.reviewer,
           COALESCE(rs.mean_score, pr.mean_score) AS final_score,
           (rs.mean_score IS NOT NULL) AS is_revised
         FROM peer_review pr
         LEFT JOIN revised_submissions rs
           ON pr.submission_id = rs.submission_id
           AND pr.reviewer = rs.reviewer
         WHERE pr.submission_id = ANY($1)`,
        [leaderboardIds]
      )).rows
    : [];
  const reviewsBySubmission = {};
  for (const r of reviewRows) {
    (reviewsBySubmission[r.submission_id] ||= []).push(r);
  }

  const panelistRows = leaderboardIds.length
    ? (await pool.query(
        `SELECT submission_id, panelist_score
         FROM final_camera_ready_submissions
         WHERE submission_id = ANY($1)`,
        [leaderboardIds]
      )).rows
    : [];
  const panelistScoreBySubmission = Object.fromEntries(
    panelistRows.map((p) => [p.submission_id, p.panelist_score])
  );

  const allEmails = [...new Set([
    ...leaderboardSubs.flatMap((s) => [s.primary_author, ...(s.co_authors || [])]),
    ...fcrpSubs.flatMap((s) => [s.primary_author, ...(s.co_authors || [])]),
  ].filter(Boolean))];
  const userRows = allEmails.length
    ? (await pool.query(`SELECT email, name FROM users WHERE email = ANY($1)`, [allEmails])).rows
    : [];
  const userMap = Object.fromEntries(userRows.map((u) => [u.email, u.name]));

  const leaderboardByTrack = {};
  for (const sub of leaderboardSubs) {
    const reviews = reviewsBySubmission[sub.submission_id] || [];
    let reviewerScore = null;
    let usedRevisedScore = false;
    if (reviews.length > 0) {
      reviewerScore =
        reviews.reduce((sum, r) => {
          if (r.is_revised) usedRevisedScore = true;
          return sum + (r.final_score || 0);
        }, 0) / reviews.length;
    }

    const panelistScore = panelistScoreBySubmission[sub.submission_id] ?? null;

    let averageScore = null;
    if (reviewerScore !== null && panelistScore !== null) averageScore = (reviewerScore + panelistScore) / 2;
    else averageScore = reviewerScore ?? panelistScore;

    const entry = {
      ...sub,
      paperId: formatPaperId(sub.paper_number) || "—",
      reviewerScore: reviewerScore !== null ? +reviewerScore.toFixed(2) : null,
      scoreLabel: usedRevisedScore ? "Revised" : "Original",
      panelistScore: panelistScore !== null ? +panelistScore.toFixed(2) : null,
      averageScore: averageScore !== null ? +averageScore.toFixed(2) : null,
      primary_author_formatted: formatAuthor(sub.primary_author, userMap),
      co_authors_formatted: (sub.co_authors || []).map((email) => formatAuthor(email, userMap)).join(", "),
    };
    (leaderboardByTrack[groupKeyFn(sub)] ||= []).push(entry);
  }
  for (const trackId of Object.keys(leaderboardByTrack)) {
    const entries = leaderboardByTrack[trackId];
    const ranked = entries
      .filter((l) => l.averageScore !== null)
      .sort((a, b) => b.averageScore - a.averageScore)
      .map((l, i) => ({ ...l, rank: i + 1 }));
    const unranked = entries.filter((l) => l.averageScore === null).map((l) => ({ ...l, rank: null }));
    leaderboardByTrack[trackId] = [...ranked, ...unranked];
  }
  // Groups with no leaderboard rows at all still need an entry so callers
  // can safely index by the group key without an extra existence check.
  for (const track of tracks) {
    if (!leaderboardByTrack[groupKeyFn(track)]) leaderboardByTrack[groupKeyFn(track)] = [];
  }

  const fcrpByTrack = {};
  for (const paper of fcrpSubs) {
    const entry = {
      ...withSignedPaperUrl(paper),
      paperId: formatPaperId(paper.paper_number) || "—",
      primary_author_formatted: formatAuthor(paper.primary_author, userMap),
      co_authors_formatted: (paper.co_authors || []).map((email) => formatAuthor(email, userMap)).join(", "),
    };
    (fcrpByTrack[groupKeyFn(paper)] ||= []).push(entry);
  }
  for (const track of tracks) {
    if (!fcrpByTrack[groupKeyFn(track)]) fcrpByTrack[groupKeyFn(track)] = [];
  }

  return { leaderboardByTrack, fcrpByTrack };
}

app.get(
  "/chair/dashboard/manage-sessions/:id",
  checkChairAuth,
  async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
    try {
      const data = await loadOralSessionsDashboardData(req.params.id);
      if (!data) {
        return res.status(404).send("Conference not found.");
      }
      res.render("chair/manage-sessions.ejs", {
        user: req.user,
        tracks: data.tracks,
        conference: data.conference,
        count: data.count,
        message: req.query.message || null,
      });
    } catch (err) {
      console.error("manage-sessions error:", err);
      res.status(500).send("Error fetching data");
    }
  }
);

app.get(
  "/chair/dashboard/manage-sessions/:id/export",
  checkChairAuth,
  conferenceOperationCooldown("oral-sessions-export", 10),
  async (req, res) => {
    if (!(await chairOwnsConference(req.user.email, req.params.id))) {
      return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
    }
    try {
      const data = await loadOralSessionsDashboardData(req.params.id);
      if (!data) {
        return res.status(404).send("Conference not found.");
      }

      const workbook = new ExcelJS.Workbook();

      const leaderboardSheet = workbook.addWorksheet("Leaderboard");
      leaderboardSheet.columns = [
        { header: "Subject Area", key: "trackName", width: 25 },
        { header: "Rank", key: "rank", width: 8 },
        { header: "Paper ID", key: "paperId", width: 12 },
        { header: "Paper Title", key: "title", width: 40 },
        { header: "Primary Author", key: "primaryAuthor", width: 30 },
        { header: "Co-Authors", key: "coAuthors", width: 30 },
        { header: "Reviewer Score", key: "reviewerScore", width: 16 },
        { header: "Panelist Score", key: "panelistScore", width: 16 },
        { header: "Average Score", key: "averageScore", width: 16 },
      ];
      leaderboardSheet.getRow(1).font = { bold: true };
      for (const track of data.tracks) {
        for (const sub of track.leaderboard) {
          leaderboardSheet.addRow({
            trackName: track.track_name,
            rank: sub.rank ?? "N/A",
            paperId: sub.paperId,
            title: sub.title,
            primaryAuthor: sub.primary_author_formatted,
            coAuthors: sub.co_authors_formatted,
            reviewerScore: sub.reviewerScore ?? "",
            panelistScore: sub.panelistScore ?? "",
            averageScore: sub.averageScore ?? "",
          });
        }
      }

      const fcrpSheet = workbook.addWorksheet("Final Camera Ready Papers");
      fcrpSheet.columns = [
        { header: "Subject Area", key: "trackName", width: 25 },
        { header: "Paper ID", key: "paperId", width: 12 },
        { header: "Paper Title", key: "title", width: 40 },
        { header: "Primary Author", key: "primaryAuthor", width: 30 },
        { header: "Co-Authors", key: "coAuthors", width: 30 },
      ];
      fcrpSheet.getRow(1).font = { bold: true };
      for (const track of data.tracks) {
        for (const paper of track.finalCameraReadyPapers) {
          fcrpSheet.addRow({
            trackName: track.track_name,
            paperId: paper.paperId,
            title: paper.title,
            primaryAuthor: paper.primary_author_formatted,
            coAuthors: paper.co_authors_formatted,
          });
        }
      }

      const fileName = `oral-sessions-${req.params.id}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      await workbook.xlsx.write(res);
      return res.end();
    } catch (err) {
      console.error("Error exporting oral sessions:", err);
      return res.status(500).send("Error exporting data.");
    }
  }
);





// Shared by the chair's manage-poster-sessions page, its Excel export, and
// the Poster Presentation Coordinator's score-posters page - all three show
// the same session details / leaderboard / Final Camera Ready Papers data,
// just with a different authorization check and (for score-posters) an
// added scoring form on top of the FCRP table.
async function loadPosterSessionsDashboardData(conferenceId) {
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
    [conferenceId]
  );
  if (!confRaw.rows[0]) return null;

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
    [conferenceId]
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
    [conferenceId]
  );
  const posterSubmissions = posterSubsResult.rows;

  // ---------- leaderboard submissions (ONLY presentation completed) ----------
  const leaderboardSubsResult = await pool.query(
    `SELECT * FROM submissions
     WHERE conference_id = $1
     AND submission_status = $2`,
    [conferenceId, "Poster Scored"]
  );
  const leaderboardSubs = leaderboardSubsResult.rows;

  // DB-08 (security-audit/COMPLETE_FINDINGS_REGISTER.md): batched the same
  // way as loadOralSessionsDashboardData - 3 queries total across every
  // leaderboard submission instead of 3 per submission. See
  // buildLeaderboardAndFcrpByTrack's comment for the full rationale; this
  // poster dashboard isn't per-track, so it groups everything into one
  // synthetic bucket (a constant groupKeyFn) rather than a real track
  // grouping - the real track_id column on each submission/entry is left
  // completely untouched, since downstream code may still read it.
  const allBucketKey = () => "__all__";
  const batched = await buildLeaderboardAndFcrpByTrack(
    [{ bucket: "__all__" }],
    leaderboardSubs,
    posterSubmissions,
    allBucketKey
  );

  const finalLeaderboard = batched.leaderboardByTrack["__all__"] || [];
  const posterSubmissionsFormatted = batched.fcrpByTrack["__all__"] || [];

  return {
    conference,
    posterSession,
    submissions: posterSubmissionsFormatted,
    leaderboard: finalLeaderboard,
  };
}

app.get("/chair/dashboard/manage-poster-sessions/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  try {
    const data = await loadPosterSessionsDashboardData(req.params.id);
    if (!data) {
      return res.redirect("/chair/dashboard?message=Conference not found.");
    }
    res.render("chair/manage-poster-sessions.ejs", {
      user: req.user,
      conference: data.conference,
      posterSession: data.posterSession,
      submissions: data.submissions,
      leaderboard: data.leaderboard,
      message: req.query.message || null,
    });

  } catch (err) {
    console.error("manage-poster-sessions error:", err);
    res.status(500).send("Error fetching data.");
  }
});

app.get("/chair/dashboard/manage-poster-sessions/:id/export", checkChairAuth, conferenceOperationCooldown("poster-sessions-export", 10), async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  try {
    const data = await loadPosterSessionsDashboardData(req.params.id);
    if (!data) {
      return res.redirect("/chair/dashboard?message=Conference not found.");
    }

    const workbook = new ExcelJS.Workbook();

    const leaderboardSheet = workbook.addWorksheet("Leaderboard");
    leaderboardSheet.columns = [
      { header: "Rank", key: "rank", width: 8 },
      { header: "Paper ID", key: "paperId", width: 12 },
      { header: "Paper Title", key: "title", width: 40 },
      { header: "Primary Author", key: "primaryAuthor", width: 30 },
      { header: "Co-Authors", key: "coAuthors", width: 30 },
      { header: "Reviewer Score", key: "reviewerScore", width: 16 },
      { header: "Panelist Score", key: "panelistScore", width: 16 },
      { header: "Average Score", key: "averageScore", width: 16 },
    ];
    leaderboardSheet.getRow(1).font = { bold: true };
    for (const sub of data.leaderboard) {
      leaderboardSheet.addRow({
        rank: sub.rank ?? "N/A",
        paperId: sub.paperId,
        title: sub.title,
        primaryAuthor: sub.primary_author_formatted,
        coAuthors: sub.co_authors_formatted,
        reviewerScore: sub.reviewerScore ?? "",
        panelistScore: sub.panelistScore ?? "",
        averageScore: sub.averageScore ?? "",
      });
    }

    const fcrpSheet = workbook.addWorksheet("Final Camera Ready Papers");
    fcrpSheet.columns = [
      { header: "Paper ID", key: "paperId", width: 12 },
      { header: "Paper Title", key: "title", width: 40 },
      { header: "Primary Author", key: "primaryAuthor", width: 30 },
      { header: "Co-Authors", key: "coAuthors", width: 30 },
    ];
    fcrpSheet.getRow(1).font = { bold: true };
    for (const sub of data.submissions) {
      fcrpSheet.addRow({
        paperId: sub.paperId,
        title: sub.title,
        primaryAuthor: sub.primary_author_formatted,
        coAuthors: sub.co_authors_formatted,
      });
    }

    const fileName = `poster-sessions-${req.params.id}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error("Error exporting poster sessions:", err);
    return res.redirect("/chair/dashboard?message=Error exporting poster sessions.");
  }
});


app.post("/chair/dashboard/set-poster-session/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  

  const { session_date, start_time, end_time, conference_id,coordinators, vc_link } = req.body;
 try {
  // Split comma-separated coordinators into an array
  const coordinatorArray = coordinators
    ? coordinators.split(',').map(e => e.trim()).filter(e => e !== '')
    : [];

  // There's only one poster_session row per conference, so (unlike subject
  // areas) a removed coordinator can't still hold the role via "another
  // instance" - just diff old vs new directly.
  const priorCoordinatorsResult = await pool.query(
    "select coodinators from poster_session where conference_id = $1",
    [conference_id]
  );
  const oldCoordinators = priorCoordinatorsResult.rows[0]?.coodinators || [];
  const coordinatorDiff = diffEmailLists(oldCoordinators, coordinatorArray);

const posterClient = await pool.connect();
try {
  await posterClient.query("BEGIN");
  await posterClient.query(
  `UPDATE poster_session
   SET date = $1,
       start_time = $2,
       end_time = $3,
       coodinators = $4,
       vc_link=$5
   WHERE conference_id = $6;`,
  [session_date, start_time, end_time, coordinatorArray, vc_link, conference_id]
  );
  for (const removed of coordinatorDiff.removed) {
    await posterClient.query(
      "delete from conference_roles where conference_id = $1 and lower(email_id) = lower($2) and role = $3",
      [conference_id, removed, "poster_presentation_coordinator"]
    );
  }
  for (const coordinator of coordinatorDiff.added) {
    const existing = await posterClient.query(
      "select 1 from conference_roles where conference_id = $1 and lower(email_id) = lower($2) and role = $3",
      [conference_id, coordinator, "poster_presentation_coordinator"]
    );
    if (existing.rows.length === 0) {
      await posterClient.query("insert into conference_roles values($1, $2, $3)", [conference_id, coordinator, "poster_presentation_coordinator"]);
    }
  }
  await posterClient.query("COMMIT");
} catch (txErr) {
  await posterClient.query("ROLLBACK");
  throw txErr;
} finally {
  posterClient.release();
}

// Only notify newly added coordinators - not everyone, every time the
// chair re-saves the same list (e.g. just changing the date/time).
for (const coordinator of coordinatorDiff.added) {
  await sendRoleInvitationEmail(coordinator, "poster_presentation_coordinator", conference_id);
}

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
      return res.redirect("/dashboard?message=Subject area not found.");
    }

    const trackIds = trackinfo.map((track) => track.track_id);

    // 2. Session time enforcement
    let session_end_iso = null;
    const activeTrack = trackinfo.find(
      (track) =>
        track.presentation_date &&
        track.presentation_start_time &&
        track.presentation_end_time
    );
    if (activeTrack) {
      const windowResult = checkSessionTimeWindow(
        activeTrack.presentation_date,
        activeTrack.presentation_start_time,
        activeTrack.presentation_end_time
      );
      if (windowResult.blocked === "not_started") {
        return res.redirect('/dashboard?message=Session not started yet.');
      }
      if (windowResult.blocked === "ended") {
        return res.redirect('/dashboard?message=Session has ended.');
      }
      session_end_iso = windowResult.sessionEndIso;
    }

    // 3. Fetch approved oral presentation submissions for only the assigned
    // tracks, and only once registered - an accepted paper whose author
    // never completed registration isn't actually presenting, so panelists
    // shouldn't see it in the active session.
    const sessionResult = await pool.query(
      `SELECT * FROM submissions
       WHERE track_id = ANY($1)
       AND submission_status = 'Submitted Final Camera Ready Paper for Oral Presentation'
       AND EXISTS (SELECT 1 FROM registration r WHERE r.submission_id = submissions.submission_id)`,
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

      // FILE-04: overwrite with a freshly-signed link - see getSignedPaperUrl.
      paper.file_url = getSignedPaperUrl(paper);
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

    await sendMail(email,"Password Reset Link",null,greeting(user.name)+" <br><br>Greetings!<br><br>We have received a request to reset the password associated with your account on the DEI CMT portal.<br><br>To reset your password, please click the link provided below:<br><br><b>Password Reset Link:</b> "+resetLink+" <br><br>For security reasons, this link is valid only for a limited period. If the link expires, you may request a new password reset link through the portal.<br><br>If you did not request a password reset, you may safely ignore this email. Your password will remain unchanged unless the reset process is completed.")
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

    // Peer-review deadline: once it has passed, a reviewer can no longer open this form
    if (deadlineClosed(conferenceRaw?.deadline_peer_review)) {
      return res.render("error.ejs", {
        message: "The peer-review deadline for this conference has passed. You can no longer review submissions.",
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
      userSubmissions: withSignedPaperUrl(submissionData),
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

    // Peer-review deadline: once it has passed, a reviewer can no longer open this form
    if (deadlineClosed(conferenceRaw?.deadline_peer_review)) {
      return res.render("error.ejs", {
        message: "The peer-review deadline for this conference has passed. You can no longer review submissions.",
      });
    }

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
      userSubmissions: withSignedPaperUrl(submissionData),
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

      // Peer-review deadline: once it has passed, no new re-review can be submitted
      const reReviewDeadlineCheck = await pool.query("select deadline_peer_review from conferences where conference_id = $1", [submissionData.conference_id]);
      if (deadlineClosed(reReviewDeadlineCheck.rows[0]?.deadline_peer_review)) {
        return res.redirect("/reviewer/dashboard?message=The peer-review deadline for this conference has passed. You can no longer review submissions.");
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

    // NOTE: submission_status is intentionally left as "Submitted Revised Paper" here.
    // The Meta-Reviewer dashboard picks up revised submissions that have at least one
    // re-review, and the status only changes once a recommendation is applied at
    // /publish/review-results - the Chair no longer resolves this directly (see
    // the removed /resolve-re-review-conflicts route).

    return res.redirect("/reviewer/"+conference_id+"?message=Revised paper review submitted successfully.");

  } catch (err) {
    console.error("Error during re-review:", err);
    return res.redirect("/reviewer/dashboard?message=Error processing re-review.");
  }
});



app.post("/chair/dashboard/manage-sessions/:id", checkChairAuth, async (req, res) => {
  const conferenceId = req.params.id;
  if (!(await chairOwnsConference(req.user.email, conferenceId))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }

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
          const panelistName = await getUserDisplayName(panelistEmail);
          await sendMail(
            panelistEmail,
            `Session Chair Assignment - ${track.track_name}`,
            `You have been assigned as a Session Chair for the subject area "${track.track_name}".`,
            `<p>${greeting(panelistName)}</p>
             <p>You have been assigned as a session chair for the following:</p>
             <p><strong>Subject Area:</strong> ${escapeHtml(track.track_name)}</p>
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
     await sendMail(email,name+", Welcome to DEI CMT!",null,greeting(name)+" <br><br>Greetings!<br><br>We are pleased to inform you that your account has been successfully created on the DEI CMT portal.<br><br>Visit https://cmt.dei.ac.in/account-activation and enter the below given account activation code to activate your account.<br><br><b>Account Activation Code:</b> "+activation_code).catch((mailErr) => console.error("Welcome email failed:", mailErr));

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

    await sendMail(email,"DEI CMT Account Successfully Activated",null, greeting(data2.rows[0].name)+" <br><br>Greetings!<br><br>We are pleased to inform you that your account on the DEI CMT portal has been successfully activated.<br><br>You may now log in to the portal and access the features and facilities available");

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


// No authRateLimitMemory here (unlike the other routes below): that's a
// blunt per-IP request-count throttle, and the account-based lockout above
// (isLoginLocked/recordFailedLogin - 3 failed attempts per account, not per
// IP) is a strictly more precise defense against the same threat for this
// specific route. Keeping both would only add false positives for users
// sharing an IP (NAT/office/campus) without stopping anything the lockout
// doesn't already stop.
app.post("/user-login", async (req, res) => {
  try {

    const { email, password } = req.body;

    const lockedFor = await getLoginLockRemainingSeconds("user", email);
    if (lockedFor > 0) {
      return res.redirect(loginLockedRedirect(lockedFor));
    }

    // FETCH USER
    const userResult = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      const justLockedFor = await recordFailedLogin("user", email);
      return res.redirect(
        justLockedFor > 0
          ? loginLockedRedirect(justLockedFor)
          : "/login/user?message=Invalid email or password"
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
      const justLockedFor = await recordFailedLogin("user", email);
      return res.redirect(
        justLockedFor > 0
          ? loginLockedRedirect(justLockedFor)
          : "/login/user?message=Invalid email or password"
      );
    }

    await clearLoginAttempts("user", email);

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
const canvaConnection = await canva.getConnectionInfo();
res.render("admin",{chairs:chairs.rows,conferences:conferences.rows,message:req.query.message || null, canvaConnection});
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

// Canva has no server-to-server login - every access token traces back to a
// real person authorizing the app once via the browser. This one-time
// connection is app-wide (one shared canva_connection row), set up by an
// Admin here. codeVerifier/state live in the session between these two
// routes only - never sent to the browser as anything but the opaque
// `state` query parameter.
function canvaRedirectUri() {
  const base = getAppUrl();
  if (!base) throw new Error("APP_URL is not configured; Canva's redirect URI cannot be built.");
  return `${base}/admin/canva/callback`;
}

app.get("/admin/canva/connect", checkAuth, requireAdmin, (req, res) => {
  try {
    const { codeVerifier, codeChallenge, state } = canva.generatePkce();
    // adminEmail travels with the session (not the login cookie) because the
    // login cookie is SameSite=strict and will NOT be sent back by the
    // browser when Canva redirects here across origins - see the callback
    // route below for why it doesn't require checkAuth.
    req.session.canvaOAuth = { codeVerifier, state, adminEmail: req.user.email };
    const authorizeUrl = canva.buildAuthorizeUrl({ codeChallenge, state, redirectUri: canvaRedirectUri() });
    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error("Error starting Canva connect flow:", err);
    return res.redirect("/admin?message=" + encodeURIComponent("Could not start the Canva connection: " + err.message));
  }
});

// Deliberately NOT behind checkAuth/requireAdmin: Canva's redirect back here
// is a cross-site navigation, and the login cookie is SameSite=strict, so
// the browser will not send it on this request even though the same person
// is still logged in - checkAuth would reject a legitimate callback. The
// express-session cookie (SameSite=lax by default) does survive a top-level
// cross-site redirect like this one, so the real security check here is
// that req.session.canvaOAuth exists and its `state` matches what Canva
// echoes back - that pairing could only have been created by
// /admin/canva/connect, which IS checkAuth+requireAdmin gated. The admin's
// identity for the connected_by record also comes from that same stashed
// session data, not from req.user (which isn't available here).
app.get("/admin/canva/callback", async (req, res) => {
  const pending = req.session.canvaOAuth;
  delete req.session.canvaOAuth;

  if (req.query.error) {
    return res.redirect("/admin?message=" + encodeURIComponent("Canva authorization was not completed: " + req.query.error));
  }
  if (!pending || !req.query.state || req.query.state !== pending.state) {
    return res.redirect("/admin?message=" + encodeURIComponent("Canva connection failed: the authorization response could not be verified. Please try connecting again."));
  }

  try {
    const tokens = await canva.exchangeCodeForTokens(req.query.code, pending.codeVerifier, canvaRedirectUri());
    await canva.saveConnection(tokens, pending.adminEmail);
    return res.redirect("/admin?message=" + encodeURIComponent("Canva connected successfully."));
  } catch (err) {
    console.error("Error completing Canva connect flow:", err);
    return res.redirect("/admin?message=" + encodeURIComponent("Could not complete the Canva connection: " + err.message));
  }
});

app.post("/admin/canva/disconnect", checkAuth, requireAdmin, async (req, res) => {
  await canva.disconnect();
  return res.redirect("/admin?message=" + encodeURIComponent("Canva has been disconnected."));
});

// Diagnostic: the real placeholder names/types in a connected Brand
// Template's dataset, so the certificate field mapping in
// /chair/dashboard/enable-pdf-download/:id is set from what the template
// actually has, not guessed. ?role=poster|paper|reviewer|session_chair|invited_speaker
// checks that one template; with no ?role, checks every configured one
// (CANVA_TEMPLATE_IDS) and reports per-role results, skipping any whose
// template id isn't set yet rather than erroring.
app.get("/admin/canva/dataset", checkAuth, requireAdmin, async (req, res) => {
  const role = req.query.role;
  if (role) {
    const templateId = CANVA_TEMPLATE_IDS[role];
    if (!templateId) {
      return res.status(400).json({ error: `Unknown or unconfigured role "${role}". Known roles: ${Object.keys(CANVA_TEMPLATE_IDS).join(", ")}` });
    }
    try {
      return res.json({ role, templateId, dataset: await canva.getBrandTemplateDataset(templateId) });
    } catch (err) {
      console.error(`Error fetching Canva brand template dataset for role "${role}":`, err);
      return res.status(500).json({ error: err.message });
    }
  }

  const results = {};
  for (const [roleName, templateId] of Object.entries(CANVA_TEMPLATE_IDS)) {
    if (!templateId) {
      results[roleName] = { configured: false };
      continue;
    }
    try {
      results[roleName] = { configured: true, templateId, dataset: await canva.getBrandTemplateDataset(templateId) };
    } catch (err) {
      console.error(`Error fetching Canva brand template dataset for role "${roleName}":`, err);
      results[roleName] = { configured: true, templateId, error: err.message };
    }
  }
  return res.json(results);
});

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

app.post("/create-chair-credentials", async(req,res)=>{

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
  const data = await pool.query("update chairs set password=$1 where email=$2 returning email, name",[unusablePassword,email]);

  if(!data.rows[0]){
    return res.redirect("/admin?message=Chair not found.");
  }

  const setupLink = await issueAccountSetupLink(email);
  await sendMail(email,"Chair Portal Password Reset",null,greeting(data.rows[0].name)+" <br><br>The Admin has reset your DEI CMT Chair Portal password. Please set a new password using the link below. The link is valid for 24 hours. <br><br><a href=\"" + setupLink + "\">Set your password</a> <br><br>Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards, <br>Team DEI Conference Management Toolkit");

  return res.redirect("/admin?message=" + encodeURIComponent("A password setup link has been sent to " + email + "."));
});

app.post("/grant-access/:id", checkAuth, requireAdmin, async(req,res)=>{

  const email = req.params.id;
  const data = await pool.query("update chairs set status=$1 where email=$2 returning *",["ACCOUNT ACTIVATED",email]);

  if(data.rows[0]){

    await sendMail(email,"Chair Portal Access Re-Granted",null,greeting(data.rows[0].name)+" The Admin has Re-Granted you the access to the DEI CMT Chair Portal. Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.");
    return res.redirect("/admin?message=" + encodeURIComponent("Chair Portal Access Re-Granted to " + email + "!"));
  }
  return res.redirect("/admin?message=Chair not found.");

})

app.post("/revoke-access/:id", checkAuth, requireAdmin, async(req,res)=>{

  const email = req.params.id;

  const pre_data = await pool.query("select * from chairs where email=$1 and status=$2",[email,"ACCOUNT ACTIVATED"]);

  if(pre_data.rows.length){

     const data = await pool.query("update chairs set status=$1 where email=$2 returning *",["ACCESS REVOKED",email]);
  if(data.rows[0]){

    await sendMail(email,"Chair Portal Access Revoked",null,greeting(data.rows[0].name)+" The Admin has revoked your DEI CMT Chair Portal Access. Incase of any queries, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.");
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


// See the comment on /user-login above - the account lockout replaces this
// route's need for the generic per-IP throttle too.
app.post("/chair-login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const lockedFor = await getLoginLockRemainingSeconds("chair", email);
    if (lockedFor > 0) {
      return res.redirect(loginLockedRedirect(lockedFor));
    }

    // fetch user
    const userResult = await pool.query(
      "SELECT * FROM chairs WHERE email = $1 and status=$2",
      [email,"ACCOUNT ACTIVATED"]
    );

    if (userResult.rows.length === 0) {
      const justLockedFor = await recordFailedLogin("chair", email);
      return res.redirect(justLockedFor > 0
        ? loginLockedRedirect(justLockedFor)
        : "/login/user?message=Invalid email or password");
    }

    const user = userResult.rows[0];

    // compare password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      const justLockedFor = await recordFailedLogin("chair", email);
      return res.redirect(justLockedFor > 0
        ? loginLockedRedirect(justLockedFor)
        : "/login/user?message=Invalid email or password");
    }

    await clearLoginAttempts("chair", email);

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
    const updatedUser = await pool.query(
      "UPDATE users SET password=$1 WHERE email=$2 RETURNING name",
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
      greeting(updatedUser.rows[0]?.name)+" <br><br>The password for your DEI CMT account linked to this Email ID was successfully updated. <br><br>In case of any technical assistance, please feel free to reach out to us at multimedia@dei.ac.in or contact us at +91 9875691340.<br><br>Thanks & Regards,<br>Team DEI Conference Management Toolkit"
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
      return res.redirect("/chair/dashboard?message=You are not authorized to modify this subject area.");
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

    // 4. Keep conference_roles in sync with the new reviewer/session-chair
    // lists (see ensureConferenceRole/pruneConferenceRoleIfUnassigned):
    // grant the role to anyone newly added, and revoke it from anyone
    // removed who isn't still assigned to another subject area in this
    // conference.
    const conferenceId = subjectRow.rows[0].conference_id;
    const reviewerDiff = diffEmailLists(oldReviewers, reviewersArray);
    const sessionChairDiff = diffEmailLists(oldPanelists, panelistsArray);

    for (const email of reviewerDiff.removed) {
      await pruneConferenceRoleIfUnassigned(conferenceId, trackId, email, "reviewer", "track_reviewers");
    }
    for (const email of reviewerDiff.added) {
      if (await ensureConferenceRole(conferenceId, email, "reviewer")) {
        await sendRoleInvitationEmail(email, "reviewer", conferenceId);
      }
    }
    for (const email of sessionChairDiff.removed) {
      await pruneConferenceRoleIfUnassigned(conferenceId, trackId, email, "session_chair", "panelists");
    }
    for (const email of sessionChairDiff.added) {
      if (await ensureConferenceRole(conferenceId, email, "session_chair")) {
        await sendRoleInvitationEmail(email, "session_chair", conferenceId);
      }
    }

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
  if (!(await chairOwnsConference(req.user.email, conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }

  try {
    // 1. Insert invitee row
    const data2= await pool.query("select * from invitees where conference_id=$1 and email=$2",[conference_id,email]);

    const data = await pool.query("select * from users where email=$1",[email]);
    const conferenceRow = (await pool.query("select title, conference_start_date, conference_end_date from conferences where conference_id=$1",[conference_id])).rows[0];
    const conferenceName = conferenceRow?.title || "the conference";
    const conferenceDates = formatConferenceDateRange(conferenceRow?.conference_start_date, conferenceRow?.conference_end_date);
    const invitedTalkEmailIntro =
      "Dear " + escapeHtml(name) + ",<br><br>" +
      "Greetings from the " + escapeHtml(conferenceName) + " Organizing Committee.<br><br>" +
      "We are pleased to invite you to deliver an Invited Talk at " + escapeHtml(conferenceName) + ", to be held on " + escapeHtml(conferenceDates) + " at Dayalbagh Educational Institute (Deemed to be University), Agra.<br><br>" +
      "We would be honoured to have you share your valuable knowledge, expertise, and insights with the participants. Your presence and contribution would greatly enrich the academic discussions and enhance the overall experience of the conference.<br><br>";
    const invitedTalkEmailOutro =
      "We sincerely hope you will accept our invitation and look forward to your participation in the conference.<br><br>" +
      "Thank you for your valuable time and consideration.<br><br>" ;
    const invitedTalkEmailSubject = "Invitation to Deliver an Invited Talk at " + conferenceName;
    if(data.rows[0] && !data2.rows[0]){
      await pool.query(
      `INSERT INTO invitees (conference_id, name, email)
       VALUES ($1, $2, $3);`,
      [conference_id, name, email]
    );
      await ensureConferenceRole(conference_id, email, "invitee");
     await sendMail(email,invitedTalkEmailSubject,null,
      invitedTalkEmailIntro +
      "We kindly request you to visit the DEI CMT portal at <a href='https://cmt.dei.ac.in'>https://cmt.dei.ac.in</a> to log in and submit your paper/details under the Invited Talk category.<br><br>" +
      invitedTalkEmailOutro
     )
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
     await ensureConferenceRole(conference_id, email, "invitee");

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
        await sendMail(email,invitedTalkEmailSubject,null,
          invitedTalkEmailIntro +
          "We kindly request you to visit the DEI CMT portal to create your account and submit your paper/details under the Invited Talk category. Please use the link below to set up your account password:<br><br>" +
          "<a href='"+(getAppUrl() || "")+"/invited-user/password-update/"+encodeURIComponent(email)+"?token="+inviteToken+"'>Set up your account</a><br><br>This link is valid for 24 hours." +
          invitedTalkEmailOutro
        ).catch((mailErr) => console.error("Invitee setup email failed:", mailErr));
        return res.redirect("/chair/dashboard/invited-talks/"+conference_id+"?message=Succesfully Added Invitee. Instructions to set up account has been sent to Invitee via Email.");

    }
    


  } catch (err) {
    console.error("Error adding invitee:", err);
    return res.redirect(`/chair/dashboard/invited-talks/${conference_id}?message=Error adding invitee.`);
  }


});

// Revokes an invitee: removes the `invitees` row and the matching
// conference_roles "invitee" row together, so a later login's JWT no longer
// carries the role. Without this, nothing ever cleared conference_roles,
// and conference.ejs's `!roleStr` check kept hiding the default-author
// "Create New Submission" UI even though the person had no real role left.
app.post("/remove-invitee", checkChairAuth, async (req, res) => {
  const { email, conference_id } = req.body;
  if (!email || !conference_id) {
    return res.status(400).send("Email and conference ID are required.");
  }
  if (!(await chairOwnsConference(req.user.email, conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }

  try {
    await pool.query(
      "delete from invitees where conference_id = $1 and lower(email) = lower($2)",
      [conference_id, email]
    );
    await pool.query(
      "delete from conference_roles where conference_id = $1 and lower(email_id) = lower($2) and role = $3",
      [conference_id, email, "invitee"]
    );
    return res.redirect(`/chair/dashboard/invited-talks/${conference_id}?message=Invitee removed.`);
  } catch (err) {
    console.error("Error removing invitee:", err);
    return res.redirect(`/chair/dashboard/invited-talks/${conference_id}?message=Error removing invitee.`);
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

      // Peer-review deadline: once it has passed, no new review can be submitted
      const reviewDeadlineCheck = await pool.query("select deadline_peer_review from conferences where conference_id = $1", [submissionData.conference_id]);
      if (deadlineClosed(reviewDeadlineCheck.rows[0]?.deadline_peer_review)) {
        return res.redirect("/reviewer/dashboard?message=The peer-review deadline for this conference has passed. You can no longer review submissions.");
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

    // DB-04 (security-audit/COMPLETE_FINDINGS_REGISTER.md): the SELECT
    // check above is a check-then-act race - two concurrent submits (double
    // click, duplicate tab, retried request) could both pass it and both
    // insert, double-weighting this reviewer's score in every leaderboard
    // average. uniq_peer_review_submission_reviewer (migration 014) makes a
    // true duplicate impossible regardless of timing; ON CONFLICT DO
    // NOTHING + a rowCount check turns the race into the same
    // already-reviewed message the pre-check gives in the common case.
    const insertResult = await pool.query(
      `INSERT INTO peer_review (
        conference_id, submission_id, review_status, remarks,
        originality_score, relevance_score, technical_quality_score,
        clarity_score, impact_score, mean_score, reviewer, acceptance_status
      )
      VALUES ($1,$2,'Reviewed',$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (submission_id, reviewer) DO NOTHING;`,
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
    if (insertResult.rowCount === 0) {
      return res.redirect("/reviewer/dashboard?message=You have already reviewed this submission.");
    }

    // NOTE: submission_status is intentionally left unchanged (still "DESK ACCEPT")
    // here. The Meta-Reviewer dashboard picks up DESK ACCEPT submissions that have
    // at least one review, and the status only changes once the Meta-Reviewer's
    // recommendation is applied at /publish/review-results.

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
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this subject area.");
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
      meta_reviewers,
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
    const metaReviewerEmail = String(meta_reviewers || "").trim() || null;

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
       (track_name, track_reviewers, presentation_date, presentation_start_time, presentation_end_time, panelists, conference_id, meta_reviewer, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7,$8,$9)`,
      [
        subjectName,
        reviewersArray,
        session_date,
        session_start_time,
        session_end_time,
        sessionChairsArray,
        req.params.id,
        metaReviewerEmail,
        trackGroupId
      ]
    );


    for (const reviewerEmail of reviewersArray) {

    await pool.query("insert into conference_roles values($1, $2, $3)",[req.params.id, reviewerEmail, "reviewer"]);

      await sendRoleInvitationEmail(reviewerEmail, "reviewer", req.params.id);
    }

    if (metaReviewerEmail) {
      await sendRoleInvitationEmail(metaReviewerEmail, "meta_reviewer", req.params.id);
    }

    for (const chairEmail of sessionChairsArray) {

      await pool.query("insert into conference_roles values ($1,$2,$3)",[req.params.id,chairEmail,"session_chair"]);
      await sendRoleInvitationEmail(chairEmail, "session_chair", req.params.id);
    }


    if (metaReviewerEmail) {
      await pool.query("insert into conference_roles values ($1,$2,$3)",[req.params.id,metaReviewerEmail,"meta_reviewer"]);
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

  if (!hasConferenceRole(req.user, conference_id, "meta_reviewer")) {
    return res.redirect("/dashboard?message=Meta-Reviewer role not found in your current session for this conference. If a chair has just assigned you, please log out and log back in. If you think this is an error, please reach out to the conference chair.");
  }

  const assigned_tracks = await pool.query("select * from conference_tracks where lower(meta_reviewer) = lower($1) and conference_id = $2",[req.user.email,conference_id]);

  // One row per SUBMISSION (not per review) across all of this meta-reviewer's
  // assigned tracks - a submission reviewed by multiple reviewers must appear
  // only once here, with every one of those reviews shown together on its
  // recommendation-submission page so the meta-reviewer can weigh them all
  // before deciding. Both a first-round "DESK ACCEPT" submission (once
  // reviewed) and a "Submitted Revised Paper" submission (once re-reviewed)
  // land here - the Chair no longer resolves either of these directly, so the
  // Meta-Reviewer is the only path to a final decision on both rounds.
  //
  // A submission only appears once EVERY reviewer assigned to its Subject
  // Area has submitted their review (or re-review) - not as soon as the
  // first one comes in. "not exists a reviewer in track_reviewers who hasn't
  // reviewed yet" expresses that without assuming review counts line up
  // (e.g. if the reviewer list changes after some reviews are already in).
  const peer_review = assigned_tracks.rows.length
    ? await pool.query(
        `select submission_id, title, paper_number, review_count, round from (
           select s.submission_id, s.title, s.paper_number, count(pr.id)::int as review_count, 'First Review' as round
           from submissions s
           join conference_tracks t on t.track_id = s.track_id
           join peer_review pr on pr.submission_id = s.submission_id
           where s.track_id = ANY($1::uuid[]) and s.submission_status = 'DESK ACCEPT'
             and not exists (select 1 from meta_reviewer_decision d where d.submission_id = pr.submission_id)
             and not exists (
               select 1 from unnest(t.track_reviewers) as required(email)
               where not exists (select 1 from peer_review pr2 where pr2.submission_id = s.submission_id and lower(pr2.reviewer) = lower(required.email))
             )
           group by s.submission_id, s.title, s.paper_number

           union all

           select s.submission_id, s.title, s.paper_number, count(*)::int as review_count, 'Re-Review' as round
           from submissions s
           join conference_tracks t on t.track_id = s.track_id
           join revised_submissions rs on rs.submission_id = s.submission_id
           where s.track_id = ANY($1::uuid[]) and s.submission_status = 'Submitted Revised Paper'
             and not exists (select 1 from meta_reviewer_decision d where d.submission_id = rs.submission_id)
             and not exists (
               select 1 from unnest(t.track_reviewers) as required(email)
               where not exists (select 1 from revised_submissions rs2 where rs2.submission_id = s.submission_id and lower(rs2.reviewer) = lower(required.email))
             )
           group by s.submission_id, s.title, s.paper_number
         ) combined
         order by title`,
        [assigned_tracks.rows.map((t) => t.track_id)]
      )
    : { rows: [] };

  return res.render("meta-reviewer.ejs",{peer_review: peer_review.rows,assigned_tracks:assigned_tracks.rows});

})

app.get("/meta-reviewer/dashboard/recommendation-submission/:id",checkAuth,async(req,res)=>{

  const submission_id = req.params.id;

  // Authorization: only the meta-reviewer assigned to this submission's track may open this form
  const metaCheck = await pool.query(
    "select s.submission_status from submissions s join conference_tracks t on t.track_id = s.track_id where s.submission_id = $1 and lower(t.meta_reviewer) = lower($2) limit 1",
    [submission_id, req.user.email]
  );
  if (metaCheck.rows.length === 0) {
    return res.redirect("/dashboard?message=You are not assigned as the meta-reviewer for this submission.");
  }

  // A revised submission's re-reviews live in their own table (revised_submissions),
  // separate from the first round's peer_review table - show whichever round this
  // submission is currently at.
  const isRevised = metaCheck.rows[0].submission_status === "Submitted Revised Paper";

  // Gate of record: this page must not open until every reviewer assigned to
  // this submission's Subject Area has submitted their review (or
  // re-review). The dashboard already filters this out, but a direct URL
  // visit must be blocked too.
  if (!(await allReviewersSubmitted(submission_id, { revised: isRevised }))) {
    return res.redirect("/dashboard?message=Not every reviewer has submitted their review for this submission yet.");
  }

  const submissionResult = await pool.query("select title, paper_number, file_url, file_public_id, file_resource_type, file_format from submissions where submission_id = $1", [submission_id]);
  const peer_review = isRevised
    ? await pool.query("select * from revised_submissions where submission_id = $1", [submission_id])
    : await pool.query("select * from peer_review where submission_id = $1", [submission_id]);

  return res.render("meta-reviewer-form.ejs",{peer_review:peer_review.rows,submission_id, isRevised, submission: withSignedPaperUrl(submissionResult.rows[0])});

})

app.post("/submit-meta-reviewer-decision/:id",checkAuth,async(req,res)=>{

  // Authorization: only the meta-reviewer assigned to this submission's track may submit a decision
  const metaCheck = await pool.query(
    "select s.submission_status from submissions s join conference_tracks t on t.track_id = s.track_id where s.submission_id = $1 and lower(t.meta_reviewer) = lower($2) limit 1",
    [req.params.id, req.user.email]
  );
  if (metaCheck.rows.length === 0) {
    return res.redirect("/dashboard?message=You are not assigned as the meta-reviewer for this submission.");
  }

  const submission_id = req.params.id;

  // Same completeness gate as the form page - block a direct POST too.
  const isRevisedDecision = metaCheck.rows[0].submission_status === "Submitted Revised Paper";
  if (!(await allReviewersSubmitted(submission_id, { revised: isRevisedDecision }))) {
    return res.redirect("/dashboard?message=Not every reviewer has submitted their review for this submission yet.");
  }

  const {status, remarks} = req.body;

  // Deliberately NOT applied to submissions.submission_status here. The
  // chair must not be able to see (or have the effect of) a meta-reviewer's
  // recommendation before they choose to publish results - it stays in this
  // advisory table only, and /publish/review-results is the one place that
  // reads it and copies it onto the submission, right before emailing the
  // author with the (now correct) decision.
  //
  // Upsert: resubmitting a recommendation updates the existing decision
  // instead of piling up another row (meta_reviewer_decision.submission_id
  // is unique - see migration 007).
  await pool.query(
    "insert into meta_reviewer_decision (submission_id, status, remarks) values($1,$2,$3) on conflict (submission_id) do update set status = excluded.status, remarks = excluded.remarks",
    [submission_id, status, remarks]
  );

  return res.redirect("/dashboard?message=Meta-Reviewer recommendation successfully saved!");

})

app.post("/chair/dashboard/delete-track/:id", checkChairAuth,async(req,res)=>{
  const trackOwner = await pool.query("select conference_id from conference_tracks where track_id = $1", [req.params.id]);
  if (!trackOwner.rows[0] || !(await chairOwnsConference(req.user.email, trackOwner.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to delete this track.");
  }
  const linkedSubmissions = await pool.query("select 1 from submissions where track_id = $1 limit 1", [req.params.id]);
  if (linkedSubmissions.rows.length) return res.redirect(manageTracksUrl(trackOwner.rows[0].conference_id, "This subject area has submissions and cannot be deleted."));

  // Fetch who held roles via this subject area before deleting it, so those
  // roles can be revoked afterward (unless they're still assigned to another
  // subject area in this conference) - see pruneConferenceRoleIfUnassigned.
  const beingDeleted = await pool.query(
    "select track_reviewers, panelists, meta_reviewer from conference_tracks where track_id = $1",
    [req.params.id]
  );
  const conferenceId = trackOwner.rows[0].conference_id;

  const result = await pool.query("delete from conference_tracks where track_id = $1",[req.params.id]);
  if(!result.rowCount){
    return res.redirect("/chair/dashboard?message=Error deleting Track!");
  }

  const deletedRow = beingDeleted.rows[0] || {};
  for (const email of deletedRow.track_reviewers || []) {
    await pruneConferenceRoleIfUnassigned(conferenceId, req.params.id, email, "reviewer", "track_reviewers");
  }
  for (const email of deletedRow.panelists || []) {
    await pruneConferenceRoleIfUnassigned(conferenceId, req.params.id, email, "session_chair", "panelists");
  }
  if (deletedRow.meta_reviewer) {
    const stillMetaReviewerElsewhere = await pool.query(
      "select 1 from conference_tracks where conference_id = $1 and track_id <> $2 and lower(meta_reviewer) = lower($3) limit 1",
      [conferenceId, req.params.id, deletedRow.meta_reviewer]
    );
    if (stillMetaReviewerElsewhere.rows.length === 0) {
      await pool.query(
        "delete from conference_roles where conference_id = $1 and lower(email_id) = lower($2) and role = $3",
        [conferenceId, deletedRow.meta_reviewer, "meta_reviewer"]
      );
    }
  }

  return res.redirect("/chair/dashboard?message=Track Deleted Succesfully!");
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
      `SELECT conference_id, primary_author, co_authors FROM submissions WHERE submission_id = $1`,
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

    await invalidateConferenceSubmissionCache(
      [submissionResult.rows[0].primary_author, ...(submissionResult.rows[0].co_authors || [])],
      conference_id
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

    // DB-02 (security-audit/COMPLETE_FINDINGS_REGISTER.md): previously only
    // conference_tracks was cleaned up before deleting the conference row,
    // leaving every other child table permanently orphaned (no FK exists to
    // even throw an error). Fetch the authors/co-authors first (for cache
    // invalidation below) and the submission ids (for the two child tables
    // that aren't keyed by conference_id directly), then delete everything
    // in dependency order within this one transaction.
    const affectedSubmissions = await conferenceClient.query(
      "SELECT submission_id, primary_author, co_authors FROM submissions WHERE conference_id = $1",
      [req.params.id]
    );
    const submissionIds = affectedSubmissions.rows.map((s) => s.submission_id);

    if (submissionIds.length > 0) {
      await conferenceClient.query(`DELETE FROM revised_submissions WHERE submission_id = ANY($1);`, [submissionIds]);
      await conferenceClient.query(`DELETE FROM meta_reviewer_decision WHERE submission_id = ANY($1);`, [submissionIds]);
      await conferenceClient.query(`DELETE FROM desk_review WHERE paper_id = ANY($1);`, [submissionIds]);
    }
    await conferenceClient.query(`DELETE FROM co_author_requests WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM peer_review WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM final_camera_ready_submissions WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM registration WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM certificates WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM poster_presentation_scores WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM submissions WHERE conference_id = $1;`, [req.params.id]);

    await conferenceClient.query(`DELETE FROM invitees WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM invited_talk_submissions WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM conference_roles WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM role_certificates WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM poster_session WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query(`DELETE FROM conference_paper_counters WHERE conference_id = $1;`, [req.params.id]);

    await conferenceClient.query(`DELETE FROM conference_tracks WHERE conference_id = $1;`, [req.params.id]);
    // conference_groups.conference_id -> conferences is ON DELETE RESTRICT,
    // so deleting a conference that has track groups previously failed
    // outright (caught, rolled back, 500) while a conference with no
    // groups deleted fine - inconsistent behavior depending on data that
    // has nothing to do with the user's intent. conference_tracks.group_id
    // -> conference_groups is also RESTRICT, which is why conference_tracks
    // must be (and already was) cleared first.
    await conferenceClient.query(`DELETE FROM conference_groups WHERE conference_id = $1;`, [req.params.id]);

    await conferenceClient.query(`DELETE FROM conferences WHERE conference_id = $1;`, [req.params.id]);
    await conferenceClient.query("COMMIT");

    if (redisClient) {
      await redisClient.del("conferences");
      const emails = affectedSubmissions.rows.flatMap((s) => [s.primary_author, ...(s.co_authors || [])]);
      await invalidateConferenceSubmissionCache(emails, req.params.id);
    }
    res.redirect("/chair/dashboard?message=Conference Deleted Succesfully.");
  } catch (err) {
    await conferenceClient.query("ROLLBACK");
    console.error("Error deleting conference:", err);
    res.status(500).send("Error deleting conference.");
  } finally {
    conferenceClient.release();
  }
});

// Runs an autofill -> export against the given Brand Template, downloads
// the (24h-only) result, and re-uploads it to Cloudinary for a permanent
// URL. Shared by every certificate category below.
async function generateCertificateAndUpload(templateId, fields, publicId) {
  const canvaPdfUrl = await canva.generateCertificatePdfUrl(templateId, fields);
  const pdfResponse = await fetch(canvaPdfUrl);
  if (!pdfResponse.ok) throw new Error(`Could not download the generated PDF from Canva (HTTP ${pdfResponse.status})`);
  const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
  const uploadResult = await uploadBufferToCloudinary(pdfBuffer, {
    resource_type: "raw",
    folder: "certificates",
    public_id: publicId,
    format: "pdf",
  });
  return uploadResult.secure_url;
}

// Generates (if not already generated - see role_certificates' unique
// constraint) and emails a certificate link to a Reviewer, Session Chair,
// or Invited Speaker. Unlike author certificates, these are never shown on
// a dashboard - the email IS the delivery mechanism, so this both
// generates and sends in one step. Returns "generated", "skipped" (no
// email on file, or already has one), or "failed".
// BL-01 (security-audit/COMPLETE_FINDINGS_REGISTER.md): 5 minutes is long
// enough for a real Canva+Cloudinary+email round trip to finish under
// normal conditions, short enough that a genuinely crashed/failed attempt
// doesn't block a retry for long. Shared by both the role-certificate and
// author-certificate reservation queries below.
const CERTIFICATE_RESERVATION_STALE_AFTER = "5 minutes";

async function generateAndEmailRoleCertificate({ conferenceId, role, email, contextId, templateId, conferenceTitle, roleLabel, paperTitle }) {
  if (!email) return "skipped";
  try {
    // Atomic reservation: this INSERT only succeeds (returns a row) if no
    // row exists yet, or the existing one isn't GENERATED and its
    // reservation (if any) is stale. A concurrent second call for the same
    // (conference, role, email, context) loses this race and gets zero
    // rows back - it skips instead of re-running the Canva/Cloudinary/email
    // pipeline a second time for the same recipient.
    const reservation = await pool.query(
      `insert into role_certificates (conference_id, role, email, context_id, status, reserved_at)
       values ($1,$2,$3,$4,'GENERATING',now())
       on conflict (conference_id, role, email, context_id) do update
         set status = 'GENERATING', reserved_at = now()
         where role_certificates.status is distinct from 'GENERATED'
           and (role_certificates.reserved_at is null or role_certificates.reserved_at < now() - interval '${CERTIFICATE_RESERVATION_STALE_AFTER}')
       returning *`,
      [conferenceId, role, email, contextId]
    );
    if (reservation.rows.length === 0) return "skipped";

    // Invited Speakers' names live in `invitees` (invited_talk_submissions
    // itself only has their email and talk title, not a name column);
    // everyone else is a regular portal account, looked up the same way
    // author certificates look up a name.
    const name =
      role === "invited_speaker"
        ? (await pool.query("select name from invitees where conference_id = $1 and lower(email) = lower($2) limit 1", [conferenceId, email])).rows[0]?.name
        : await getUserDisplayName(email);

    const fields = {
      [CANVA_CERTIFICATE_FIELDS.name]: name || email,
      [CANVA_CERTIFICATE_FIELDS.conferenceTitle]: conferenceTitle,
    };
    if (paperTitle) fields[CANVA_CERTIFICATE_FIELDS.paperTitle] = paperTitle;

    const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
    const fileUrl = await generateCertificateAndUpload(templateId, fields, `${role}-${contextId}-${safeEmail}-certificate`);

    await pool.query(
      `insert into role_certificates (conference_id, role, email, context_id, status, file_url)
       values ($1,$2,$3,$4,'GENERATED',$5)
       on conflict (conference_id, role, email, context_id) do update set status = excluded.status, file_url = excluded.file_url`,
      [conferenceId, role, email, contextId, fileUrl]
    );

    await sendMail(
      email,
      `Certificate of Appreciation | ${conferenceTitle}`,
      null,
      `${greeting(name)}<br><br>Thank you for your valuable contribution as a ${roleLabel} for ${escapeHtml(conferenceTitle)}!<br><br>Your certificate of appreciation is ready. You can download it using the link below:<br><br><a href="${fileUrl}">Download Certificate</a>`
    );

    return "generated";
  } catch (err) {
    console.error(`Error generating ${role} certificate for ${email} (conference ${conferenceId}, context ${contextId}):`, err);
    // Clean up the reservation on a graceful failure (e.g. Canva/Cloudinary
    // error) so no stuck 'GENERATING' row is left behind - preserves the
    // existing "no partial writes on failure" guarantee. A row only
    // survives past this point if the process crashes before reaching this
    // catch block at all, in which case the reservation's staleness check
    // (CERTIFICATE_RESERVATION_STALE_AFTER) lets a later retry reclaim it.
    await pool.query(
      `delete from role_certificates where conference_id = $1 and role = $2 and lower(email) = lower($3) and context_id = $4 and status = 'GENERATING'`,
      [conferenceId, role, email, contextId]
    ).catch((cleanupErr) => console.error("Failed to clean up certificate reservation:", cleanupErr.message));
    return "failed";
  }
}

// Generates (or re-generates) exactly one submission's author certificate.
// Shared by the bulk "Enable PDF Download" loop below and the single-
// submission "Regenerate" action on the Manage Certificates page. Unlike
// role certificates (generateAndEmailRoleCertificate), a failure here is
// left in place as a visible status = 'FAILED' row with a human-readable
// reason, instead of being deleted - specifically so a chair can see why
// a certificate didn't generate and retry it from the Manage Certificates
// page, rather than needing to read the server log.
async function generateAndEmailAuthorCertificate(conferenceId, conferenceTitle, submission) {
  const templateId = submission.submission_status === "Poster Scored" ? CANVA_TEMPLATE_IDS.poster : CANVA_TEMPLATE_IDS.paper;
  if (!templateId) {
    const message = `No certificate template is configured for "${submission.submission_status}" submissions yet. Ask an Admin to set it up on the Admin page.`;
    await pool.query(
      `insert into certificates (conference_id, submission_id, status, error_message)
       values ($1, $2, 'FAILED', $3)
       on conflict (submission_id) do update
         set status = 'FAILED', error_message = excluded.error_message
         where certificates.status is distinct from 'GENERATED'`,
      [conferenceId, submission.submission_id, message]
    );
    return "failed";
  }

  try {
    // BL-01 (security-audit/COMPLETE_FINDINGS_REGISTER.md): atomic
    // reservation, same pattern as generateAndEmailRoleCertificate - this
    // INSERT only returns a row if no certificate exists yet for this
    // submission, or the existing one isn't GENERATED and (a) its
    // reservation is stale, or (b) it's a FAILED row. A FAILED status is
    // itself evidence nothing is actually in flight, so a deliberate
    // manual "Regenerate" click can reclaim it immediately rather than
    // waiting out the interval that protects a genuinely in-flight
    // (GENERATING) attempt from being double-processed.
    const reservation = await pool.query(
      `insert into certificates (conference_id, submission_id, status, reserved_at, error_message)
       values ($1, $2, 'GENERATING', now(), null)
       on conflict (submission_id) do update
         set status = 'GENERATING', reserved_at = now(), error_message = null
         where certificates.status is distinct from 'GENERATED'
           and (certificates.status = 'FAILED' or certificates.reserved_at is null or certificates.reserved_at < now() - interval '${CERTIFICATE_RESERVATION_STALE_AFTER}')
       returning *`,
      [conferenceId, submission.submission_id]
    );
    if (reservation.rows.length === 0) return "skipped";

    const authorEmails = [submission.primary_author, ...(submission.co_authors || [])].filter(Boolean);
    const usersResult = authorEmails.length
      ? await pool.query("select email, name from users where email = ANY($1)", [authorEmails])
      : { rows: [] };
    const nameByEmail = Object.fromEntries(usersResult.rows.map((u) => [u.email, u.name]));
    const combinedName = authorEmails.map((e) => nameByEmail[e] || e).join(", ");

    // The export URL Canva returns is only valid for 24 hours, so it's
    // downloaded and re-uploaded to Cloudinary right away - that
    // permanent URL is what actually gets stored and served.
    const fileUrl = await generateCertificateAndUpload(
      templateId,
      {
        [CANVA_CERTIFICATE_FIELDS.name]: combinedName,
        [CANVA_CERTIFICATE_FIELDS.conferenceTitle]: conferenceTitle,
        [CANVA_CERTIFICATE_FIELDS.paperTitle]: submission.title,
      },
      `${submission.submission_id}-certificate`
    );

    await pool.query(
      `insert into certificates (conference_id, submission_id, status, file_url, error_message)
       values ($1, $2, 'GENERATED', $3, null)
       on conflict (submission_id) do update set status = excluded.status, file_url = excluded.file_url, error_message = null`,
      [conferenceId, submission.submission_id, fileUrl]
    );

    // Notify the author only after the certificate is actually stored and
    // downloadable, so the email never promises something that isn't
    // there yet.
    const authorName = await getUserDisplayName(submission.primary_author);
    const paperId = formatPaperId(submission.paper_number);
    const certificateType = submission.submission_status === "Poster Scored" ? "Poster Presentation Certificate" : "Paper Presentation Certificate";
    await sendSubmissionLifecycleEmail(
      submission.primary_author,
      "certificate_available",
      { authorName, conferenceName: conferenceTitle, title: submission.title, paperId, certificateType },
      submission.co_authors
    );
    return "generated";
  } catch (certErr) {
    console.error(`Error generating certificate for submission ${submission.submission_id}:`, certErr);
    const message = String(certErr?.message || certErr).slice(0, 500);
    await pool.query(
      `update certificates set status = 'FAILED', error_message = $1 where conference_id = $2 and submission_id = $3 and status = 'GENERATING'`,
      [message, conferenceId, submission.submission_id]
    ).catch((cleanupErr) => console.error("Failed to record certificate failure:", cleanupErr.message));
    return "failed";
  }
}

// One button drives four certificate categories, all gated on the matching
// CANVA_TEMPLATE_IDS entry being configured (several start out empty until
// their Brand Template exists in Canva - see the comment on
// CANVA_TEMPLATE_IDS). Every category is independently idempotent
// (certificates / role_certificates), so re-clicking this for a conference
// only ever fills in whatever is still missing across all four.
app.post("/chair/dashboard/enable-pdf-download/:id", checkChairAuth, conferenceOperationCooldown("enable-pdf-download", 30), async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }

  const conferenceId = req.params.id;
  const counts = { authors: 0, reviewers: 0, sessionChairs: 0, invitedSpeakers: 0 };
  const failures = [];

  try {
    const conferenceResult = await pool.query("select title from conferences where conference_id = $1", [conferenceId]);
    const conferenceTitle = conferenceResult.rows[0]?.title || "";

    // --- Authors: Poster Scored -> the poster template, Presentation Completed -> the paper template ---
    const eligibleSubmissions = await pool.query(
      `select s.submission_id, s.title, s.paper_number, s.primary_author, s.co_authors, s.submission_status
       from submissions s
       left join certificates c on c.submission_id = s.submission_id
       where s.conference_id = $1
         and s.submission_status in ('Poster Scored', 'Presentation Completed')
         and (c.submission_id is null or c.status is distinct from 'GENERATED' or c.file_url is null)`,
      [conferenceId]
    );

    for (const submission of eligibleSubmissions.rows) {
      const outcome = await generateAndEmailAuthorCertificate(conferenceId, conferenceTitle, submission);
      if (outcome === "generated") counts.authors++;
      if (outcome === "failed") failures.push(`submission ${submission.submission_id}`);
      // Keep going - one submission's Canva/Cloudinary failure shouldn't
      // block the rest of the batch (now visible on the Manage
      // Certificates page instead of only in the server log).
      if (outcome !== "skipped") await sleep(CERTIFICATE_BATCH_PACING_MS);
    }

    // --- Reviewers and Session Chairs: one certificate per (Subject Area, person) ---
    if (CANVA_TEMPLATE_IDS.reviewer || CANVA_TEMPLATE_IDS.session_chair) {
      const tracks = await pool.query("select track_id, track_reviewers, panelists from conference_tracks where conference_id = $1", [conferenceId]);

      for (const track of tracks.rows) {
        if (CANVA_TEMPLATE_IDS.reviewer) {
          for (const email of track.track_reviewers || []) {
            const outcome = await generateAndEmailRoleCertificate({
              conferenceId,
              role: "reviewer",
              email,
              contextId: track.track_id,
              templateId: CANVA_TEMPLATE_IDS.reviewer,
              conferenceTitle,
              roleLabel: "Reviewer",
            });
            if (outcome === "generated") counts.reviewers++;
            if (outcome === "failed") failures.push(`reviewer ${email}`);
            if (outcome !== "skipped") await sleep(CERTIFICATE_BATCH_PACING_MS);
          }
        }
        if (CANVA_TEMPLATE_IDS.session_chair) {
          for (const email of track.panelists || []) {
            const outcome = await generateAndEmailRoleCertificate({
              conferenceId,
              role: "session_chair",
              email,
              contextId: track.track_id,
              templateId: CANVA_TEMPLATE_IDS.session_chair,
              conferenceTitle,
              roleLabel: "Session Chair",
            });
            if (outcome === "generated") counts.sessionChairs++;
            if (outcome === "failed") failures.push(`session chair ${email}`);
            if (outcome !== "skipped") await sleep(CERTIFICATE_BATCH_PACING_MS);
          }
        }
      }
    }

    // --- Invited Speakers: one certificate per invited talk submission ---
    if (CANVA_TEMPLATE_IDS.invited_speaker) {
      const invitedTalks = await pool.query(
        "select paper_id, invitee_email, title from invited_talk_submissions where conference_id = $1",
        [conferenceId]
      );
      for (const talk of invitedTalks.rows) {
        const outcome = await generateAndEmailRoleCertificate({
          conferenceId,
          role: "invited_speaker",
          email: talk.invitee_email,
          contextId: talk.paper_id,
          templateId: CANVA_TEMPLATE_IDS.invited_speaker,
          conferenceTitle,
          roleLabel: "Invited Speaker",
          paperTitle: talk.title,
        });
        if (outcome === "generated") counts.invitedSpeakers++;
        if (outcome === "failed") failures.push(`invited speaker ${talk.invitee_email}`);
        if (outcome !== "skipped") await sleep(CERTIFICATE_BATCH_PACING_MS);
      }
    }

    const parts = [];
    if (counts.authors) parts.push(`${counts.authors} author(s)`);
    if (counts.reviewers) parts.push(`${counts.reviewers} reviewer(s)`);
    if (counts.sessionChairs) parts.push(`${counts.sessionChairs} session chair(s)`);
    if (counts.invitedSpeakers) parts.push(`${counts.invitedSpeakers} invited speaker(s)`);
    const summary = parts.length ? parts.join(", ") : "0 recipients";
    const failureNote = failures.length ? ` (${failures.length} failed - see the status column below for details)` : "";
    res.redirect(`/chair/dashboard/manage-certificates/${conferenceId}?message=${encodeURIComponent(`Certificates generated for ${summary}${failureNote}.`)}`);
  } catch (err) {
    console.error("Error enabling PDF download:", err);
    res.redirect(`/chair/dashboard/manage-certificates/${conferenceId}?message=` + encodeURIComponent("An unexpected error occurred: " + err.message));
  }
});

// Shows every eligible submission's author-certificate status (including
// a human-readable failure reason, now that generateAndEmailAuthorCertificate
// leaves a FAILED row behind instead of deleting it) alongside the bulk
// "Enable PDF Download" trigger. Replaces that button's old home directly
// on the chair dashboard.
app.get("/chair/dashboard/manage-certificates/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }

  const conferenceId = req.params.id;
  const conferenceResult = await pool.query("select * from conferences where conference_id = $1", [conferenceId]);
  const conference = conferenceResult.rows[0];
  if (!conference) {
    return res.redirect("/chair/dashboard?message=Conference not found.");
  }

  const rowsResult = await pool.query(
    `select s.submission_id, s.paper_number, s.title, s.submission_status, c.status as certificate_status, c.error_message
     from submissions s
     left join certificates c on c.submission_id = s.submission_id
     where s.conference_id = $1 and s.submission_status in ('Poster Scored', 'Presentation Completed')
     order by s.paper_number`,
    [conferenceId]
  );

  const certificates = rowsResult.rows.map((r) => {
    const statusLabel =
      r.certificate_status === "GENERATED" ? "Generated" :
      r.certificate_status === "GENERATING" ? "Generating…" :
      r.certificate_status === "FAILED" ? `Failed: ${r.error_message || "Unknown error"}` :
      "Not Yet Generated";
    return {
      submissionId: r.submission_id,
      paperId: formatPaperId(r.paper_number) || "—",
      title: r.title,
      statusLabel,
      canRegenerate: r.certificate_status === "FAILED",
    };
  });

  res.render("chair/manage-certificates.ejs", {
    user: req.user,
    conference,
    certificates,
    message: req.query.message || null,
  });
});

// Re-runs certificate generation (Canva + Cloudinary + the author email)
// for exactly one submission - the "Regenerate" action next to a FAILED
// row on the Manage Certificates page. Shares generateAndEmailAuthorCertificate
// with the bulk route above, so a regenerated certificate is held to the
// exact same reservation/idempotency guarantees.
app.post("/chair/dashboard/regenerate-certificate/:id", checkChairAuth, conferenceOperationCooldown("regenerate-certificate", 10), async (req, res) => {
  // Note: conferenceOperationCooldown keys its cooldown on req.params.id,
  // which here is the submission_id (not a conference_id) - that's fine,
  // it still rate-limits repeated regenerate clicks per chair account,
  // just scoped per-submission rather than per-conference.
  const submissionResult = await pool.query(
    "select submission_id, conference_id, title, primary_author, co_authors, submission_status from submissions where submission_id = $1",
    [req.params.id]
  );
  const submission = submissionResult.rows[0];
  if (!submission) {
    return res.redirect("/chair/dashboard?message=" + encodeURIComponent("Submission not found."));
  }
  if (!(await chairOwnsConference(req.user.email, submission.conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  if (!["Poster Scored", "Presentation Completed"].includes(submission.submission_status)) {
    return res.redirect(`/chair/dashboard/manage-certificates/${submission.conference_id}?message=` + encodeURIComponent("This submission is not yet eligible for a certificate."));
  }

  try {
    const conferenceResult = await pool.query("select title from conferences where conference_id = $1", [submission.conference_id]);
    const conferenceTitle = conferenceResult.rows[0]?.title || "";

    const outcome = await generateAndEmailAuthorCertificate(submission.conference_id, conferenceTitle, submission);
    const message =
      outcome === "generated" ? "Certificate regenerated and emailed successfully." :
      outcome === "skipped" ? "The certificate is already generated, or another attempt is already in progress." :
      "Certificate generation failed again - see the status below for details.";
    return res.redirect(`/chair/dashboard/manage-certificates/${submission.conference_id}?message=${encodeURIComponent(message)}`);
  } catch (err) {
    console.error("Error regenerating certificate:", err);
    return res.redirect(`/chair/dashboard/manage-certificates/${submission.conference_id}?message=` + encodeURIComponent("An unexpected error occurred: " + err.message));
  }
});

app.get("/submission/download-certificate/:id", checkAuth, async (req, res) => {
  try {
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [req.params.id]
    );
    const submission = submissionResult.rows[0];
    if (!submission) {
      return res.redirect("/dashboard?message=Submission not found.");
    }
    if (submission.primary_author !== req.user.email && !(Array.isArray(submission.co_authors) && submission.co_authors.includes(req.user.email))) {
      return res.redirect("/dashboard?message=You are not authorized to download this certificate.");
    }

    const certificateResult = await pool.query(
      "select file_url from certificates where submission_id = $1 and status = 'GENERATED'",
      [req.params.id]
    );
    const fileUrl = certificateResult.rows[0]?.file_url;
    if (!fileUrl) {
      return res.redirect(`/conference/${submission.conference_id}?message=Certificate has not been generated yet.`);
    }

    // The certificate is a permanent Cloudinary file by this point (see
    // /chair/dashboard/enable-pdf-download/:id), not generated on demand -
    // just hand the browser straight to it.
    return res.redirect(fileUrl);
  } catch (err) {
    console.error("Error downloading certificate:", err);
    res.redirect("/dashboard?message=An unexpected error occurred while downloading the certificate.");
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


app.post("/join", checkAuth, authRateLimitMemory, async (req, res) => {
 

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
    // DB-05 (security-audit/COMPLETE_FINDINGS_REGISTER.md): the existence
    // check above is a check-then-act race - two near-simultaneous requests
    // could both pass it and both insert a duplicate pending request.
    // uniq_co_author_requests_pending (migration 014) makes a true
    // duplicate impossible regardless of timing.
    const joinInsertResult = await pool.query(
      `INSERT INTO co_author_requests (conference_id, submission_id, primary_author, co_author, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (submission_id, co_author) WHERE status != 'Rejected' DO NOTHING;`,
      [id, submission.submission_id, submission.primary_author, req.user.email, "Pending"]
    );
    if (joinInsertResult.rowCount === 0) {
      return res.redirect("/dashboard?message=You have already sent a request to join this paper.");
    }

    // 7. Send notification email to primary author
    try {
      const primaryAuthorName = await getUserDisplayName(submission.primary_author);
      const requesterName = await getUserDisplayName(req.user.email);
      const conferenceTitle = (await pool.query("select title from conferences where conference_id = $1", [id])).rows[0]?.title || "the conference";
      const paperId = formatPaperId(submission.paper_number);
      await sendMail(
        submission.primary_author,
        `${requesterName} has requested to join the Paper ID - ${paperId} as Co-Author | ${conferenceTitle}`,
        null,
        `<p>${greeting(primaryAuthorName)}</p>
         <p>${escapeHtml(requesterName)}, has requested to join your paper titled &ldquo;${escapeHtml(submission.title)}&rdquo; (${paperId}) as a co-author.</p>
         <p>Please log in to the DEI CMT portal to review and approve or reject the request.</p>`
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

    // 4-6. DB-05 (security-audit/COMPLETE_FINDINGS_REGISTER.md): this used
    // to be a read-modify-write (read co_authors, push in JS, write the
    // whole array back) - a classic lost-update race. If a primary author
    // accepted two pending requests for the same submission at nearly the
    // same time, both handlers could read the same starting array, each
    // append a different email, and whichever UPDATE committed last would
    // silently overwrite the other - one accepted co-author would vanish
    // from the paper despite their request showing "Accepted". Replaced
    // with a single atomic array_append, and the status flip is now
    // conditioned on the request still being Pending (also race-safe) and
    // wrapped in a transaction with the array update so a crash between the
    // two can't leave one written without the other.
    const acceptClient = await pool.connect();
    let coAuthors;
    try {
      await acceptClient.query("BEGIN");
      const updatedSubmission = await acceptClient.query(
        `UPDATE submissions
         SET co_authors = array_append(COALESCE(co_authors, ARRAY[]::text[]), $1)
         WHERE submission_id = $2 AND NOT ($1 = ANY(COALESCE(co_authors, ARRAY[]::text[])))
         RETURNING co_authors;`,
        [coAuthorRequest.co_author, coAuthorRequest.submission_id]
      );
      coAuthors = updatedSubmission.rows[0]?.co_authors || submission.co_authors || [];

      const statusUpdate = await acceptClient.query(
        `UPDATE co_author_requests SET status = 'Accepted' WHERE request_id = $1 AND status = 'Pending';`,
        [requestId]
      );
      if (statusUpdate.rowCount === 0) {
        await acceptClient.query("ROLLBACK");
        return res.redirect("/dashboard?message=This co-author request is no longer pending.");
      }
      await acceptClient.query("COMMIT");
    } catch (txErr) {
      await acceptClient.query("ROLLBACK");
      throw txErr;
    } finally {
      acceptClient.release();
    }

    await invalidateConferenceSubmissionCache([submission.primary_author, ...coAuthors], submission.conference_id);

    // 7. Send email to co-author
    const coAuthorName = await getUserDisplayName(coAuthorRequest.co_author);
    const acceptConferenceTitle = (await pool.query("select title from conferences where conference_id = $1", [submission.conference_id])).rows[0]?.title || "the conference";
    const acceptPaperId = formatPaperId(submission.paper_number);
    await sendMail(
      coAuthorRequest.co_author,
      `Your request to join the Paper ID - ${acceptPaperId} as Co-Author has been APPROVED | ${acceptConferenceTitle}`,
      null,
      `<p>${greeting(coAuthorName)}</p>
       <p>Your request to join the paper titled &ldquo;${escapeHtml(submission.title)}&rdquo; (${acceptPaperId}) has been approved by the Primary Author.</p>
       <p>The submission is now available on your dashboard under the My Submissions section.</p>`,
      submission.primary_author
    );

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
    const rejectedCoAuthorName = await getUserDisplayName(coAuthorRequest.co_author);
    const rejectConferenceTitle = (await pool.query("select title from conferences where conference_id = $1", [submission.conference_id])).rows[0]?.title || "the conference";
    const rejectPaperId = formatPaperId(submission.paper_number);
    await sendMail(
      coAuthorRequest.co_author,
      `Your request to join the Paper ID - ${rejectPaperId} as Co-Author has been REJECTED | ${rejectConferenceTitle}`,
      null,
      `<p>${greeting(rejectedCoAuthorName)}</p>
       <p>Your request to join the paper titled &ldquo;${escapeHtml(submission.title)}&rdquo; (${rejectPaperId}) has been rejected by the Primary Author.</p>`,
      submission.primary_author
    );


    return res.redirect("/dashboard?message=Co-author request rejected successfully.");

  } catch (err) {
    console.error("Error rejecting co-author request:", err);
    return res.redirect("/dashboard?message=Something went wrong.");
  }
});

// Lets a primary author revoke a co-author who was previously accepted.
// Deletes the co_author_requests row entirely (not just a status flip) so
// uniq_co_author_requests_pending (migration 014, partial unique index on
// (submission_id, co_author) WHERE status != 'Rejected') doesn't leave a
// stale 'Accepted' row blocking that person from ever sending a new join
// request for this paper again.
app.post("/remove-co-author/:submission_id/:co_author", checkAuth, async (req, res) => {
  const { submission_id } = req.params;
  const co_author = decodeURIComponent(req.params.co_author);

  try {
    const submissionResult = await pool.query(
      `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
      [submission_id]
    );
    const submission = submissionResult.rows[0];

    if (!submission) {
      return res.redirect("/dashboard?message=Submission not found.");
    }
    if (submission.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=You are not authorized to remove co-authors from this submission.");
    }

    const removeClient = await pool.connect();
    let remainingCoAuthors;
    try {
      await removeClient.query("BEGIN");
      const updated = await removeClient.query(
        `UPDATE submissions SET co_authors = array_remove(COALESCE(co_authors, ARRAY[]::text[]), $1) WHERE submission_id = $2 RETURNING co_authors;`,
        [co_author, submission_id]
      );
      remainingCoAuthors = updated.rows[0]?.co_authors || [];
      await removeClient.query(
        `DELETE FROM co_author_requests WHERE submission_id = $1 AND lower(co_author) = lower($2);`,
        [submission_id, co_author]
      );
      await removeClient.query("COMMIT");
    } catch (txErr) {
      await removeClient.query("ROLLBACK");
      throw txErr;
    } finally {
      removeClient.release();
    }

    await invalidateConferenceSubmissionCache([submission.primary_author, co_author, ...remainingCoAuthors], submission.conference_id);

    const removedCoAuthorName = await getUserDisplayName(co_author);
    const removeConferenceTitle = (await pool.query("select title from conferences where conference_id = $1", [submission.conference_id])).rows[0]?.title || "the conference";
    const removePaperId = formatPaperId(submission.paper_number);
    await sendMail(
      co_author,
      `You have been removed as a Co-Author from Paper ID - ${removePaperId} | ${removeConferenceTitle}`,
      null,
      `<p>${greeting(removedCoAuthorName)}</p>
       <p>You have been removed as a co-author from the paper titled &ldquo;${escapeHtml(submission.title)}&rdquo; (${removePaperId}) by the Primary Author.</p>`,
      submission.primary_author
    );

    return res.redirect(`/submission/view-co-author-requests/${submission_id}?message=Co-author removed successfully.`);
  } catch (err) {
    console.error("Error removing co-author:", err);
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
    cfp_link
  } = req.body;

  try {
    // 1. Insert conference and return row
    const confResult = await pool.query(
      `INSERT INTO conferences
      (title, description, conference_start_date, conference_end_date, full_paper_submission, acceptance_notification, camera_ready_paper_submission,deadline_peer_review,created_by,cfp_link)
      VALUES ($1, $2, $3, $4, $5, $6, $7,$8,$9,$10)
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
        req.user.email,
        cfp_link || null
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

app.post("/delete/invited-submission/:id", checkAuth, async(req,res)=>{

  const {submission_id} = req.params.id;

  await pool.query("delete from invited_talk_submissions where submission_id = $1",[submission_id]);

  return res.redirect("/dashboard?message=Submission deleted succesfully!");
})

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

    // 2. Permission check - co-authors can view the submission on their
    // dashboard, but editing stays primary-author-only.
    if (submission.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=Only the primary author can edit this submission.");
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
      submission: withSignedPaperUrl(submission),
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
    // Co-authors can view the submission on their dashboard, but submitting
    // the camera-ready paper stays primary-author-only (matches the POST
    // /final-camera-ready-submission route's own check).
    if (submission.primary_author !== req.user.email) {
      return res.redirect("/dashboard?message=Only the primary author can submit the camera-ready paper.");
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

const REGISTRATION_STATUSES = [
  "Submitted Final Camera Ready Paper for Oral Presentation",
  "Submitted Final Camera Ready Paper for Poster Presentation",
];

// Shared by both routes below: loads the submission, checks the requester
// may act on it, and checks it's actually at a registration-eligible
// status. Returns { submission } on success, or null after already sending
// a redirect response.
async function loadRegistrationEligibleSubmission(req, res) {
  const submissionResult = await pool.query(
    `SELECT * FROM submissions WHERE submission_id = $1 LIMIT 1;`,
    [req.params.id]
  );
  const submission = submissionResult.rows[0];

  if (!submission) {
    res.redirect("/dashboard?message=Submission not found.");
    return null;
  }
  // Co-authors can view the submission on their dashboard, but registration
  // stays primary-author-only.
  if (submission.primary_author !== req.user.email) {
    res.redirect("/dashboard?message=Only the primary author can register this submission.");
    return null;
  }
  if (!REGISTRATION_STATUSES.includes(submission.submission_status)) {
    res.redirect("/dashboard?message=Registration is not open for this submission yet.");
    return null;
  }
  return submission;
}

app.get("/submission/register/:id", checkAuth, async (req, res) => {
  try {
    const submission = await loadRegistrationEligibleSubmission(req, res);
    if (!submission) return;

    // Once registered, this route is done - disable it rather than letting
    // the form be filled in again.
    const existing = await pool.query("select 1 from registration where submission_id = $1", [req.params.id]);
    if (existing.rows.length > 0) {
      return res.redirect("/dashboard?message=This submission has already been registered.");
    }

    const conferenceResult = await pool.query(
      "select title from conferences where conference_id = $1 limit 1",
      [submission.conference_id]
    );

    const authorEmails = [submission.primary_author, ...(submission.co_authors || [])].filter(Boolean);
    const usersResult = authorEmails.length
      ? await pool.query("select email, name from users where email = ANY($1)", [authorEmails])
      : { rows: [] };
    const nameByEmail = Object.fromEntries(usersResult.rows.map((u) => [u.email, u.name]));
    const formatAuthor = (email) => (nameByEmail[email] ? `${nameByEmail[email]} (${email})` : email);

    return res.render("registration.ejs", {
      user: req.user,
      submission,
      conferenceTitle: conferenceResult.rows[0]?.title || "",
      primaryAuthorFormatted: formatAuthor(submission.primary_author),
      coAuthorsFormatted: (submission.co_authors || []).map(formatAuthor).join(", ") || "None",
      message: req.query.message || null,
    });
  } catch (err) {
    console.error("Error loading registration page:", err);
    return res.redirect("/dashboard?message=An unexpected error occurred.");
  }
});

app.post("/submission/register/:id", checkAuth, async (req, res) => {
  try {
    const submission = await loadRegistrationEligibleSubmission(req, res);
    if (!submission) return;

    const { mode_of_presentation, attending_offline, link_to_video } = req.body;

    if (!["Online", "Offline"].includes(mode_of_presentation)) {
      return res.redirect(`/submission/register/${req.params.id}?message=Please select a valid mode of presentation.`);
    }
    const attendingOfflineCount = Number(attending_offline);
    if (!Number.isInteger(attendingOfflineCount) || attendingOfflineCount < 0) {
      return res.redirect(`/submission/register/${req.params.id}?message=Please enter a valid number of authors attending offline.`);
    }
    const videoLink = String(link_to_video || "").trim();
    if (!videoLink) {
      return res.redirect(`/submission/register/${req.params.id}?message=Please provide the link to your video.`);
    }

    try {
      await pool.query(
        "insert into registration (conference_id, submission_id, mode_of_presentation, link_to_video, attending_offline) values ($1,$2,$3,$4,$5)",
        [submission.conference_id, submission.submission_id, mode_of_presentation, videoLink, attendingOfflineCount]
      );
    } catch (insertErr) {
      if (insertErr.code === "23505") {
        // Unique constraint on submission_id - someone else (or a double
        // submit) already registered this one between the check above and now.
        return res.redirect("/dashboard?message=This submission has already been registered.");
      }
      throw insertErr;
    }

    return res.redirect(`/conference/${submission.conference_id}?message=Registration submitted successfully!`);
  } catch (err) {
    console.error("Error submitting registration:", err);
    return res.redirect(`/submission/register/${req.params.id}?message=An unexpected error occurred. Please try again.`);
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
      // FILE-04: type:"private" - this is the camera-ready paper/poster,
      // same sensitivity as the original manuscript, visible only through
      // a signed URL generated on demand (getSignedPaperUrl).
      const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
        resource_type: "auto",
        type: "private",
        folder: "submissions",
        public_id: `${sanitizeCloudinaryIdSegment(req.user.user_id)}-${Date.now()}-Final`,
      });

      // 3. Insert into final_camera_ready_submissions
      await pool.query(
        `INSERT INTO final_camera_ready_submissions
         (conference_id, submission_id, primary_author, title, abstract, track_id, co_authors, file_url, file_public_id, file_resource_type, file_format)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);`,
        [
          confid,
          id,
          req.user.email,
          title,
          abstract,
          areas,
          co_authors,
          uploadResult.secure_url,
          uploadResult.public_id,
          uploadResult.resource_type,
          uploadResult.format
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
         SET submission_status = $1, file_url = $2, file_public_id = $3, file_resource_type = $4, file_format = $5
         WHERE submission_id = $6;`,
        [newStatus, uploadResult.secure_url, uploadResult.public_id, uploadResult.resource_type, uploadResult.format, id]
      );

      await invalidateConferenceSubmissionCache(
        [req.user.email, ...(Array.isArray(co_authors) ? co_authors : [])],
        confid
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
    // NOTE: this used to cache under `${email}_initiated_conferences`, but the
    // read (`redisClient.get(...)`) was never awaited, so `data` was always a
    // pending Promise - `data.length` was always undefined and the cache
    // branch was dead code; every request silently fell through to the DB
    // query below anyway. Removed rather than "fixed into" a real cache,
    // since this list is cheap (indexed by created_by) and a real cache here
    // would need its own invalidation wired into every conference-edit route.
    const result = await pool.query("SELECT * FROM conferences where created_by = $1",[req.user.email]);
    const conferences = result.rows.map(conference => ({
      ...conference,
      conference_start_date: formatDate(conference.conference_start_date),
      conference_end_date: formatDate(conference.conference_end_date),
      full_paper_submission: formatDate(conference.full_paper_submission),
      acceptance_notification: formatDate(conference.acceptance_notification),
      camera_ready_paper_submission: formatDate(conference.camera_ready_paper_submission),
      deadline_peer_review:formatDate(conference.deadline_peer_review)
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
    peer_review,
    camera_ready_paper_submission,
    cfp_link,
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
           camera_ready_paper_submission = $7,
           cfp_link = $8,
           deadline_peer_review = $9
       WHERE conference_id = $10;`,
      [
        title,
        sanitizeDescription(description),
        conference_start_date,
        conference_end_date,
        full_paper_submission,
        acceptance_notification,
        camera_ready_paper_submission,
        cfp_link || null,
        peer_review,
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

// The Chair no longer records a submission's final decision directly - both a
// first-round "DESK ACCEPT" submission (once reviewed) and a "Submitted
// Revised Paper" submission (once re-reviewed) now go to the Meta-Reviewer
// for a recommendation, applied at /publish/review-results. The routes that
// used to let a Chair read reviews directly and set the decision themselves
// (GET/POST resolve-conflicts, GET/POST resolve-re-review-conflicts) have
// been removed.

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
      submissions: submissionsWithTracks.map(withSignedPaperUrl),
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


// Every status a submission passes through from the moment it's accepted
// onward - used to count "accepted" papers even after they've since moved
// past the two "Accepted for ..." statuses (which only last until FCRP is
// submitted, at which point the status becomes one of REGISTRATION_STATUSES
// or later). Without this lineage, a submission that has already progressed
// to Poster Scored/Presentation Completed would stop counting as "accepted".
const ACCEPTED_LINEAGE_STATUSES = [
  "Accepted for Oral Presentation",
  "Accepted for Poster Presentation",
  "Submitted Final Camera Ready Paper for Oral Presentation",
  "Submitted Final Camera Ready Paper for Poster Presentation",
  "Submitted Final Camera Ready Paper",
  "Poster Scored",
  "Presentation Completed",
];

// Same idea, scoped to "has at least submitted the final camera ready
// paper" - a superset of REGISTRATION_STATUSES that also counts papers
// that have since been scored/presented.
const FCRP_LINEAGE_STATUSES = [
  "Submitted Final Camera Ready Paper for Oral Presentation",
  "Submitted Final Camera Ready Paper for Poster Presentation",
  "Submitted Final Camera Ready Paper",
  "Poster Scored",
  "Presentation Completed",
];

async function loadRegistrationsDashboardData(conferenceId) {
  const conferenceResult = await pool.query("select conference_id, title from conferences where conference_id = $1", [conferenceId]);
  const conference = conferenceResult.rows[0];
  if (!conference) return null;

  const statusCounts = await pool.query(
    `select
       count(*) filter (where submission_status = ANY($2)) as accepted_count,
       count(*) filter (where submission_status = ANY($3)) as fcrp_count
     from submissions
     where conference_id = $1`,
    [conferenceId, ACCEPTED_LINEAGE_STATUSES, FCRP_LINEAGE_STATUSES]
  );

  const registrationCounts = await pool.query(
    `select
       count(*) as registered_count,
       count(*) filter (where mode_of_presentation = 'Online') as online_count,
       count(*) filter (where mode_of_presentation = 'Offline') as offline_count
     from registration
     where conference_id = $1`,
    [conferenceId]
  );

  // Scoped to the FCRP lineage (not just the two literal
  // REGISTRATION_STATUSES), same as the counters above: once a registered
  // submission is scored or marked presented its status moves on to
  // "Poster Scored"/"Presentation Completed", and it should stay on this
  // list (still registered, just further along) rather than disappear.
  const submissionsResult = await pool.query(
    `select s.submission_id, s.title, s.primary_author, s.co_authors, s.paper_number, s.submission_status,
            r.mode_of_presentation, r.link_to_video, r.attending_offline
     from submissions s
     left join registration r on r.submission_id = s.submission_id
     where s.conference_id = $1 and s.submission_status = ANY($2)
     order by s.paper_number`,
    [conferenceId, FCRP_LINEAGE_STATUSES]
  );

  const authorEmails = [...new Set(
    submissionsResult.rows.flatMap((s) => [s.primary_author, ...(s.co_authors || [])]).filter(Boolean)
  )];
  const usersResult = authorEmails.length
    ? await pool.query("select email, name from users where email = ANY($1)", [authorEmails])
    : { rows: [] };
  const nameByEmail = Object.fromEntries(usersResult.rows.map((u) => [u.email, u.name]));
  const formatNameEmail = (email) => (nameByEmail[email] ? `${nameByEmail[email]} (${email})` : email);

  const rows = submissionsResult.rows.map((s) => ({
    submissionId: s.submission_id,
    paperId: formatPaperId(s.paper_number) || "—",
    title: s.title,
    primaryAuthor: formatNameEmail(s.primary_author),
    coAuthors: Array.isArray(s.co_authors) && s.co_authors.length ? s.co_authors.map(formatNameEmail).join(", ") : "None",
    submissionStatus: s.submission_status,
    registered: s.mode_of_presentation != null,
    modeOfPresentation: s.mode_of_presentation,
    linkToVideo: s.link_to_video,
    attendingOffline: s.attending_offline,
  }));

  return {
    conference,
    rows,
    counts: {
      accepted: Number(statusCounts.rows[0].accepted_count),
      fcrpSubmitted: Number(statusCounts.rows[0].fcrp_count),
      registered: Number(registrationCounts.rows[0].registered_count),
      online: Number(registrationCounts.rows[0].online_count),
      offline: Number(registrationCounts.rows[0].offline_count),
    },
  };
}

app.get("/chair/dashboard/registrations/:id", checkChairAuth, async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  try {
    const data = await loadRegistrationsDashboardData(req.params.id);
    if (!data) {
      return res.redirect("/chair/dashboard?message=Conference not found.");
    }
    return res.render("chair/registrations.ejs", {
      conference: data.conference,
      rows: data.rows,
      counts: data.counts,
      message: req.query.message || null,
    });
  } catch (err) {
    console.error("Error loading registrations dashboard:", err);
    return res.redirect("/chair/dashboard?message=Error loading registrations.");
  }
});

app.get("/chair/dashboard/registrations/:id/export", checkChairAuth, conferenceOperationCooldown("registrations-export", 10), async (req, res) => {
  if (!(await chairOwnsConference(req.user.email, req.params.id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to manage this conference.");
  }
  try {
    const data = await loadRegistrationsDashboardData(req.params.id);
    if (!data) {
      return res.redirect("/chair/dashboard?message=Conference not found.");
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Registrations");
    sheet.columns = [
      { header: "Paper ID", key: "paperId", width: 12 },
      { header: "Title", key: "title", width: 40 },
      { header: "Primary Author", key: "primaryAuthor", width: 30 },
      { header: "Co-Authors", key: "coAuthors", width: 40 },
      { header: "Submission Status", key: "submissionStatus", width: 30 },
      { header: "Registration Status", key: "registrationStatus", width: 20 },
      { header: "Mode of Presentation", key: "modeOfPresentation", width: 20 },
      { header: "Attending Offline", key: "attendingOffline", width: 16 },
      { header: "Link to Video", key: "linkToVideo", width: 40 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const row of data.rows) {
      sheet.addRow({
        paperId: row.paperId,
        title: row.title,
        primaryAuthor: row.primaryAuthor,
        coAuthors: row.coAuthors,
        submissionStatus: row.submissionStatus,
        registrationStatus: row.registered ? "Registered" : "Not Registered",
        modeOfPresentation: row.modeOfPresentation || "",
        attendingOffline: row.attendingOffline ?? "",
        linkToVideo: row.linkToVideo || "",
      });
    }

    const fileName = `registrations-${data.conference.conference_id}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error("Error exporting registrations:", err);
    return res.redirect("/chair/dashboard?message=Error exporting registrations.");
  }
});

// DB-03 (security-audit/COMPLETE_FINDINGS_REGISTER.md): shared by both
// submission-delete routes below so neither one can drift out of sync with
// the other on which child tables it cleans up. Must run inside a caller-
// owned transaction (BEGIN already issued on `client`) and does not delete
// the submission's own row - the caller does that last, after this returns,
// so it can still read submission fields (primary_author, co_authors, etc.)
// beforehand for cache invalidation without a second round-trip.
//
// role_certificates is deliberately NOT included here: its context_id is
// never a submission_id for any role (reviewer/session_chair use a
// track_id, invited_speaker uses invited_talk_submissions.paper_id, which
// is a separate table/id space from submissions.submission_id) - see
// generateAndEmailRoleCertificate's callers.
async function deleteSubmissionCascade(client, submissionId) {
  await client.query("DELETE FROM co_author_requests WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM revised_submissions WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM peer_review WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM final_camera_ready_submissions WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM registration WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM certificates WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM meta_reviewer_decision WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM poster_presentation_scores WHERE submission_id = $1", [submissionId]);
  await client.query("DELETE FROM desk_review WHERE paper_id = $1", [submissionId]);
}

app.post('/chair/dashboard/delete-submission/:id', checkChairAuth, async (req, res) => {
  
  const submissionId = req.params.id;
  const conferenceId = req.query.conference_id;

  console.log('Delete submission request:', { submissionId, conferenceId, query: req.query });

  if (!conferenceId) {
    console.error('Conference ID is missing');
    return res.redirect('/chair/dashboard?message=Error: Conference ID is required.');
  }


  // Note: this must use pool, not deleteClient - that client isn't connected
  // until after this check (it previously referenced deleteClient here, which
  // threw a ReferenceError on every call and crashed the route).
  const submission = await pool.query("select submission_status, conference_id, primary_author, co_authors from submissions where submission_id=$1",[submissionId]);

  if (!submission.rows[0] || !(await chairOwnsConference(req.user.email, submission.rows[0].conference_id))) {
    return res.redirect("/chair/dashboard?message=You are not authorized to delete this submission.");
  }

  if(submission.rows[0].submission_status!='Submitted for Review'){
    return res.redirect("/chair/dashboard?message=This submission cannot be deleted at the moment. Any submission can be deleted only when the submission status is 'Submitted for Review'. Current Submission Status: "+submission.rows[0].submission_status);
  }

  const deleteClient = await pool.connect();
  try {
    await deleteClient.query("BEGIN");
    await deleteSubmissionCascade(deleteClient, submissionId);
    await deleteClient.query(
      `DELETE FROM submissions WHERE submission_id = $1;`,
      [submissionId]
    );

    await deleteClient.query("COMMIT");
    console.log('Submission deleted successfully:', submissionId);

    await invalidateConferenceSubmissionCache(
      [submission.rows[0].primary_author, ...(submission.rows[0].co_authors || [])],
      conferenceId
    );

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
        // FILE-04: type:"private" - see getSignedPaperUrl.
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
          resource_type: "auto",
          type: "private",
          folder: "revised_submissions",
          public_id: `${sanitizeCloudinaryIdSegment(req.user.name)}-${submission_id}-${Date.now()}`,
        });

        //
        // 5. Update submissions status + file_url
        //
        await pool.query(
          `UPDATE submissions SET submission_status = 'Submitted Revised Paper', file_url = $1, file_public_id = $2, file_resource_type = $3, file_format = $4 WHERE submission_id = $5`,
          [uploadResult.secure_url, uploadResult.public_id, uploadResult.resource_type, uploadResult.format, submission_id]
        );

        await invalidateConferenceSubmissionCache(
          [submission.primary_author, ...(submission.co_authors || [])],
          submission.conference_id
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
        `SELECT primary_author, co_authors, submission_status, conference_id, paper_number, paper_code FROM submissions WHERE submission_id = $1 LIMIT 1;`,
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
        // FILE-04: type:"private" - see getSignedPaperUrl.
        const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
          resource_type: "auto",
          type: "private",
          folder: "submissions",
          public_id: `${sanitizeCloudinaryIdSegment(req.user.user_id)}-${Date.now()}`,
        });

        updateFields.push(`file_url = $${index++}`);
        updateValues.push(uploadResult.secure_url);
        updateFields.push(`file_public_id = $${index++}`);
        updateValues.push(uploadResult.public_id);
        updateFields.push(`file_resource_type = $${index++}`);
        updateValues.push(uploadResult.resource_type);
        updateFields.push(`file_format = $${index++}`);
        updateValues.push(uploadResult.format);
      }

      // Add WHERE clause argument
      updateValues.push(id);

      const sql = `
        UPDATE submissions 
        SET ${updateFields.join(", ")}
        WHERE submission_id = $${index};
      `;

      await pool.query(sql, updateValues);

      await invalidateConferenceSubmissionCache(
        [editRow.primary_author, ...(editRow.co_authors || [])],
        editRow.conference_id
      );

      const editConferenceResult = await pool.query("select title from conferences where conference_id = $1", [editRow.conference_id]);
      const editAuthorName = await getUserDisplayName(editRow.primary_author);
      await sendSubmissionLifecycleEmail(
        editRow.primary_author,
        "submission_edited",
        {
          authorName: editAuthorName,
          conferenceName: editConferenceResult.rows[0]?.title || "the conference",
          title,
          paperId: formatPaperId(editRow.paper_number),
          paperCode: editRow.paper_code,
          updatedAt: getCurrentDateTimeIST(),
        },
        editRow.co_authors
      );

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

    const selfDeleteClient = await pool.connect();
    let conferenceId;
    try {
      await selfDeleteClient.query("BEGIN");
      await deleteSubmissionCascade(selfDeleteClient, req.params.id);
      const conference = await selfDeleteClient.query(
        `DELETE FROM submissions WHERE submission_id = $1 AND primary_author = $2 returning conference_id;`,
        [req.params.id, req.user.email]
      );
      await selfDeleteClient.query("COMMIT");
      conferenceId = conference.rows[0]?.conference_id;
    } catch (err) {
      await selfDeleteClient.query("ROLLBACK");
      throw err;
    } finally {
      selfDeleteClient.release();
    }

    if (redisClient && conferenceId) await redisClient.del(submissionsCacheKey(req.user.email, conferenceId));

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
      // FILE-04: type:"private" - see getSignedPaperUrl.
      const uploadResult = await uploadBufferToCloudinary(req.file.buffer, {
        resource_type: "auto",
        type: "private",
        folder: "submissions",
        public_id: `${sanitizeCloudinaryIdSegment((req.user && (req.user.user_id || req.user.email)) || "user")}-${Date.now()}`,
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

      // Sequential, per-conference paper number (e.g. 0001, 0002, ...), distinct
      // from the random paper_code used for co-author linking. Allocated once,
      // outside the retry loop below, since a paper_code collision there is a
      // new attempt at the same submission, not a new paper.
      const paperNumber = await nextPaperNumber(id);

      // Insert into PostgreSQL
      let submission_result;
      for (let insertAttempt = 1; ; insertAttempt++) {
      try {
      submission_result = await pool.query(
        `INSERT INTO submissions
         (conference_id, primary_author, title, abstract, track_id, file_url, file_public_id, file_resource_type, file_format, paper_code, paper_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;`,
        [
          id,
          req.user.email,
          title,
          abstract,
          areas,
          uploadResult.secure_url,
          uploadResult.public_id,
          uploadResult.resource_type,
          uploadResult.format,
          paperCode,
          paperNumber
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
      const cacheKey = submissionsCacheKey(req.user.email, id);
      const newSubmissionItem = submission_result.rows[0];

      const cacheSubmissions = await getJsonCacheValue(cacheKey);

      if (cacheSubmissions) {
        // If cache exists, parse it, push item, rewrite string
        const submissionsArray = cacheSubmissions;
        submissionsArray.push(newSubmissionItem);
        if (redisClient) {
          await redisClient.set(cacheKey, JSON.stringify(submissionsArray), { EX: DATA_CACHE_TTL_SECONDS });
        }
      } else {
        // If cache is empty, seed a brand new array containing the item
        if (redisClient) {
          await redisClient.set(cacheKey, JSON.stringify([newSubmissionItem]), { EX: DATA_CACHE_TTL_SECONDS });
        }
      }
      console.log("ADDED TO CACHE!");

      // Send Confirmation Email
      await sendSubmissionLifecycleEmail(
        req.user.email,
        "submission_created",
        {
          authorName: req.user.name,
          conferenceName: conference_data.rows[0].title,
          title,
          paperId: formatPaperId(paperNumber),
          paperCode,
        }
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
        public_id: `${sanitizeCloudinaryIdSegment(req.user.email)}-${Date.now()}`,
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

// SKIP_AUTOLISTEN: test-only escape hatch. A test that needs the real Redis
// connection above (so it can't set VERCEL=1, which also skips that
// connection) still needs to avoid this module-level app.listen() - an
// unclosable second listener on `port` - and instead call app.listen(0)
// itself and close that one in `after`. Unset in every other environment,
// so normal/dev/production startup is unchanged.
if (process.env.VERCEL !== "1" && process.env.SKIP_AUTOLISTEN !== "1") {
  const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

  // REL-02 (security-audit/COMPLETE_FINDINGS_REGISTER.md): previously
  // there was no SIGTERM/SIGINT handling at all - a container redeploy or
  // orchestrator-initiated restart terminated the process immediately,
  // dropping any in-flight request mid-response instead of letting it
  // finish, and never closing the Postgres pool / Redis client cleanly.
  // Stop accepting new connections first, give in-flight requests a
  // bounded window to finish, then close both clients and exit - repeated
  // signals (e.g. an impatient double Ctrl-C) are handled safely by only
  // acting on the first one and force-exiting if shutdown itself hangs.
  const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: starting graceful shutdown.`);

    const forceExitTimer = setTimeout(() => {
      console.error("Graceful shutdown timed out - forcing exit.");
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    server.close(async (err) => {
      if (err) console.error("Error while closing the HTTP server:", err.message);
      try {
        await pool.end();
      } catch (poolErr) {
        console.error("Error while closing the database pool:", poolErr.message);
      }
      if (redisClient) {
        try {
          await redisClient.quit();
        } catch (redisErr) {
          console.error("Error while closing the Redis client:", redisErr.message);
        }
      }
      clearTimeout(forceExitTimer);
      console.log("Graceful shutdown complete.");
      process.exit(0);
    });
  }
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // Last-resort safety net: a genuinely uncaught exception or unhandled
  // rejection means the process may be in a corrupted/unknown state -
  // logging and continuing would risk serving requests against that state,
  // so this logs with full context and exits, relying on the container/
  // process manager to restart cleanly, rather than limping on.
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception - exiting:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection - exiting:", reason);
    process.exit(1);
  });
}

export default app;

