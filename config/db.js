import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  user: "postgres",          // your PG username
  host: "localhost",         // database host
  database: "CMT_local",     // the DB you restored into
  password: "Gurumauj@2613", // your PG password
  port: 5432,                // default port
});

export default pool;
