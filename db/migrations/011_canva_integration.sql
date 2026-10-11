-- Shared, app-wide Canva OAuth connection (one row, id always 1). Canva's
-- REST API has no server-to-server grant - this stores the refresh token
-- from the one-time Admin-driven authorization so the server can mint new
-- access tokens on its own afterward (see canva.js).
CREATE TABLE IF NOT EXISTS canva_connection (
  id integer PRIMARY KEY DEFAULT 1,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  connected_by text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canva_connection_singleton CHECK (id = 1)
);

-- Certificates are now generated once (via Canva, in bulk, at "Enable PDF
-- Download") and stored permanently (uploaded to Cloudinary), rather than
-- rebuilt on every download - Canva's own export URLs only stay valid for
-- 24 hours, so they can't be the long-term download link.
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS file_url text;
