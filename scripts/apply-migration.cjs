// Apply one SQL migration file to the configured database.
// Usage: node scripts/apply-migration.cjs src/db/migrations/002_user_page_permissions.sql
"use strict";
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/apply-migration.cjs <migration.sql>"); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  await pool.query(sql); // single batch: CREATE TABLE + CREATE INDEX run atomically enough for idempotent DDL
  console.log(`Applied ${file}`);
  const check = await pool.query("SELECT COUNT(*)::int AS n FROM user_page_permissions");
  console.log("user_page_permissions rows:", check.rows[0].n);
  await pool.end();
})().catch((e) => { console.error(e.message.split("\n")[0]); process.exit(1); });
