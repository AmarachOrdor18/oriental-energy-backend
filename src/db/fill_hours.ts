/**
 * fill_hours.ts  (v3 — bulk, no manual clients)
 *
 * Uses pool.query() only — no pool.connect(), no transactions, no long-lived
 * connections.  Safe to re-run; uses ON CONFLICT / DELETE+INSERT patterns.
 *
 * Run:  cd backend && npx tsx src/db/fill_hours.ts
 */

import { pool } from './index';

function toDateStr(d: Date): string {
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function getMondayOf(d: Date): Date {
  const c = new Date(d);
  const day = c.getUTCDay();
  c.setUTCDate(c.getUTCDate() - (day === 0 ? 6 : day - 1));
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

async function fillHours() {
  const RANGE_START = '2026-01-05';
  const RANGE_END   = '2026-05-27';

  // ── 1. Reference data ──────────────────────────────────────────────────

  const [usersRes, projRes, holRes, adminRes] = await Promise.all([
    pool.query(`
      SELECT u.id, u.department_id, d.code AS dept_code
      FROM   users u
      LEFT   JOIN departments d ON d.id = u.department_id
      WHERE  u.is_active = true
      ORDER  BY u.id
    `),
    pool.query(`
      SELECT p.id, d.code AS dept_code
      FROM   projects p
      LEFT   JOIN departments d ON d.id = p.department_id
      WHERE  p.is_active = true
      ORDER  BY p.id
    `),
    pool.query(`SELECT date FROM public_holidays WHERE year = 2026`),
    pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`),
  ]);

  const users    = usersRes.rows;
  const holidays = new Set(holRes.rows.map((r: any) => toDateStr(new Date(r.date))));
  const adminId  = adminRes.rows[0]?.id ?? null;

  // Projects map: dept_code → [id, id]
  const byDept: Record<string, string[]> = {};
  for (const p of projRes.rows) {
    const k = p.dept_code ?? '__ALL__';
    if (!byDept[k]) byDept[k] = [];
    if (byDept[k].length < 2) byDept[k].push(p.id);
  }
  const fallback = projRes.rows.slice(0, 2).map((r: any) => r.id);

  console.log(`Users: ${users.length}  Holidays: ${holidays.size}  Admin: ${adminId}`);

  // ── 2. Build date lists ─────────────────────────────────────────────────

  const workingDays: string[] = [];
  const cur = new Date(RANGE_START + 'T00:00:00Z');
  const end = new Date(RANGE_END   + 'T00:00:00Z');
  while (cur <= end) {
    const ds = toDateStr(cur);
    const day = cur.getUTCDay();
    if (day >= 1 && day <= 5 && !holidays.has(ds)) workingDays.push(ds);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const weekStartsSet = new Set<string>();
  for (const ds of workingDays)
    weekStartsSet.add(toDateStr(getMondayOf(new Date(ds + 'T00:00:00Z'))));
  const weekStarts = Array.from(weekStartsSet).sort();

  console.log(`Working days: ${workingDays.length}  Weeks: ${weekStarts.length}`);

  // ── 3. Build all rows in memory ─────────────────────────────────────────

  type LogRow = [string, string, string, number, string]; // user,proj,date,hrs,weekStart
  const logRows: LogRow[] = [];

  type TsRow = [string, string, string, string, string, string | null, string | null, string | null];
  const tsRows: TsRow[] = [];

  for (const user of users) {
    const projects = (() => {
      const k = user.dept_code ?? '__ALL__';
      const list = byDept[k];
      return list && list.length > 0 ? list : fallback;
    })();
    if (projects.length === 0) continue;

    const hrsEach = projects.length === 1 ? 8 : 4;

    for (const ds of workingDays) {
      const ws = toDateStr(getMondayOf(new Date(ds + 'T00:00:00Z')));
      for (const projId of projects) {
        logRows.push([user.id, projId, ds, hrsEach, ws]);
      }
    }

    for (const ws of weekStarts) {
      const wsDate  = new Date(ws + 'T00:00:00Z');
      const we      = toDateStr(addDays(wsDate, 6));
      const period  = ws.slice(0, 7);

      const isMay25   = ws === '2026-05-25';
      const approved  = !isMay25 && (period <= '2026-04' || (period === '2026-05' && ws <= '2026-05-18'));
      const status    = approved ? 'approved' : 'draft';
      const subAt     = approved ? addDays(wsDate, 4).toISOString().replace('T00:', 'T17:') : null;
      const appBy     = approved ? adminId : null;
      const appAt     = approved ? addDays(wsDate, 7).toISOString().replace('T00:', 'T09:') : null;

      tsRows.push([user.id, ws, we, period, status, subAt, appBy, appAt]);
    }
  }

  console.log(`Log rows to insert : ${logRows.length.toLocaleString()}`);
  console.log(`Timesheet rows     : ${tsRows.length.toLocaleString()}`);

  // ── 4. Wipe existing data in range ─────────────────────────────────────

  console.log('\nDeleting existing daily logs in range...');
  await pool.query(
    `DELETE FROM daily_logs WHERE date BETWEEN $1 AND $2`,
    [RANGE_START, RANGE_END]
  );

  console.log('Deleting existing timesheets in range...');
  await pool.query(
    `DELETE FROM timesheets WHERE week_start_date BETWEEN $1 AND $2`,
    [RANGE_START, RANGE_END]
  );

  // ── 5. Bulk-insert daily logs in batches of 400 rows ───────────────────

  console.log('\nInserting daily logs...');
  const LOG_BATCH = 400;
  let logDone = 0;

  for (let i = 0; i < logRows.length; i += LOG_BATCH) {
    const chunk = logRows.slice(i, i + LOG_BATCH);
    const vals: string[] = [];
    const params: any[]  = [];
    let p = 1;
    for (const [uid, pid, dt, hrs, ws] of chunk) {
      vals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},true,NOW())`);
      params.push(uid, pid, dt, hrs, ws);
      p += 5;
    }
    await pool.query(
      `INSERT INTO daily_logs (user_id,project_id,date,hours,week_start_date,is_filled,updated_at)
       VALUES ${vals.join(',')}`,
      params
    );
    logDone += chunk.length;
    if (Math.floor(logDone / LOG_BATCH) % 10 === 0 || logDone === logRows.length) {
      process.stdout.write(`  ${logDone.toLocaleString()} / ${logRows.length.toLocaleString()} rows\n`);
    }
  }

  // ── 6. Bulk-insert timesheets in batches of 400 ────────────────────────

  console.log('\nInserting timesheets...');
  const TS_BATCH = 400;
  let tsDone = 0;

  for (let i = 0; i < tsRows.length; i += TS_BATCH) {
    const chunk = tsRows.slice(i, i + TS_BATCH);
    const vals: string[] = [];
    const params: any[]  = [];
    let p = 1;
    for (const [uid, ws, we, per, st, sub, appBy, appAt] of chunk) {
      vals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7})`);
      params.push(uid, ws, we, per, st, sub, appBy, appAt);
      p += 8;
    }
    await pool.query(
      `INSERT INTO timesheets
         (user_id,week_start_date,week_end_date,accounting_period,
          status,submitted_at,approved_by,approved_at)
       VALUES ${vals.join(',')}`,
      params
    );
    tsDone += chunk.length;
  }
  console.log(`  ${tsDone.toLocaleString()} timesheets inserted`);

  // ── 7. Summary ─────────────────────────────────────────────────────────

  const verify = await pool.query(
    `SELECT COUNT(DISTINCT user_id) as users, COUNT(*) as rows
     FROM daily_logs WHERE date BETWEEN $1 AND $2`,
    [RANGE_START, RANGE_END]
  );

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✅  Done`);
  console.log(`    Daily log rows  : ${parseInt(verify.rows[0].rows).toLocaleString()}`);
  console.log(`    Users covered   : ${verify.rows[0].users} / ${users.length}`);
  console.log(`    Timesheets      : ${tsDone.toLocaleString()}`);
  console.log(`    Range           : ${RANGE_START} → ${RANGE_END}`);
  console.log(`${'─'.repeat(50)}`);

  process.exit(0);
}

fillHours().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
