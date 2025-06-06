import express from "express";
import bodyParser from "body-parser";
import passport from "passport";
import { v2 as cloudinary } from "cloudinary";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import session from "express-session";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import path from "path";

const app = express();
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || "your_secret_key",
    resave: false,
    saveUninitialized: false,
  })
);
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
    userSubmissions:submissiondata || [], // Initialize submissions as an empty array
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
    userSubmissions:submissiondata || [], // Initialize submissions as an empty array
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
if(data.primary_author_uid === req.user.uid) {
  return res.status(400).send("You are already the primary author of this submission.");}

else if (!coAuthors.includes(req.user.email)) {
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

app.post("/submit", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const { title, abstract, areas, id } = req.body;

  const { data, error } = await supabase.from("submissions").insert([
    {
      conference_id: id,
      primary_author_uid: req.user.uid,
      title: title,
      abstract: abstract,
      area: areas,
      paper_code: crypto.randomUUID(),
    },
  ]);

  if (error) {
    console.error("Error inserting submission:", error);
    return res.status(500).send("Error submitting your proposal.");
  } 
  else{
    
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
