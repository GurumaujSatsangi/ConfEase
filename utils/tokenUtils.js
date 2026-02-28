import jwt from "jsonwebtoken";
import crypto from "crypto";

const ACCESS_TOKEN_EXPIRY = "15m"; // 15 minutes
const REFRESH_TOKEN_EXPIRY = "7d"; // 7 days

/**
 * Generate a JWT access token
 * @param {string} email - User email
 * @param {string} id - User ID
 * @returns {string} JWT access token
 */
export function generateAccessToken(email, id) {
  return jwt.sign(
    { email, id },
    process.env.JWT_SECRET || "dev_jwt_secret",
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * Generate a JWT refresh token
 * @param {string} email - User email
 * @param {string} id - User ID
 * @returns {string} JWT refresh token
 */
export function generateRefreshToken(email, id) {
  return jwt.sign(
    { email, id },
    process.env.JWT_SECRET || "dev_jwt_secret",
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

/**
 * Hash a refresh token using SHA256 before storing in DB
 * @param {string} token - Raw refresh token
 * @returns {string} Hashed token
 */
export function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Verify an access token
 * @param {string} token - JWT access token
 * @returns {object|null} Decoded token or null if invalid
 */
export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret");
  } catch (err) {
    return null;
  }
}

/**
 * Verify a refresh token
 * @param {string} token - JWT refresh token
 * @returns {object|null} Decoded token or null if invalid
 */
export function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || "dev_jwt_secret");
  } catch (err) {
    return null;
  }
}

/**
 * Decode token without verification (for debugging only)
 * @param {string} token - JWT token
 * @returns {object|null} Decoded token or null
 */
export function decodeToken(token) {
  try {
    return jwt.decode(token);
  } catch (err) {
    return null;
  }
}
