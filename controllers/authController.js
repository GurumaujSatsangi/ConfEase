import pool from "../config/db.js";
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyRefreshToken,
} from "../utils/tokenUtils.js";

/**
 * Login user and return access + refresh tokens
 * Stores hashed refresh token in DB for verification during refresh
 */
export async function loginUser(req, res, userEmail, userId) {
  try {
    // Generate tokens
    const accessToken = generateAccessToken(userEmail, userId);
    const refreshToken = generateRefreshToken(userEmail, userId);
    const hashedRefreshToken = hashRefreshToken(refreshToken);

    // Store hashed refresh token in DB linked to user
    // Note: You may need to add a `refresh_tokens` table or add columns to your user tables
    // For now, we're assuming you have a refresh_tokens table
    await pool.query(
      `INSERT INTO refresh_tokens (user_email, hashed_token, created_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '7 days')
       ON CONFLICT (user_email) DO UPDATE SET
         hashed_token = EXCLUDED.hashed_token,
         created_at = NOW(),
         expires_at = NOW() + INTERVAL '7 days'`,
      [userEmail, hashedRefreshToken]
    );

    // Set cookies (httpOnly, secure, sameSite)
    const cookieOptions = {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 15 * 60 * 1000, // 15 minutes for access token
      secure: process.env.NODE_ENV === "production", // HTTPS only in production
    };

    const refreshCookieOptions = {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days for refresh token
      secure: process.env.NODE_ENV === "production",
    };

    res.cookie("accessToken", accessToken, cookieOptions);
    res.cookie("refreshToken", refreshToken, refreshCookieOptions);

    return { success: true };
  } catch (err) {
    console.error("loginUser error:", err);
    throw err;
  }
}

/**
 * Login controller for user (staff/author)
 */
export async function loginUserController(req, res) {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.redirect("/login/user?message=Email and password are required.");
    }

    // Fetch user from DB
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (result.rows.length === 0) {
      return res.redirect("/login/user?message=Invalid email or password.");
    }

    const user = result.rows[0];

    // TODO: Implement password verification with bcrypt
    // For now, assuming password is stored as plaintext (NOT SECURE - fix this!)
    // const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    // if (!isPasswordValid) {
    //   return res.redirect("/login/user?message=Invalid email or password.");
    // }

    // Login user with tokens
    await loginUser(req, res, user.email, user.id || user.email);

    return res.redirect("/dashboard?message=Login successful!");
  } catch (err) {
    console.error("loginUserController error:", err);
    return res.redirect("/login/user?message=Server error during login.");
  }
}

/**
 * Login controller for chair
 */
export async function loginChairController(req, res) {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.redirect(
        "/login/user?message=Email and password are required."
      );
    }

    // Fetch chair from DB
    const result = await pool.query(
      "SELECT * FROM chairs WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.redirect(
        "/login/user?message=Invalid email or password."
      );
    }

    const chair = result.rows[0];

    // TODO: Implement password verification with bcrypt
    // const isPasswordValid = await bcrypt.compare(password, chair.password_hash);

    // Login chair with tokens
    await loginUser(req, res, chair.email, chair.id || chair.email);

    return res.redirect("/chair/dashboard?message=Login successful!");
  } catch (err) {
    console.error("loginChairController error:", err);
    return res.redirect(
      "/login/user?message=Server error during login."
    );
  }
}

/**
 * Refresh access token using refresh token
 * Implements token rotation: old refresh token is replaced with new one
 */
export async function refreshTokenController(req, res) {
  try {
    const refreshToken = req.cookies.refreshToken;

    // Validate refresh token exists
    if (!refreshToken) {
      res.clearCookie("accessToken");
      res.clearCookie("refreshToken");
      return res.status(401).json({ message: "Refresh token not found" });
    }

    // Verify refresh token structure
    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      res.clearCookie("accessToken");
      res.clearCookie("refreshToken");
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }

    const userEmail = decoded.email;
    const userId = decoded.id;

    // Verify hashed refresh token in DB
    const dbResult = await pool.query(
      `SELECT hashed_token FROM refresh_tokens
       WHERE user_email = $1 AND expires_at > NOW()`,
      [userEmail]
    );

    if (dbResult.rows.length === 0) {
      res.clearCookie("accessToken");
      res.clearCookie("refreshToken");
      return res.status(401).json({ message: "Refresh token not found in database" });
    }

    const storedHashedToken = dbResult.rows[0].hashed_token;
    const hashedIncomingToken = hashRefreshToken(refreshToken);

    // Compare tokens
    if (storedHashedToken !== hashedIncomingToken) {
      // Tokens don't match - possible security breach, clear all tokens
      await pool.query(
        "DELETE FROM refresh_tokens WHERE user_email = $1",
        [userEmail]
      );
      res.clearCookie("accessToken");
      res.clearCookie("refreshToken");
      return res.status(401).json({ message: "Token mismatch - please login again" });
    }

    // Token rotation: Generate new tokens and replace old refresh token in DB
    const newAccessToken = generateAccessToken(userEmail, userId);
    const newRefreshToken = generateRefreshToken(userEmail, userId);
    const newHashedRefreshToken = hashRefreshToken(newRefreshToken);

    // Update DB with new hashed refresh token
    await pool.query(
      `UPDATE refresh_tokens
       SET hashed_token = $1, created_at = NOW(), expires_at = NOW() + INTERVAL '7 days'
       WHERE user_email = $2`,
      [newHashedRefreshToken, userEmail]
    );

    // Set new cookies
    const cookieOptions = {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 15 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
    };

    const refreshCookieOptions = {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === "production",
    };

    res.cookie("accessToken", newAccessToken, cookieOptions);
    res.cookie("refreshToken", newRefreshToken, refreshCookieOptions);

    return res.json({ success: true, message: "Tokens refreshed" });
  } catch (err) {
    console.error("refreshTokenController error:", err);
    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");
    return res.status(500).json({ message: "Error refreshing tokens" });
  }
}

/**
 * Logout user and delete refresh token from DB
 */
export async function logoutController(req, res) {
  try {
    const userEmail = req.user?.email;

    // Delete refresh token from DB if user exists
    if (userEmail) {
      await pool.query(
        "DELETE FROM refresh_tokens WHERE user_email = $1",
        [userEmail]
      );
    }

    // Clear cookies
    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");

    return res.redirect("/?message=Logged out successfully!");
  } catch (err) {
    console.error("logoutController error:", err);
    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");
    return res.redirect("/?message=Logout encountered an error, but cookies cleared.");
  }
}
