-- Migration: Add refresh tokens table for token rotation system

-- Create refresh_tokens table to store hashed refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_email VARCHAR(255) NOT NULL UNIQUE,
  hashed_token VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Create index for faster lookups by user_email
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_email ON refresh_tokens(user_email);

-- Create index for cleanup of expired tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- Optional: Create a stored procedure for cleaning up expired refresh tokens
-- This can be called periodically or via a cron job
CREATE OR REPLACE FUNCTION cleanup_expired_refresh_tokens() RETURNS void AS $$
BEGIN
  DELETE FROM refresh_tokens WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Note: Schedule a periodic job to call cleanup_expired_refresh_tokens()
-- Example using pg_cron extension (if available):
-- SELECT cron.schedule('cleanup_expired_tokens', '0 2 * * *', 'SELECT cleanup_expired_refresh_tokens()');
