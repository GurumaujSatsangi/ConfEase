// Preloaded (via `node --import`) before every test file. node --test runs
// each matched file in its own child process, and every file imports
// config/db.js, which creates its own Postgres Pool sized by DB_POOL_MAX
// (default 20 - sized for the single persistent app server, not for many
// concurrent test files). With the growing number of test files, running
// them all at once can ask Postgres for far more connections than
// max_connections allows, causing widespread, misleading failures across
// unrelated tests. Capping it here (only when a test hasn't already set
// its own value, and only if DB_POOL_MAX isn't already set in the
// environment) keeps the whole suite's peak connection count well under
// a typical local Postgres's default limit.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || "4";
