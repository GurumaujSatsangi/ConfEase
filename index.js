import express from "express";
import bodyParser from "body-parser";
import ejs from "ejs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const app = express();
app.use(express.json());
dotenv.config();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
app.set("view engine", "ejs");
app.set("views", "./views");

app.get("/", (req, res) => {
  res.render("authentication.ejs");
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { user, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(400).json({ error: error.message });
  }

  const { data, error1 } = await supabase.from("users").select("*").eq("email", email).single();
  const { data: conferences, error2 } = await supabase.from("conferences").select("*");


  if (error1) {
    return res.status(400).json({ error: error1.message });
  }

  if (error2) {
    return res.status(400).json({ error: error2.message });
  }

  res.render("dashboard.ejs", { user: user, data: data, conferences: conferences || [] });
});

app.listen(3000, () => {
  console.log("Server is running on Port 3000!");
});

export default app;