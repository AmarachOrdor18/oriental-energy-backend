// setup-supabase.cjs
// Applies src/db/schema.sql + runs src/db/seed.ts against Supabase
// Run: node setup-supabase.cjs
//
// Requires:
// - pg
// - dotenv
// - tsx
//
// DATABASE_URL in .env must point to the Supabase database.

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { execSync } = require("child_process");

require("dotenv").config();

const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "src/db/schema.sql"),
  "utf8"
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 20000,
});

async function applySchema() {
  console.log("Applying schema (schema.sql)…");

  try {
    // Send the entire SQL file directly to PostgreSQL.
    // Do NOT split on semicolons because schema.sql may contain
    // PostgreSQL functions using $$ ... $$ blocks.
    await pool.query(SCHEMA_SQL);

    console.log("Schema applied OK");
  } catch (error) {
    console.error("Schema failed:");
    console.error(error.message);
    throw error;
  }
}

async function runSeed() {
  console.log("Running seed (seed.ts)…");

  try {
    execSync("npx tsx src/db/seed.ts", {
      cwd: __dirname,
      stdio: "inherit",
    });

    console.log("Seed complete");
  } catch (error) {
    console.error("Seed failed:", error.message);
    throw error;
  }
}

async function verifyDatabase() {
  console.log("Verifying database…");

  const requiredTables = [
    "notifications",
    "daily_logs",
    "timesheets",
    "system_settings",
    "finance_decisions",
    "audit_log",
    "activities",
    "projects",
  ];

  for (const table of requiredTables) {
    const result = await pool.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS exists
      `,
      [table]
    );

    if (!result.rows[0].exists) {
      throw new Error(`Required table "${table}" does not exist.`);
    }
  }

  console.log("Database verification OK");
}

(async () => {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing from .env");
    }

    const connection = await pool.query(
      "SELECT current_database() AS db"
    );

    console.log("Connected to:", connection.rows[0].db);

    await applySchema();

    await verifyDatabase();

    await runSeed();

    console.log("");
    console.log("========================================");
    console.log("Supabase setup completed successfully.");
    console.log("========================================");
  } catch (error) {
    console.error("");
    console.error("========================================");
    console.error("Supabase setup FAILED");
    console.error("========================================");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();