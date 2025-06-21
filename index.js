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

const app = express();
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: "uploads/" });

app.use(
  session({
    secret: process.env.SESSION_SECRET || "your_secret_key",
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
    } else if (req.user.role === "panelist") {
      return res.redirect("/panelist/dashboard");
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
    failureRedirect: "/?message=You are not authorized to access this page.",
    // successRedirect: "/reviewer/dashboard", // REMOVED
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
      return res.redirect("/?message=We are facing some issues in fetching your assigned tracks. Please try again later. Sincere apologies for the inconvenience caused.");
    }

    // Check if user is a reviewer for any track
    const reviewerTracks = (tracks || []).filter(
      (track) =>
        Array.isArray(track.track_reviewers) &&
        track.track_reviewers.includes(req.user.email)
    );

    if (reviewerTracks.length === 0) {
      return res.redirect("/?message=You are not authorized as a reviewer for any track.");
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
        return res.redirect("/?message=We are facing some issues in fetching the submissions.");
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
    successRedirect: "/chair/dashboard", // REMOVE THIS
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
app.get(
  "/auth/google/dashboard",
  passport.authenticate("google", {
    failureRedirect: "/",
    successRedirect: "/dashboard",
  }),
  async (req, res) => {
    const { data, error } = await supabase.from("conferences").select("*");

    if (error && error.code !== "PGRST116") {
      console.error(error);
      return res.render("error.ejs", {
        message:
          "We are facing some issues in connecting to the database. Please try again later.",
      });
    }

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
      currentDate: new Date().toISOString().split("T")[0], // Pass as YYYY-MM-DD
      // Initialize submissions as an empty array
    });
  }
);
app.get("/panelist/dashboard", (req, res) => {
  res.render("panelist/dashboard.ejs");
});
app.get("/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "author") {
    return res.redirect("/");
  }

  const { data, error } = await supabase.from("conferences").select("*");

  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.render("error.ejs", {
      message:
        "We are facing some issues in connecting to the database. Please try again later.",
    });
  }

  const { data: submissiondata, error: submissionerror } = await supabase
    .from("submissions")
    .select("*")
    .or(
      `primary_author.eq.${req.user.email},co_authors.cs.{${req.user.email}}`
    );

  const { data: presentationdata, error: presentationerror } = await supabase
    .from("conference_tracks")
    .select("*").eq("track_name",submissiondata[0]?.area).single();
    
   

  res.render("dashboard.ejs", {
    user: req.user,
    conferences: data || [],
    userSubmissions: submissiondata || [],
    currentDate: new Date().toISOString().split("T")[0], 
    presentationdata: presentationdata || [],
  });
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
    return res.send(
      "We are facing some issues in fetching your assigned tracks. Please try again later. Sincere apologies for the inconvenience caused."
    );
  }

  // Find all tracks where the user is a reviewer
  const reviewerTracks = (tracks || []).filter(
    (track) =>
      Array.isArray(track.track_reviewers) &&
      track.track_reviewers.includes(req.user.email)
  );

  if (reviewerTracks.length === 0) {
    return res.send(
      "You are not assigned to any tracks. Please contact the conference organizers for more information."
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
  // if (!req.isAuthenticated() || req.user.role !== "chair") {
  //   return res.redirect("/");
  // }

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
  // if (!req.isAuthenticated() || req.user.role !== "chair") {
  //   return res.redirect("/");
  // }

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

  // Fetch all submissions for this conference
  const { data: submissions, error: submissionsError } = await supabase
    .from("submissions")
    .select("area, id")
    .eq("conference_id", req.params.id, "submision_status", "Accepted");

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
  // if (!req.isAuthenticated() || req.user.role !== "chair") {
  //   return res.redirect("/");
  // }

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

  res.redirect(`/chair/dashboard/manage-sessions`);
});

