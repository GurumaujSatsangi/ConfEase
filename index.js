import express from "express";
import bodyParser from "body-parser";
import passport from "passport";
import { v2 as cloudinary } from 'cloudinary';
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
app.use('/static', express.static(path.join(__dirname, 'public')));

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
    const { data, error } = await supabase
      .from("conferences")
      .select("*");

    if (error && error.code !== "PGRST116") {
      console.error(error);
      return res.send("Database error!");
    }

    res.render("dashboard.ejs", {
      user: req.user,
      conferences: data || [] // Pass conferences to EJS
    });
  }
);

app.get("/dashboard", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const { data, error } = await supabase
    .from("conferences")
    .select("*");

  if (error && error.code !== "PGRST116") {
    console.error(error);
    return res.send("Database error!");
  }

  res.render("dashboard.ejs", {
    user: req.user,
    conferences: data || []
  });
});


app.get("/submission/:id" , async (req, res) => {
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

passport.use(
  "google",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        "http://localhost:3000/auth/google/dashboard",
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
