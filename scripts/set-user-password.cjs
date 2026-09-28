// One-off: set a user's password to password123 (demo seed alignment).
// Usage: node scripts/set-user-password.cjs <email>
"use strict";
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/set-user-password.cjs <email>");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

(async () => {
  const hash = await bcrypt.hash("password123", 10);
  const r = await pool.query("UPDATE users SET password_hash=$1 WHERE email=$2 RETURNING id, email", [hash, email]);
  console.log(r.rowCount ? `Updated ${r.rows[0].id} (${r.rows[0].email})` : `No user with email ${email}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