app.get("/panelist/dashboard/active-session/:id", async (req, res) => {
  
const { data: trackinfo, error:trackError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("id", req.params.id)
    .single();
  // Fetch the session details
  const { data: session, error } = await supabase
    .from("final_camera_ready_submissions")
    .select("*")
    .eq("area", trackinfo.track_name);


  if (error) {
    console.error("Error fetching session:", error);
    return res.status(500).send("Error fetching session details.");
  }

  if (!session) {
    return res.status(404).send("Session not found.");
  }
if(trackinfo.status !== "In Progress") {
  return res.send("Unauthorized Access. Session is not in progress.");
}
  res.render("panelist/active-session.ejs", {
    session: session,
    trackinfo: trackinfo,
  });
});
app.post("/start-session", async (req,res) => {
 
  const { session_code } = req.body;

  // Fetch the track to verify the session code
  const { data: track, error: trackError } = await supabase
    .from("conference_tracks")
    .select("*")
    .eq("session_code", session_code)
    .single();


  if (trackError || !track) {
    console.error("Error fetching track:", trackError);
    return res.status(500).send("Error starting the session.");
  }

  if (track.session_code !== session_code) {
    return res.status(400).send("Invalid session code.");
  }

  // Update the status of the track to 'In Progress'
  const { error: updateError } = await supabase
    .from("conference_tracks")
    .update({ status: "In Progress" })
    .eq("session_code", session_code);

  if (updateError) {
    console.error("Error updating track status:", updateError);
    return res.status(500).send("Error starting the session.");
  }

  res.redirect(`/panelist/dashboard/active-session/${track.id}`);

  await supabase.from("conference_tracks").update({"session_code": null}).eq("id", track.id);
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
  // if (!req.isAuthenticated() || req.user.role !== "chair") {
  //   return res.redirect("/");
  // }

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
    const { error: updateError } = await supabase.from("sessions").insert({
      conference_id: conferenceId,
      session_title: track.track_name,
      session_date: session_date,
      session_start_time: session_start_time,
      session_end_time: session_end_time,
      panelists: session_panelists,
      status: "Scheduled",
    });

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

  const { data, error } = await supabase
    .from("peer_review")
    .insert({
      conference_id: conference_id,
      paper_id: paper_id,
      review_status: "Reviewed",
      remarks: remarks,
      originality_score: originality_score,
      relevance_score: relevance_score,
      technical_quality_score: technical_quality_score,
      clarity_score: clarity_score,
      impact_score: impact_score,
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

app.get("/chair/dashboard/delete-conference/:id", async (req, res) => {
  // if (!req.isAuthenticated() || req.user.role !== "chair") {
  //   return res.redirect("/");
  // }

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
    .eq("id", req.params.id)
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
    console.error("Error fetching submission:", error);
    return res.status(500).send("Error joining submission.");
  }

  if (!data) {
    return res.status(404).send("Submission not found.");
  }

  let coAuthors = data.co_authors || [];
  if (data.primary_author_uid === req.user.uid) {
    return res
      .status(400)
      .send("You are already the primary author of this submission.");
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
    console.error("Error updating co-author:", updateError);
    return res.status(500).send("Error joining submission.");
  }

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
    // ...other fields...
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

  res.redirect("/dashboard");
});

app.get("/chair/create-new-conference", (req, res) => {
  res.render("chair/create-new-conference.ejs");
});
app.get("/submission/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  // Fetch conference
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
  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("id", req.params.id)
    .single();

  res.render("submission3.ejs", { user: req.user, submission: data });
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
      .eq("id", req.params.id)
      .single();
    if (data.submission_status == "Submitted for Review") {
      return res.status(403).send("Review is still in Progress.");
    } else if (data.submission_status == "Rejected") {
      return res.status(403).send("Submission has been Rejected.");
    } else if (data.submission_status == "Submitted Final Camera Ready Paper") {
      return res
        .status(403)
        .send("Final Camera Ready Paper has already been submitted.");
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
        paper_id: id,
        primary_author: req.user.name,
        title: title,
        abstract: abstract,
        area: areas,
        co_authors: co_authors,
        file_url: uploadResult.secure_url,
      })
      .eq("id", id);

    await supabase
      .from("submissions")
      .update({
        submission_status: "Submitted Final Camera Ready Paper",
        file_url: uploadResult.secure_url,
      })
      .eq("id", id);

    if (error) {
      console.error("Error inserting submission:", error);
      return res.status(500).send("Error submitting your proposal.");
    } else {
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
  // if (!req.isAuthenticated() || req.user.role !== "chair") {
  //   return res.redirect("/");
  // }

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
    // ...other fields...
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

  // 2. Delete old tracks for this conference
  const { error: delError } = await supabase
    .from("conference_tracks")
    .delete()
    .eq("conference_id", conferenceId);

  if (delError) {
    console.error("Error deleting old tracks:", delError);
    return res.status(500).send("Error updating tracks.");
  }

  // 3. Insert new/edited tracks
  const tracks = [];
  let i = 1;
  while (req.body[`track_title_${i}`] && req.body[`track_reviewer_${i}`]) {
    tracks.push({
      conference_id: conferenceId,
      track_name: req.body[`track_title_${i}`],
      track_reviewers: [req.body[`track_reviewer_${i}`]], // as array
    });
    i++;
  }

  if (tracks.length > 0) {
    const { error: tracksError } = await supabase
      .from("conference_tracks")
      .insert(tracks);
    if (tracksError) {
      console.error("Error inserting tracks:", tracksError);
      return res.status(500).send("Error updating tracks.");
    }
  }

  res.redirect("/chair/dashboard");
});
app.get("/chair/dashboard/view-submissions/:id", async (req, res) => {
  // if (!req.isAuthenticated() || req.user.role !== "chair") {
  //   return res.redirect("/");
  // }

  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("conference_id", req.params.id);

  if (error) {
    console.error("Error fetching submissions:", error);
    return res.status(500).send("Error fetching submissions.");
  }

  res.render("chair/view-submissions.ejs", {
    user: req.user,
    submissions: data || [],
  });
});
app.post("/edit-submission", upload.single("file"), async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const { title, abstract, areas, id } = req.body;
  const filePath = req.file.path;
  const uploadResult = await cloudinary.uploader.upload(filePath, {
    resource_type: "auto", // auto-detect type (pdf, docx, etc.)
    folder: "submissions",
    public_id: `${req.user.name}-${Date.now()}`,
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
    .from("submissions")
    .update({
      title: title,
      abstract: abstract,
      area: areas,
      file_url: uploadResult.secure_url,
      score: score,
    })
    .eq("id", id);

  if (error) {
    console.error("Error inserting submission:", error);
    return res.status(500).send("Error submitting your proposal.");
  } else {
    res.redirect("/dashboard");
  }
});

app.get("/submission/delete/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const { data, error } = await supabase
    .from("submissions")
    .delete()
    .eq("id", req.params.id);
  res.redirect("/dashboard");
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
      score: score,
    },
  ]);

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
      callbackURL: "https://confease.onrender.com/auth/google/dashboard",
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
              role: "author",
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
      callbackURL: "https://confease.onrender.com/auth3/google/dashboard3",
      userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo",
    },
    async (accessToken, refreshToken, profile, cb) => {
      try {
        // Find chair by email
        const { data: chair, error } = await supabase
          .from("chair")
          .select("*")
          .eq("email_id", profile.emails[0].value)
          .single();

        if (error || !chair) {
          // Not a valid chair
          return cb(
            null,
            false,
            { message: "You are not authorized as a chair for this conference." }
          );
        }

        // If profile_picture is empty, update it
        if (!chair.profile_picture || !chair.name || !chair.uid) {
          await supabase
            .from("chair")
            .update({ profile_picture: profile.photos[0].value, name: profile.displayName, uid: profile.id })
            .eq("email_id", profile.emails[0].value);
        }

        chair.role = "chair";
        return cb(null, chair);
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
      callbackURL: "https://confease.onrender.com/auth2/google/dashboard2",
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
              role: "reviewer",
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
        user.role = "reviewer";
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
// passport.serializeUser((user, cb) => {
//   cb(null, user);
// });

// passport.deserializeUser((user, cb) => {
//   cb(null, user);
// });

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
