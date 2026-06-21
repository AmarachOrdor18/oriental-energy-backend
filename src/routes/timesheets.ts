import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

function toDateKey(value: any) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().split('T')[0];
}

async function getSystemSettings() {
  try {
    const res = await pool.query('SELECT key, value FROM system_settings');
    const s: Record<string, string> = {};
    res.rows.forEach((r: any) => { s[r.key] = r.value; });
    return s;
  } catch {
    return { min_daily_hours: String(process.env.DAILY_MINIMUM_HOURS || '8'), hour_enforcement_mode: 'block' };
  }
}

async function canAccessUser(requestUser: NonNullable<Express.Request['user']>, targetUserId: string) {
  if (requestUser.role === 'admin' || requestUser.role === 'finance') return true;
  if (requestUser.id === targetUserId) return true;
  if (requestUser.role === 'line_manager') {
    const r = await pool.query('SELECT 1 FROM users WHERE id=$1 AND manager_id=$2', [targetUserId, requestUser.id]);
    return r.rows.length > 0;
  }
  if (requestUser.role === 'hod') {
    const r = await pool.query('SELECT 1 FROM users WHERE id=$1 AND department_id=$2', [targetUserId, requestUser.department_id]);
    return r.rows.length > 0;
  }
  return false;
}

async function validateMinimumHours(userId: string, weekStart: string, weekEnd: string) {
  const [logs, holidays, settings] = await Promise.all([
    pool.query(
      `SELECT date::text as date, SUM(hours) as total_hours, BOOL_OR(notes IN ('annual_leave','sick_leave')) as leave_day
       FROM daily_logs WHERE user_id=$1 AND date BETWEEN $2 AND $3 GROUP BY date`,
      [userId, weekStart, weekEnd]
    ),
    pool.query('SELECT date::text as date FROM public_holidays WHERE date BETWEEN $1 AND $2', [weekStart, weekEnd]),
    getSystemSettings(),
  ]);
  const minHours = Number(settings['min_daily_hours'] || 8);
  const mode = settings['hour_enforcement_mode'] || 'block';
  const totals = new Map<string, { hours: number; leave: boolean }>();
  logs.rows.forEach((row: any) => {
    totals.set(toDateKey(row.date), { hours: parseFloat(row.total_hours || 0), leave: row.leave_day });
  });
  const holidaySet = new Set(holidays.rows.map((row: any) => toDateKey(row.date)));
  const shortfalls: string[] = [];
  const cursor = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${weekEnd}T00:00:00Z`);
  while (cursor <= end) {
    const key = cursor.toISOString().split('T')[0];
    const day = cursor.getUTCDay();
    const entry = totals.get(key);
    if (day >= 1 && day <= 5 && !holidaySet.has(key) && !entry?.leave && (entry?.hours || 0) < minHours) {
      shortfalls.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { shortfalls, mode, minHours };
}

// GET /timesheets
router.get('/', authenticate, async (req, res) => {
  const { user_id, status, period } = req.query;
  const user = req.user!;
  try {
    if (typeof user_id === 'string' && !(await canAccessUser(user, user_id)))
      return res.status(403).json({ error: 'Access denied.' });
    let query = `SELECT t.*, u.name as user_name, u.email as user_email, d.name as department_name, ap.name as approver_name
                 FROM timesheets t JOIN users u ON t.user_id=u.id
                 LEFT JOIN departments d ON u.department_id=d.id
                 LEFT JOIN users ap ON t.approved_by=ap.id WHERE 1=1`;
    const params: any[] = [];
    let pc = 0;
    if (user.role === 'user') { if (!user_id) { pc++; query += ` AND t.user_id=$${pc}`; params.push(user.id); } }
    else if (user.role === 'line_manager') { if (!user_id) { pc++; query += ` AND (t.user_id=$${pc} OR t.user_id IN (SELECT id FROM users WHERE manager_id=$${pc}))`; params.push(user.id); } }
    else if (user.role === 'hod') { if (!user_id) { pc++; query += ` AND t.user_id IN (SELECT id FROM users WHERE department_id=$${pc})`; params.push(user.department_id); } }
    if (user_id) { pc++; query += ` AND t.user_id=$${pc}`; params.push(user_id); }
    if (status) { pc++; query += ` AND t.status=$${pc}`; params.push(status); }
    if (period) { pc++; query += ` AND t.accounting_period=$${pc}`; params.push(period); }
    query += ' ORDER BY t.week_start_date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch timesheets.' });
  }
});

// GET /timesheets/monthly-summary/view?user_id=&period=
router.get('/monthly-summary/view', authenticate, async (req, res) => {
  const { user_id, period } = req.query;
  if (!user_id || !period) return res.status(400).json({ error: 'user_id and period are required.' });
  if (!(await canAccessUser(req.user!, String(user_id)))) return res.status(403).json({ error: 'Access denied.' });
  try {
    const periodRes = await pool.query('SELECT * FROM accounting_periods WHERE period_code=$1', [period]);
    if (periodRes.rows.length === 0) return res.status(404).json({ error: 'Period not found.' });
    const p = periodRes.rows[0];
    const timesheets = await pool.query(`
      SELECT t.*, u.name as user_name, u.email as user_email, d.name as department_name
      FROM timesheets t JOIN users u ON t.user_id=u.id LEFT JOIN departments d ON u.department_id=d.id
      WHERE t.user_id=$1 AND t.week_start_date BETWEEN $2 AND $3 ORDER BY t.week_start_date ASC
    `, [user_id, p.start_date, p.end_date]);
    const userRes = await pool.query('SELECT id, name, email, department_id FROM users WHERE id=$1', [user_id]);
    let total_hours = 0, leave_days = 0, holiday_days = 0;
    const weeks = [];
    for (const ts of timesheets.rows) {
      const logs = await pool.query(`
        SELECT dl.project_id, p.name as project_name, SUM(dl.hours) as hours,
               COUNT(DISTINCT dl.date) FILTER (WHERE dl.notes IN ('annual_leave','sick_leave')) as leave_days,
               COUNT(DISTINCT ph.id) as holiday_days
        FROM daily_logs dl JOIN projects p ON dl.project_id=p.id
        LEFT JOIN public_holidays ph ON ph.date=dl.date
        WHERE dl.user_id=$1 AND dl.week_start_date=$2
        GROUP BY dl.project_id, p.name
      `, [user_id, toDateKey(ts.week_start_date)]);
      const wh = logs.rows.reduce((s: number, r: any) => s + parseFloat(r.hours || 0), 0);
      const wl = logs.rows.reduce((s: number, r: any) => s + parseInt(r.leave_days || 0), 0);
      const wh2 = logs.rows.reduce((s: number, r: any) => s + parseInt(r.holiday_days || 0), 0);
      total_hours += wh; leave_days += wl; holiday_days += wh2;
      weeks.push({ ...ts, week_total_hours: wh, projects: logs.rows, week_leave_days: wl, week_holiday_days: wh2 });
    }
    res.json({
      user: userRes.rows[0], period: p, weeks,
      period_totals: {
        total_hours, leave_days, holiday_days,
        submitted_weeks: weeks.filter((w: any) => ['submitted','under_review'].includes(w.status)).length,
        approved_weeks: weeks.filter((w: any) => w.status === 'approved').length,
        pending_weeks: weeks.filter((w: any) => w.status === 'submitted').length,
        total_weeks: weeks.length,
      }
    });
  } catch (err) {
    console.error('Monthly summary error:', err);
    res.status(500).json({ error: 'Failed to generate monthly summary.' });
  }
});

// GET /timesheets/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const ts = await pool.query(`SELECT t.*, u.name as user_name, u.department_id FROM timesheets t JOIN users u ON t.user_id=u.id WHERE t.id=$1`, [req.params.id]);
    if (ts.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    if (!(await canAccessUser(req.user!, ts.rows[0].user_id))) return res.status(403).json({ error: 'Access denied.' });
    const entries = await pool.query(`SELECT e.*, p.name as project_name, p.code as project_code FROM timesheet_entries e LEFT JOIN projects p ON e.project_id=p.id WHERE e.timesheet_id=$1 ORDER BY e.date ASC`, [req.params.id]);
    res.json({ ...ts.rows[0], entries: entries.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch timesheet.' });
  }
});

// POST /timesheets
router.post('/', authenticate, async (req, res) => {
  const { week_start_date, week_end_date, accounting_period } = req.body;
  const user_id = req.user!.id;
  try {
    const period = await pool.query('SELECT is_closed FROM accounting_periods WHERE period_code=$1', [accounting_period]);
    if (period.rows[0]?.is_closed) return res.status(400).json({ error: `Period ${accounting_period} is closed.` });
    const result = await pool.query(
      `INSERT INTO timesheets (user_id, week_start_date, week_end_date, accounting_period, status) VALUES ($1,$2,$3,$4,'draft') RETURNING *`,
      [user_id, week_start_date, week_end_date, accounting_period]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create timesheet.' });
  }
});

// POST /timesheets/:id/entries
router.post('/:id/entries', authenticate, async (req, res) => {
  const { entries } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      await client.query(
        `INSERT INTO timesheet_entries (timesheet_id, project_id, date, hours, entry_type, notes, is_leave_blocked)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET
         project_id=EXCLUDED.project_id, date=EXCLUDED.date, hours=EXCLUDED.hours,
         entry_type=EXCLUDED.entry_type, notes=EXCLUDED.notes, is_leave_blocked=EXCLUDED.is_leave_blocked`,
        [req.params.id, entry.project_id, entry.date, entry.hours, entry.entry_type, entry.notes, entry.is_leave_blocked]
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'Entries updated.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to update entries.' });
  } finally {
    client.release();
  }
});

// PATCH /timesheets/:id/submit
router.patch('/:id/submit', authenticate, async (req, res) => {
  const { shortfall_explanation } = req.body || {};
  try {
    const existing = await pool.query(
      `SELECT t.*, ap.is_closed FROM timesheets t
       LEFT JOIN accounting_periods ap ON ap.period_code=t.accounting_period
       WHERE t.id=$1 AND t.user_id=$2`,
      [req.params.id, req.user!.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    const timesheet = existing.rows[0];
    if (timesheet.is_closed && !timesheet.is_admin_unlocked) {
      return res.status(400).json({ error: `Period ${timesheet.accounting_period} is closed.` });
    }
    if (!['draft', 'rejected'].includes(timesheet.status)) {
      return res.status(400).json({ error: `Only draft or returned timesheets can be submitted. Status: ${timesheet.status}.` });
    }
    const { shortfalls, mode, minHours } = await validateMinimumHours(
      req.user!.id, toDateKey(timesheet.week_start_date), toDateKey(timesheet.week_end_date)
    );
    if (shortfalls.length > 0) {
      if (mode === 'block') {
        return res.status(400).json({
          error: `Submission blocked. Days below ${minHours}h minimum: ${shortfalls.join(', ')}.`,
          shortfall_dates: shortfalls, mode: 'block',
        });
      }
      if (mode === 'flag' && !shortfall_explanation?.trim()) {
        return res.status(400).json({
          error: `Days below ${minHours}h minimum: ${shortfalls.join(', ')}. Provide shortfall_explanation to proceed.`,
          shortfall_dates: shortfalls, mode: 'flag', requires_explanation: true,
        });
      }
    }
    const hasFlag = shortfalls.length > 0 && mode === 'flag';
    const result = await pool.query(
      `UPDATE timesheets SET status='submitted', submitted_at=NOW(),
       has_shortfall_flag=$1, shortfall_explanation=$2, is_admin_unlocked=false
       WHERE id=$3 AND user_id=$4 RETURNING *`,
      [hasFlag, hasFlag ? shortfall_explanation : null, req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...result.rows[0], enforcement_mode: mode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit timesheet.' });
  }
});

// PATCH /timesheets/:id/withdraw — Employee pulls back a pending/under-review submission
router.patch('/:id/withdraw', authenticate, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT t.*, ap.is_closed
       FROM timesheets t
       LEFT JOIN accounting_periods ap ON ap.period_code = t.accounting_period
       WHERE t.id = $1 AND t.user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Timesheet not found.' });

    const ts = existing.rows[0];

    if (ts.is_closed && !ts.is_admin_unlocked) {
      return res.status(400).json({ error: `Period ${ts.accounting_period} is closed. This timesheet cannot be withdrawn.` });
    }

    if (!['submitted', 'under_review'].includes(ts.status)) {
      return res.status(400).json({
        error: `Only submitted or under-review timesheets can be withdrawn. Current status: ${ts.status}.`,
      });
    }

    const result = await pool.query(
      `UPDATE timesheets
       SET status = 'draft', submitted_at = NULL, approved_by = NULL, approved_at = NULL
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to withdraw timesheet.' });
  }
});

