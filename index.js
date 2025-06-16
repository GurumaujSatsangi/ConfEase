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
  api_secret: process.env.CLOUDINARY_API_SECRET
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
    return res.redirect("/dashboard");
  }
const { data, error } = await supabase.from("conferences").select("*");
  res.render("home.ejs", {conferences:data });
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
  "/auth2/google/dashboard2",
  passport.authenticate("google2", {
    failureRedirect: "/",
    successRedirect: "/reviewer/dashboard",
  }),
  async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.redirect("/");
    }

    const { data, error } = await supabase.from("conference_tracks").select("*");
  const reviewerTracks = (data || []).filter(track =>
  Array.isArray(track.track_reviewers) && track.track_reviewers.includes(req.user.email)
);

if (reviewerTracks.length > 0) {
  const trackNames = reviewerTracks.map(track => track.track_name);

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
  });
} else {
  res.send("You are not assigned to any tracks. Please contact the conference organizers for more information.");
}
    if (error && error.code !== "PGRST116") {
      console.error(error);
      return res.send("We are facing some issues in fetching your assigned tracks. Please try again later. Sincere apologies for the inconvenience caused.");
    }
  }
);

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
      return res.send("Database error!");
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
        currentDate: new Date().toISOString().split('T')[0], // Pass as YYYY-MM-DD
// Initialize submissions as an empty array
    });
  }
);

app.get("/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "author") {
    return res.redirect("/");
  }

  const { data, error } = await supabase.from("conferences").select("*");

  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.send("Database error!");
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
      currentDate: new Date().toISOString().split('T')[0], // Pass as YYYY-MM-DD
 // Initialize submissions as an empty array
  });
});

app.get("/reviewer/dashboard", async (req, res) => {
  if (!req.isAuthenticated() || req.user.role !== "reviewer") {
    return res.redirect("/");
  }

  const { data: tracks, error } = await supabase.from("conference_tracks").select("*");
  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.send("We are facing some issues in fetching your assigned tracks. Please try again later. Sincere apologies for the inconvenience caused.");
  }

  // Find all tracks where the user is a reviewer
  const reviewerTracks = (tracks || []).filter(track =>
    Array.isArray(track.track_reviewers) && track.track_reviewers.includes(req.user.email)
  );

  if (reviewerTracks.length === 0) {
    return res.send("You are not assigned to any tracks. Please contact the conference organizers for more information.");
  }

  // Collect all track names
  const trackNames = reviewerTracks.map(track => track.track_name);

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
  });
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

  if(data.submission_status == "Reviewed") {
    return res.status(403).send("This submission has already been reviewed.");
  }

  if (error) {
    console.error("Error fetching submission:", error);
    return res.status(500).send("Error fetching submission.");
  }

  if (!data) {
    return res.status(404).send("Submission not found.");
  }

  res.render("reviewer/review", {
    user: req.user,
    userSubmissions: data,
  });
});

app.post("/mark-as-reviewed", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const { paper_id, conference_id,status,originality_score,relevance_score,technical_quality_score,clarity_score,impact_score, remarks } = req.body;

  const { data, error } = await supabase
    .from("peer_review")
    .insert({ conference_id: conference_id, paper_id: paper_id, review_status: "Reviewed", remarks: remarks, originality_score: originality_score, relevance_score: relevance_score, technical_quality_score: technical_quality_score, clarity_score: clarity_score, impact_score: impact_score, acceptance_status: status })
await supabase
    .from("submissions")
    .update({ submission_status: "Reviewed" })
    .eq("id", paper_id);


  if (error) {
    console.error("Error updating submission:", error);
    return res.status(500).send("Error marking submission as reviewed.");
  }

  res.redirect("/reviewer/dashboard");
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
  const { data: confData, error: confError } = await supabase.from("conferences").insert([
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
    const { error: tracksError } = await supabase.from("conference_tracks").insert(tracks);
    if (tracksError) {
      console.error("Error inserting tracks:", tracksError);
      return res.status(500).send("Error creating tracks.");
    }
  }

  res.redirect("/dashboard");
});

