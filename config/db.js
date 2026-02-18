import pkg from "pg";
const { Pool, types } = pkg;

// Return date columns as raw 'YYYY-MM-DD' strings instead of JS Date objects
// This prevents timezone-related off-by-one errors
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "CMT_local",
  password: process.env.DB_PASSWORD || "Gurumauj@2613",
  port: parseInt(process.env.DB_PORT) || 5432,
});

export default pool;
