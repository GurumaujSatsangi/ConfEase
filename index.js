import express from "express";
import bodyParser from "body-parser";
import passport from "passport";
import { v4 as uuidv4 } from "uuid";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
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

const app = express();





dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: "uploads/" });

app.use(
  session({
    secret: process.env.SESSION_SECRET || "deimml",
    resave: false,
    saveUninitialized: false,
  })
);

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
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.set("view engine", "ejs");
app.use("/static", express.static(path.join(__dirname, "public")));

app.set("views", path.join(__dirname, "views"));
app.use(passport.initialize());
app.use(passport.session());

app.get("/", async (req, res) => {
  if (req.isAuthenticated()) {
    if (req.user.role === "author") {
      return res.redirect("/dashboard");
    } else if (req.user.role === "reviewer") {
      return res.redirect("/reviewer/dashboard");
    } else if (req.user.role === "chair") {
      return res.redirect("/chair/dashboard");
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
  "/auth2/google/dashboard2",
  passport.authenticate("google2", {
    failureRedirect:
      "/?message=You have not been assigned any tracks. Please contact the conference organizers for more information.s",
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
    const trackNames = reviewerTracks.map((track) => track.track_name);
    let submissiondata = [];
    if (trackNames.length > 0) {
      const { data: submissions, error: submissionerror } = await supabase
        .from("submissions")
        .select("*")
        .in("area", trackNames);

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
      const trackNames = reviewerTracks.map((track) => track.track_name);

      // Fetch all submissions for these tracks
      let submissiondata = [];
      if (trackNames.length > 0) {
        const { data: submissions, error: submissionerror } = await supabase
          .from("submissions")
          .select("*")
          .in("area", trackNames);

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
app.get(
  "/auth/google/dashboard",
  passport.authenticate("google", {
    failureRedirect: "/",
    // successRedirect: "/dashboard", // REMOVE THIS
  }),
  (req, res) => {
    // Now this handler will be called after successful login
    res.redirect("/dashboard");
  }
);

app.get("/dashboard", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
if (req.user.role !== "author") {
    return res.redirect("/?message=You are not authorized to access the author dashboard.");
  }
  const { data, error } = await supabase.from("conferences").select("*");

  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.redirect(
      "/?message=We are facing some issues in connecting to the database. Please try again later."
    );
  }

  // Get all user's submissions (remove .single())
  const { data: trackinfodata, error: trackinfoError } = await supabase
    .from("submissions")
    .select("area")
    .or(
      `primary_author.eq.${req.user.email},co_authors.cs.{${req.user.email}}`
    );

  // Get unique areas from all submissions
  const areas = [...new Set((trackinfodata || []).map((t) => t.area))];

  // Get presentation data for all areas (use .in() instead of .eq())
  let presentationdatainfo = [];
  if (areas.length > 0) {
    const { data: presentationData, error: presentationError } = await supabase
      .from("conference_tracks")
      .select("*")
      .in("track_name", areas);

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

  res.render("dashboard.ejs", {
    user: req.user,
    conferences: data || [],
    userSubmissions: submissiondata || [],
    presentationdata: presentationdatainfo || [],
    currentDate: new Date().toISOString().split("T")[0],
    message: req.query.message || null,
  });
});

app.post("/publish/review-results", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { conference_id } = req.body;

  if (!conference_id || isNaN(Number(conference_id))) {
    return res.status(400).send("Invalid or missing conference_id.");
  }

  const confId = Number(conference_id);

  const { data: reviewdata, error: reviewdataError } = await supabase
    .from("peer_review")
    .select("*")
    .eq("conference_id", confId);

  if (reviewdataError) {
    console.error("Error fetching tracks:", reviewdataError);
    return res.status(500).send("Error.");
  }

  for (const data of reviewdata) {
    const { error: updateError } = await supabase
      .from("submissions")
      .update({ submission_status: data.acceptance_status , })
      .eq("id", data.paper_id);

    if (updateError) {
      console.error(`Error updating track ${data.id}:`, updateError);
      return res.status(500).send(`Error updating track ${data.id}.`);
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

  const { data: tracks, error } = await supabase
    .from("conference_tracks")
    .select("*");
  if (error && error.code !== "PGRST116") {
    console.error(error);
    res.redirect(
      "/reviewer/dashboard?message=We are facing some issues in connecting to the database. Please try again later."
    );
  }
  // Find all tracks where the user is a reviewer
  const reviewerTracks = (tracks || []).filter(
    (track) =>
      Array.isArray(track.track_reviewers) &&
      track.track_reviewers.includes(req.user.email)
  );

  if (reviewerTracks.length === 0) {
    res.redirect(
      "/?message=You are not assigned to any tracks. Please contact the conference organizers for more information."
    );
  }

  // Collect all track names
  const trackNames = reviewerTracks.map((track) => track.track_name);

  // Fetch all submissions for these tracks
  let submissiondata = [];
  if (trackNames.length > 0) {
    const { data: submissions, error: submissionerror } = await supabase
      .from("submissions")
      .select("*")
      .in("area", trackNames);

    if (submissionerror) {
      console.error(submissionerror);
      return res.send("Error fetching submissions.");
    }
    submissiondata = submissions || [];
  }

  res.render("reviewer/dashboard", {
    user: req.user,
    tracks: reviewerTracks,
    userSubmissions: submissiondata,
    message: "Welcome",
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
    .eq("id", req.params.id)
    .single();

  if (trackError) {
    console.error("Error fetching data:", trackError);
    return res.status(500).send("Error fetching sessions.");
  }

  res.render("chair/edit-sessions.ejs", {
    user: req.user,
    trackid: req.params.id,
    track: track || {},
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
    .eq("id", req.params.id)
    .single();

  const { data: submissions, error: submissionsError } = await supabase
    .from("submissions")
    .select("area, id")
    .eq("conference_id", req.params.id)
    .eq("submission_status", "Accepted"); // Fixed typo: submision -> submission

  // Count submissions per track (area)
  const trackCounts = {};
  (submissions || []).forEach((sub) => {
    trackCounts[sub.area] = (trackCounts[sub.area] || 0) + 1;
  });

  // Convert to array for EJS
  const count = Object.entries(trackCounts).map(([area, count]) => ({
    area,
    count,
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
    tracks: tracks || [],
    conference: conference || {},
    count: count || [],
  });
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
      session_code: otp,
    })
    .eq("id", trackId);

  if (error) {
    console.error("Error inserting session:", error);
    return res.status(500).send("Error setting up the session.");
  }

  res.redirect(
    `/chair/dashboard/manage-sessions/${req.body.conference_id || ""}`
  );
});

app.get("/panelist/dashboard/active-session/:id", async (req, res) => {
  
  const { data: trackinfo, error: trackError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (trackError || !trackinfo) {
    return res.redirect("/panelist/dashboard?message=Track not found.");
  }

  

  // Rest of your existing code...
  const { data: session, error } = await supabase
    .from("final_camera_ready_submissions")
    .select("*")
    .eq("area", trackinfo.track_name);

  if (error) {
    console.error("Error fetching session:", error);
    return res.status(500).send("Error fetching session details.");
  }

  if (!session || session.length === 0) {
    return res.redirect("/panelist/dashboard?message=No submissions found for this track.");
  }
  
  res.render("panelist/active-session.ejs", {
    session: session,
    trackinfo: trackinfo,
    message: req.query.message || null,
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
        .eq("id", track.id);

      if (updateError) {
        console.error("Error updating track:", updateError);
        return res.redirect("/panelist/dashboard?message=Error starting session.");
      }

      return res.redirect(`/panelist/dashboard/active-session/${track.id}`);
    }
  } else {
    return res.redirect("/panelist/dashboard?message=Session date mismatch.");
  }
});
app.get("/reviewer/dashboard/review/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("paper_code", req.params.id)
    .single();

  if (data.submission_status == "Reviewed") {
    return res.render("error.ejs", {
      message:
        "This submission has been reviewed. A submission can be reviewed only once.",
    });
  }

  if (error) {
    console.error("Error fetching submission:", error);
    return res.render("error.ejs", {
      message: "We are facing some issues in fetching the submissions.",
    });
  }

  if (!data) {
    return res.render("error.ejs", {
      message: "The submission you are trying to view does not exist.",
    });
  }

  res.render("reviewer/review", {
    user: req.user,
    userSubmissions: data,
  });
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
    }).eq("id", track.id);

    if (updateError) {
      console.error(`Error updating track ${track.track_name}:`, updateError);
      return res
        .status(500)
        .send(`Error updating session for track ${track.track_name}.`);
    }
  }

  res.redirect(`/chair/dashboard`);
});
app.post("/mark-as-reviewed", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const {
    paper_id,
    conference_id,
    status,
    originality_score,
    relevance_score,
    technical_quality_score,
    clarity_score,
    impact_score,
    remarks,
  } = req.body;

  const { data, error } = await supabase.from("peer_review").insert({
    conference_id: conference_id,
    paper_id: paper_id,
    review_status: "Reviewed",
    remarks: remarks,
    originality_score: originality_score,
    relevance_score: relevance_score,
    technical_quality_score: technical_quality_score,
    clarity_score: clarity_score,
    impact_score: impact_score,
    mean_score: (originality_score+relevance_score+technical_quality_score+clarity_score+impact_score)/5,
    reviewer: req.user.email,
    acceptance_status: status,
  });
  await supabase
    .from("submissions")
    .update({ submission_status: "Reviewed", remarks: remarks })
    .eq("id", paper_id);

  if (error) {
    console.error("Error updating submission:", error);
    return res.render("error.ejs", {
      message:
        "We are facing some issues in marking this submission as reviewed.",
    });
  }

  // Fetch tracks for the reviewer
  const { data: tracks, error: tracksError } = await supabase
    .from("conference_tracks")
    .select("*");

  if (tracksError) {
    console.error("Error fetching tracks:", tracksError);
    return res.render("error.ejs", {
      message: "We are facing some issues in fetching tracks.",
    });
  }

  // Fetch submissions for the reviewer (if needed)
  const reviewerTracks = (tracks || []).filter(
    (track) =>
      Array.isArray(track.track_reviewers) &&
      track.track_reviewers.includes(req.user.email)
  );

  const trackNames = reviewerTracks.map((track) => track.track_name);

  let submissiondata = [];
  if (trackNames.length > 0) {
    const { data: submissions, error: submissionerror } = await supabase
      .from("submissions")
      .select("*")
      .in("area", trackNames);

    if (submissionerror) {
      console.error(submissionerror);
      return res.render("error.ejs", {
        message: "We are facing some issues in fetching the submissions.",
      });
    }
    submissiondata = submissions || [];
  }

  res.render("reviewer/dashboard.ejs", {
    user: req.user,
    tracks: reviewerTracks,
    userSubmissions: submissiondata,
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

  // Convert paper_id to number (for bigint column)
  const paperIdValue = Number(paper_id);
  if (isNaN(paperIdValue)) {
    return res.render("error.ejs", {
      message: "Invalid paper ID provided",  
    });
  }

  // Update submissions table
  const { data, error } = await supabase
    .from("submissions")
    .update({ submission_status: "Presentation Completed" })
    .eq("id", paperIdValue);

  // Update final_camera_ready_submissions table
  const { data: finalpresentation, error: finalpresentationerror } = await supabase
    .from("final_camera_ready_submissions")
    .update({ panelist_score: scoreValue,status:"Completed" }) // Remove quotes around column name
    .eq("paper_id", paperIdValue);
    
  if (error || finalpresentationerror) {
    console.error("Error updating submission:", error || finalpresentationerror);
    return res.render("error.ejs", {
      message: "We are facing some issues in marking this submission as completed.",  
    });
  }

  // Redirect to active session with success message
  res.redirect(`/panelist/dashboard/active-session/${track_id}?message=Submission has been successfully marked as completed.`);
});



app.get("/chair/dashboard/delete-conference/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { error } = await supabase
    .from("conferences")
    .delete()
    .eq("id", req.params.id);

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

  let coAuthors = data.co_authors || [];
  // In /join route - add return statements:
  if (data.primary_author === req.user.email) {
    return res.redirect(
      "/dashboard?message=You are the primary author of this paper. You cannot join as a co-author."
    );
  } else if (coAuthors.includes(req.user.email)) {
    return res.redirect(
      "/dashboard?message=You are already a co-author of this paper"
    );
  } else if (!coAuthors.includes(req.user.email)) {
    coAuthors.push(req.user.email);
  }

  // Update the row with the new array
  const { error: updateError } = await supabase
    .from("submissions")
    .update({ co_authors: coAuthors })
    .eq("paper_code", paper_code)
    .eq("conference_id", id);

  if (updateError) {
    console.error("Error inserting co-author:", insertError);
    return res.status(500).send("Error joining submission.");
  }

  res.redirect("/dashboard");
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
    ])
    .select()
    .single();

  if (confError) {
    console.error("Error inserting conference:", confError);
    return res.status(500).send("Error creating conference.");
  }

  // 2. Collect tracks from req.body
  const tracks = [];
  let i = 1;
  while (req.body[`track_title_${i}`] && req.body[`track_reviewer_${i}`]) {
    tracks.push({
      conference_id: confData.id,
      track_name: req.body[`track_title_${i}`],
      track_reviewers: [req.body[`track_reviewer_${i}`]], // store as array
    });
    i++;
  }

  // 3. Insert tracks into conference_tracks table
  if (tracks.length > 0) {
    const { error: tracksError } = await supabase
      .from("conference_tracks")
      .insert(tracks);
    if (tracksError) {
      console.error("Error inserting tracks:", tracksError);
      return res.status(500).send("Error creating tracks.");
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

    // Additional check - prevent editing if submission is under review or later stages
    if (submission.submission_status === "Reviewed" || 
        submission.submission_status === "Accepted" || 
        submission.submission_status === "Rejected" ||
        submission.submission_status === "Submitted Final Camera Ready Paper") {
      return res.redirect("/dashboard?message=Cannot edit submission in current status: " + submission.submission_status);
    }

    // Fetch tracks using the conference_id from the submission
    const { data: tracks, error: tracksError } = await supabase
      .from("conference_tracks")
      .select("track_name", "track_id") // Only select needed fields
      .eq("conference_id", submission.conference_id)
      .order("track_name"); // Order alphabetically 

    if (tracksError) {
      console.error("Error fetching tracks:", tracksError);
      // Continue without tracks data rather than failing completely
    }

    



    res.render("submission3.ejs", { 
        user: req.user, 
      submission: submission, 
      tracks: tracks || [] 
    });

  } catch (error) {
    console.error("Error in edit submission route:", error);
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
    if (data.submission_status == "Submitted for Review") {
      return res.redirect(
        "/dashboard?message=Your submission is under review."
    );
    } else if (data.submission_status == "Rejected") {
return res.redirect(
        "/dashboard?message=Your submission has been rejected."
    );    } else if (data.submission_status == "Submitted Final Camera Ready Paper") {
      return res.redirect(
        "/dashboard?message=You have already submitted the final camera ready paper for this submission."
    );
    } else {
      res.render("submission4.ejs", { user: req.user, submission: data });
    }
  }
);

app.post(
  "/final-camera-ready-submission",
  upload.single("file"),
  async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.redirect("/");
    }
    const { title, abstract, areas, id, co_authors } = req.body;
    const filePath = req.file.path;
    const uploadResult = await cloudinary.uploader.upload(filePath, {
      resource_type: "auto", // auto-detect type (pdf, docx, etc.)
      folder: "submissions",
      public_id: `${req.user.name}-${Date.now()}-Final`,
    });

    const payload = {
      file: uploadResult.secure_url,
      language: "en",
      country: "us",
    };

    const options = {
      method: "POST",
      headers: {
        Authorization: process.env.WINSTON_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    };
    var score = 0; // Initialize score variable
    fetch("https://api.gowinston.ai/v2/plagiarism", options)
      .then((response) => response.json())
      .then((data) => {
        score = data.result?.score;
      })
      .catch((err) => console.error("API Error:", err));

    const { data, error } = await supabase
      .from("final_camera_ready_submissions")
      .insert({
        submission_id: id,
        primary_author: req.user.name,
        title: title,
        abstract: abstract,
        area: areas,
        co_authors: co_authors,
        file_url: uploadResult.secure_url,
      });

   

    if (error) {
      console.error("Error inserting submission:", error);
      return res.status(500).send("Error submitting your proposal.");
    } else {
       await supabase
      .from("submissions")
      .update({
        submission_status: "Submitted Final Camera Ready Paper",
        file_url: uploadResult.secure_url,
      })
      .eq("submission_id", id);
      res.redirect("/dashboard");
    }
  }
);

app.get("/chair/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }
  const { data, error } = await supabase.from("conferences").select("*");

  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.send("Database error!");
  }

  res.render("chair/dashboard.ejs", {
    user: req.user,
    conferences: data || [],
  });
});

app.get("/chair/dashboard/edit-conference/:id", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "chair") {
    return res.redirect("/");
  }

  const { data: conference, error } = await supabase
    .from("conferences")
    .select("*")
    .eq("id", req.params.id)
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
    .eq("id", conferenceId);

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
      .eq("id", existingTrack.id);

    if (updateError) {
      console.error(`Error updating track ${existingTrack.id}:`, updateError);
      return res.status(500).send(`Error updating track ${existingTrack.track_name}.`);
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
  }

  // 6. If there are fewer new tracks than existing ones, delete the extra ones
  if (newTracks.length < existingTracks.length) {
    const tracksToDelete = existingTracks.slice(newTracks.length);
    const trackIdsToDelete = tracksToDelete.map(track => track.id);

    const { error: deleteError } = await supabase
      .from("conference_tracks")
      .delete()
      .in("id", trackIdsToDelete);

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

  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("conference_id", req.params.id);

    const {data:confdata, error: conferror} = await supabase
    .from("conferences")
    .select("*")
    .eq("id", req.params.id).single();

  if (error) {
    console.error("Error fetching submissions:", error);
    return res.status(500).send("Error fetching submissions.");
  }

  res.render("chair/view-submissions.ejs", {
    user: req.user,
    submissions: data || [],
    conferencedata: req.params.id,
    confdata: confdata || {},
  });
});
app.post("/edit-submission", upload.single("file"), async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const { title, abstract, areas, id } = req.body;

  try {
    // Prepare the update data
    const updateData = {
      title: title,
      abstract: abstract,
      area: areas,
    };

    // Only process file upload if a file was actually uploaded
    if (req.file) {
      const filePath = req.file.path;
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        resource_type: "auto",
        folder: "submissions",
        public_id: `${req.user.name}-${Date.now()}`,
      });

      // Add plagiarism check for new file
      const payload = {
        file: uploadResult.secure_url,
        language: "en",
        country: "us",
      };

      const options = {
        method: "POST",
        headers: {
          Authorization: process.env.WINSTON_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      };

      let score = 0;
      try {
        const response = await fetch("https://api.gowinston.ai/v2/plagiarism", options);
        const data = await response.json();
        score = data.result?.score || 0;
      } catch (err) {
        console.error("API Error:", err);
      }

      // Update file-related fields only if new file was uploaded
      updateData.file_url = uploadResult.secure_url;
      updateData.score = score;

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

app.post("/submit", upload.single("file"), async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const { title, abstract, areas, id } = req.body;
  const filePath = req.file.path;
  const uploadResult = await cloudinary.uploader.upload(filePath, {
    resource_type: "auto", // auto-detect type (pdf, docx, etc.)
    folder: "submissions",
    public_id: `${req.user.uid}-${Date.now()}`,
  });

  const payload = {
    file: uploadResult.secure_url,
    language: "en",
    country: "us",
  };

  const options = {
    method: "POST",
    headers: {
      Authorization: process.env.WINSTON_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
  var score = 0; // Initialize score variable
  fetch("https://api.gowinston.ai/v2/plagiarism", options)
    .then((response) => response.json())
    .then((data) => {
      score = data.result?.score;
    })
    .catch((err) => console.error("API Error:", err));

  const { data, error } = await supabase.from("submissions").insert([
    {
      conference_id: id,
      primary_author: req.user.email,
      title: title,
      abstract: abstract,
      area: areas,
      file_url: uploadResult.secure_url,
      paper_code: crypto.randomUUID(),
    },
  ]);

  await sendMail(
  req.user.email,   // ✅ no EJS tags here
  "Your paper titled - " + title + " has been submitted successfully!",
  "Hello " + req.user.name + ", your paper titled '" + title + "' has been submitted successfully!",
  `<p>Hello <b>${req.user.name}</b>,<br>Your paper titled <i>${title}</i> has been submitted successfully!</p>`
);

  

  if (error) {
    console.error("Error inserting submission:", error);
    return res.status(500).send("Error submitting your proposal.");
  } else {
    res.redirect("/dashboard");
  }
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
        const result = await supabase
          .from("users")
          .select("*")
          .eq("uid", profile.id)
          .single();
        let user;
        if (!result.data) {
          const { error } = await supabase.from("users").insert([
            {
              uid: profile.id,
              name: profile.displayName,
              email: profile.emails[0].value,
              profile_picture: profile.photos[0].value,
            },
          ]);
          if (error) {
            console.error("Error inserting user:", error);
            return cb(error);
          }
          const { data: newUser, error: fetchError } = await supabase
            .from("users")
            .select("*")
            .eq("uid", profile.id)
            .single();
          if (fetchError) {
            console.error("Fetch after insert failed:", fetchError);
            return cb(fetchError);
          }
          user = newUser;
        } else {
          user = result.data;
        }
        user.role = "author";
        return cb(null, user);
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

        // Do NOT insert into users table. Just use Google profile info.
        const user = {
          uid: profile.id,
          name: profile.displayName,
          email: profile.emails[0].value,
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

