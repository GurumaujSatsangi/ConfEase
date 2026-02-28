import { verifyAccessToken } from "../utils/tokenUtils.js";

/**
 * Middleware to verify access token
 * If access token is expired, returns 401 so frontend can call /refresh
 * If access token is invalid, clears cookies and redirects to login
 */
export async function verifyAccessTokenMiddleware(req, res, next) {
  try {
    const accessToken = req.cookies.accessToken;

    // No token found
    if (!accessToken) {
      return res.status(401).json({
        message: "Access token not found",
        code: "NO_TOKEN",
      });
    }

    // Verify token
    const decoded = verifyAccessToken(accessToken);

    if (!decoded) {
      // Token is invalid or expired
      return res.status(401).json({
        message: "Access token expired or invalid",
        code: "TOKEN_EXPIRED",
      });
    }

    // Attach user to request
    req.user = decoded;
    next();
  } catch (err) {
    console.error("verifyAccessTokenMiddleware error:", err);
    return res.status(401).json({
      message: "Authentication error",
      code: "AUTH_ERROR",
    });
  }
}

/**
 * Middleware for user authentication (staff/authors)
 * Redirects to login if not authenticated
 */
export async function checkAuthWithToken(req, res, next) {
  try {
    const accessToken = req.cookies.accessToken;

    if (!accessToken) {
      return res.redirect("/login/user?message=Please login to continue.");
    }

    const decoded = verifyAccessToken(accessToken);

    if (!decoded) {
      // Try to refresh token if refresh token exists
      const refreshToken = req.cookies.refreshToken;
      if (refreshToken) {
        // Frontend should handle refresh, but for server-side routes we can attempt it
        // For now, just redirect to refresh or login
        return res.redirect("/login/user?message=Session expired. Please login again.");
      }
      return res.redirect("/login/user?message=Session expired. Please login again.");
    }

    // Fetch full user from DB to get complete user object (not just email/id from token)
    const pool = (await import("../config/db.js")).default;
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      decoded.email,
    ]);

    if (result.rows.length === 0) {
      res.clearCookie("accessToken");
      res.clearCookie("refreshToken");
      return res.redirect("/login/user?message=User not found. Please login again.");
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error("checkAuthWithToken error:", err);
    return res.redirect("/login/user?message=Authentication error.");
  }
}

/**
 * Middleware for chair authentication
 * Redirects to login if not authenticated
 */
export async function checkChairAuthWithToken(req, res, next) {
  try {
    const accessToken = req.cookies.accessToken;

    if (!accessToken) {
      return res.redirect("/login/user?message=Please login to continue.");
    }

    const decoded = verifyAccessToken(accessToken);

    if (!decoded) {
      return res.redirect("/login/user?message=Session expired. Please login again.");
    }

    // Fetch full chair from DB
    const pool = (await import("../config/db.js")).default;
    const result = await pool.query(
      "SELECT * FROM chairs WHERE email = $1",
      [decoded.email]
    );

    if (result.rows.length === 0) {
      res.clearCookie("accessToken");
      res.clearCookie("refreshToken");
      return res.redirect("/login/user?message=Chair not found. Please login again.");
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error("checkChairAuthWithToken error:", err);
    return res.redirect("/login/user?message=Authentication error.");
  }
}

/**
 * Middleware that accepts either user OR chair authentication
 * Used for routes accessible by both user types
 */
export async function checkAuthOrChairWithToken(req, res, next) {
  try {
    const accessToken = req.cookies.accessToken;

    if (!accessToken) {
      return res.redirect("/login/user?message=Please login to continue.");
    }

    const decoded = verifyAccessToken(accessToken);

    if (!decoded) {
      return res.redirect("/login/user?message=Session expired. Please login again.");
    }

    const pool = (await import("../config/db.js")).default;

    // Try to find as user first
    let result = await pool.query("SELECT * FROM users WHERE email = $1", [
      decoded.email,
    ]);

    if (result.rows.length > 0) {
      req.user = result.rows[0];
      return next();
    }

    // Try to find as chair
    result = await pool.query("SELECT * FROM chairs WHERE email = $1", [
      decoded.email,
    ]);

    if (result.rows.length > 0) {
      req.user = result.rows[0];
      return next();
    }

    // User/Chair not found
    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");
    return res.redirect("/login/user?message=User not found. Please login again.");
  } catch (err) {
    console.error("checkAuthOrChairWithToken error:", err);
    return res.redirect("/login/user?message=Authentication error.");
  }
}