// PATCH /timesheets/:id/review
router.patch('/:id/review', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  try {
    const target = await pool.query('SELECT user_id FROM timesheets WHERE id=$1', [req.params.id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    if (!(await canAccessUser(req.user!, target.rows[0].user_id))) return res.status(403).json({ error: 'Access denied.' });
    const result = await pool.query(`UPDATE timesheets SET status='under_review' WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update.' });
  }
});

// PATCH /timesheets/:id/return
router.patch('/:id/return', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Return reason is required.' });
  try {
    const target = await pool.query('SELECT user_id FROM timesheets WHERE id=$1', [req.params.id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    if (!(await canAccessUser(req.user!, target.rows[0].user_id))) return res.status(403).json({ error: 'Access denied.' });
    const result = await pool.query(
      `UPDATE timesheets SET status='rejected', approved_by=$1, approved_at=NOW(), rejection_reason=$2 WHERE id=$3 RETURNING *`,
      [req.user!.id, reason, req.params.id]
    );
    await pool.query(`INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'approval','Timesheet returned',$2)`,
      [target.rows[0].user_id, `Your timesheet was returned by ${req.user!.name}. Reason: ${reason}`]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to return.' });
  }
});

// POST /timesheets/:id/unlock — Admin only
router.post('/:id/unlock', authenticate, requireRole('admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'A reason is required to unlock a timesheet.' });
  const user = req.user!;
  try {
    const ts = await pool.query('SELECT * FROM timesheets WHERE id=$1', [req.params.id]);
    if (ts.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    const result = await pool.query(
      `UPDATE timesheets SET is_admin_unlocked=true, unlock_reason=$1, unlocked_at=NOW(), unlocked_by=$2 WHERE id=$3 RETURNING *`,
      [reason, user.id, req.params.id]
    );
    await pool.query(`INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'system','Your timesheet has been unlocked',$2)`,
      [ts.rows[0].user_id, `Admin has unlocked your timesheet for correction. Reason: ${reason}`]);
    await logAudit(user.id, user.name, 'timesheet_unlocked', 'timesheet', String(req.params.id),
      `Timesheet unlocked for correction`, reason);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlock.' });
  }
});

// POST /timesheets/:id/relock — Admin only
router.post('/:id/relock', authenticate, requireRole('admin'), async (req, res) => {
  const user = req.user!;
  try {
    const result = await pool.query(`UPDATE timesheets SET is_admin_unlocked=false WHERE id=$1 RETURNING *`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await logAudit(user.id, user.name, 'timesheet_relocked', 'timesheet', String(req.params.id), `Timesheet re-locked`);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to relock.' });
  }
});

export default router;
