-- Drillbit (https://apidocs.drillbitglobal.com) AI/plagiarism analysis
-- integration: every first-time full paper submission (POST /submit, not
-- revised papers or camera-ready papers) is uploaded to Drillbit in the
-- background, and the chair sees the plagiarism %, AI %, and report links
-- on the desk review page once Drillbit finishes processing (10-15 min
-- per Drillbit's own docs).

-- Singleton row caching the single Drillbit "folder" this app uploads
-- every submission into (Drillbit requires a folder id to upload into;
-- there is no reason for this app to create more than one).
CREATE TABLE IF NOT EXISTS drillbit_connection (
  id smallint PRIMARY KEY DEFAULT 1,
  folder_id text NOT NULL,
  CONSTRAINT drillbit_connection_singleton CHECK (id = 1)
);

-- One row per submission that has been (or was attempted to be) sent to
-- Drillbit. status: 'pending' (uploaded, still processing or not yet
-- checked), 'completed' (percent/ai available), 'failed' (upload or
-- result-check errored - see error_message).
CREATE TABLE IF NOT EXISTS drillbit_reports (
  submission_id uuid PRIMARY KEY REFERENCES submissions(submission_id) ON DELETE CASCADE,
  folder_id text,
  paper_id text,
  d_key text,
  status text NOT NULL DEFAULT 'pending',
  plagiarism_percent numeric,
  ai_percent numeric,
  error_message text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  CONSTRAINT drillbit_reports_status_check CHECK (status IN ('pending', 'completed', 'failed'))
);