app.get("/admin/create-new-conference", (req, res) => {
  res.render("admin/create-new-conference.ejs");
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

app.get("/submission/final-camera-ready/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .eq("id", req.params.id)
    .single();
if(data.submission_status == "Submitted for Review") {
  return res.status(403).send("Review is still in Progress.");
}
else if(data.submission_status == "Rejected") {
  return res.status(403).send("Submission has been Rejected.");
}
else if(data.submission_status == "Submitted Final Camera Ready Paper") {
  return res.status(403).send("Final Camera Ready Paper has already been submitted.");
}
else{
  res.render("submission4.ejs", { user: req.user, submission: data });


}
});

app.post("/final-camera-ready-submission", upload.single("file"), async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const { title, abstract, areas, id, co_authors } = req.body;
const filePath = req.file.path;
  const uploadResult = await cloudinary.uploader.upload(filePath, {
      resource_type: "auto", // auto-detect type (pdf, docx, etc.)
      folder: "submissions",
      public_id: `${req.user.name}-${Date.now()}-Final`
    });

const payload = {
      file: uploadResult.secure_url,
      language: "en",
      country: "us"
    };

const options = {
  method: 'POST',
  headers: {
    Authorization: process.env.WINSTON_API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
};
var score = 0; // Initialize score variable
fetch('https://api.gowinston.ai/v2/plagiarism', options)
  .then(response => response.json())
  .then(data => {
    score = data.result?.score;
  })
  .catch(err => console.error("API Error:", err));



  const { data, error } = await supabase.from("final_camera_ready_submissions").insert(
    {
      paper_id: id,
      primary_author: req.user.name,
      title: title,
      abstract: abstract,
      area: areas,
      co_authors: co_authors,
      file_url: uploadResult.secure_url,
    }).eq("id", id);

    await supabase.from("submissions").update(
      {
        submission_status: "Submitted Final Camera Ready Paper",
        file_url: uploadResult.secure_url,
      }).eq("id", id);

  if (error) {
    console.error("Error inserting submission:", error);
    return res.status(500).send("Error submitting your proposal.");
  } else {
    res.redirect("/dashboard");
  }
});

app.get("/admin/dashboard", async (req, res) => {
  // if (!req.isAuthenticated() || req.user.role !== "admin") {
  //   return res.redirect("/");
  // }

  const { data, error } = await supabase.from("conferences").select("*");

  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.send("Database error!");
  }

  res.render("admin/dashboard.ejs", {
    user: req.user,
    conferences: data || [],
  });
});

app.get("/admin/dashboard/edit-conference/:id", async (req, res) => {
  // if (!req.isAuthenticated() || req.user.role !== "admin") {
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

  res.render("admin/edit-conference.ejs", {
    user: req.user,
    conference,
    tracks: tracks || [],
  });
});
app.post("/admin/dashboard/update-conference/:id", async (req, res) => {
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

  res.redirect("/admin/dashboard");
});
app.get("/admin/dashboard/view-submissions/:id", async (req, res) => {
  // if (!req.isAuthenticated() || req.user.role !== "admin") {
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

  res.render("admin/view-submissions.ejs", {
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
      public_id: `${req.user.name}-${Date.now()}`
    });

const payload = {
      file: uploadResult.secure_url,
      language: "en",
      country: "us"
    };

const options = {
  method: 'POST',
  headers: {
    Authorization: process.env.WINSTON_API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
};
var score = 0; // Initialize score variable
fetch('https://api.gowinston.ai/v2/plagiarism', options)
  .then(response => response.json())
  .then(data => {
    score = data.result?.score;
  })
  .catch(err => console.error("API Error:", err));



  const { data, error } = await supabase.from("submissions").update(
    {
      title: title,
      abstract: abstract,
      area: areas,
      file_url: uploadResult.secure_url,
      score: score,
    }).eq("id", id);

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
    .eq("id", req.params.id)
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
      public_id: `${req.user.uid}-${Date.now()}`
    });

const payload = {
      file: uploadResult.secure_url,
      language: "en",
      country: "us"
    };

const options = {
  method: 'POST',
  headers: {
    Authorization: process.env.WINSTON_API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
};
var score = 0; // Initialize score variable
fetch('https://api.gowinston.ai/v2/plagiarism', options)
  .then(response => response.json())
  .then(data => {
    score = data.result?.score;
  })
  .catch(err => console.error("API Error:", err));



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
              role: "author"
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
              role: "reviewer"
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
