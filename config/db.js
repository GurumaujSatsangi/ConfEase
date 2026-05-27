import pkg from "pg";
const { Pool, types } = pkg;

import dotenv from "dotenv";
dotenv.config();

// Return date columns as raw 'YYYY-MM-DD' strings instead of JS Date objects
// This prevents timezone-related off-by-one errors
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  user: process.env.DB_USER ,
  host: process.env.DB_HOST ,
  database: process.env.DB_NAME ,
  password: process.env.DB_PASSWORD ,
  port: parseInt(process.env.DB_PORT),
  ssl: {
        rejectUnauthorized: false // This is required for AWS RDS
    }
});

export default pool;
