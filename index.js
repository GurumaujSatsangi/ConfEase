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

app.get("/", (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect("/dashboard");
  }
  res.render("home.ejs");
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
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
      .eq("primary_author_uid", req.user.uid);

    res.render("dashboard.ejs", {
      user: req.user,
      conferences: data || [],
      userSubmissions: submissiondata || [], // Initialize submissions as an empty array
    });
  }
);

app.get("/dashboard", async (req, res) => {
  if (!req.isAuthenticated()) {
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
    .eq("primary_author_uid", req.user.uid);

  res.render("dashboard.ejs", {
    user: req.user,
    conferences: data || [],
    userSubmissions: submissiondata || [], // Initialize submissions as an empty array
  });
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
  } = req.body;

  const { data, error } = await supabase.from("conferences").insert([
    {
      title: title,
      description: description,
      conference_start_date: conference_start_date,
      conference_end_date: conference_end_date,
      full_paper_submission: full_paper_submission,
      acceptance_notification: acceptance_notification,
      camera_ready_paper_submission: camera_ready_paper_submission,
    },
  ]);

  if (error) {
    console.error("Error inserting conference:", error);
    return res.status(500).send("Error creating conference.");
  } else {
    res.redirect("/dashboard");
  }
});

app.get("/admin/create-new-conference", (req, res) => {
  res.render("admin/create-new-conference.ejs");
});
app.get("/submission/primary-author/:id", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }
  const { data, error } = await supabase
    .from("conferences")
    .select("*")
    .eq("id", req.params.id)
    .single();

  res.render("submission.ejs", { user: req.user, conferences: data });
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
      primary_author_uid: req.user.uid,
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

          // Now re-fetch inserted user to pass a clean object to Passport
          const { data: newUser, error: fetchError } = await supabase
            .from("users")
            .select("*")
            .eq("uid", profile.id)
            .single();

          if (fetchError) {
            console.error("Fetch after insert failed:", fetchError);
            return cb(fetchError);
          }

          return cb(null, newUser);
        } else {
          return cb(null, result.data);
        }
      } catch (err) {
        return cb(err);
      }
    }
  )
);
passport.serializeUser((user, cb) => {
  cb(null, user);
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
