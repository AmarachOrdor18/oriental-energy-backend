// One-off: apply the v7 section of schema.sql (rate_cards, project_budgets, fn_rate_for)
// Handles $$-quoted function bodies correctly, unlike naive semicolon splitting.
"use strict";
const fs = require("fs");
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

function splitStatements(sql) {
  const stmts = [];
  let buf = [];
  let inDollar = false;
  for (const line of sql.split("\n")) {
    buf.push(line);
    // toggle dollar-quote state when a line opens/closes $$ (function bodies)
    const dollars = (line.match(/\$\$/g) || []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && /;\s*$/.test(line)) {
      stmts.push(buf.join("\n"));
      buf = [];
    }
  }
  if (buf.length && buf.join("").trim()) stmts.push(buf.join("\n"));
  return stmts;
}

(async () => {
  try {
    const sql = fs.readFileSync("src/db/schema.sql", "utf8");
    const stmts = splitStatements(sql);
    let ok = 0, skipped = 0;
    for (const s of stmts) {
      const t = s.trim();
      // Strip pure comment lines to decide whether real SQL remains
      const stripped = t.replace(/^--.*$/gm, "").trim();
      if (!t || !stripped) continue;
      try {
        await pool.query(t);
        ok++;
      } catch (e) {
        if (/already exists/i.test(e.message)) { skipped++; continue; }
        console.error("FAIL:", e.message.split("\n")[0], "→", t.slice(0, 70).replace(/\n/g, " "));
      }
    }
    console.log(`applied: ${ok}, skipped(existing): ${skipped}`);

    const v = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('rate_cards','project_budgets')`
    );
    console.log("new tables present:", v.rows.map((r) => r.table_name).join(", ") || "NONE");
    const f = await pool.query(
      `SELECT routine_name FROM information_schema.routines WHERE routine_name = 'fn_rate_for'`
    );
    console.log("fn_rate_for present:", f.rows.length > 0);
    await pool.end();
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
