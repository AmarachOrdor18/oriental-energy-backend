import { Router } from 'express';
import { pool } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

async function canAccessUser(requestUser: NonNullable<Express.Request['user']>, targetUserId: string) {
  if (requestUser.role === 'admin' || requestUser.role === 'finance') return true;
  if (requestUser.id === targetUserId) return true;

  if (requestUser.role === 'line_manager') {
    const result = await pool.query('SELECT 1 FROM users WHERE id = $1 AND manager_id = $2', [targetUserId, requestUser.id]);
    return result.rows.length > 0;
  }

  if (requestUser.role === 'hod') {
    const result = await pool.query('SELECT 1 FROM users WHERE id = $1 AND department_id = $2', [targetUserId, requestUser.department_id]);
    return result.rows.length > 0;
  }

  return false;
}

async function editableWeekError(userId: string, weekStartDate: string) {
  const period = await pool.query(
    'SELECT period_code FROM accounting_periods WHERE $1::date BETWEEN start_date AND end_date AND is_closed = true',
    [weekStartDate]
  );
  if (period.rows.length > 0) {
    return `Accounting period ${period.rows[0].period_code} is closed. Daily logs are read-only.`;
  }

  const timesheet = await pool.query(
    `SELECT status FROM timesheets
     WHERE user_id = $1 AND week_start_date = $2 AND status IN ('submitted', 'under_review', 'approved')`,
    [userId, weekStartDate]
  );
  if (timesheet.rows.length > 0) {
    return `This week is ${timesheet.rows[0].status.replace('_', ' ')} and cannot be edited.`;
  }

  return null;
}

// GET /daily-logs — Fetch logs with filters
router.get('/', authenticate, async (req, res) => {
  const { user_id, week_start, date_from, date_to } = req.query;
  const targetUserId = typeof user_id === 'string' ? user_id : req.user!.id;
  try {
    if (!(await canAccessUser(req.user!, targetUserId))) {
      return res.status(403).json({ error: 'You do not have permission to view these daily logs.' });
    }

    let query = `
      SELECT dl.*, p.name as project_name, p.code as project_code
      FROM daily_logs dl
      JOIN projects p ON dl.project_id = p.id
      WHERE dl.user_id = $1
    `;
    const params: any[] = [targetUserId];
    let pc = 1;

    if (week_start) {
      pc++; query += ` AND dl.week_start_date = $${pc}`; params.push(week_start);
    }
    if (date_from) {
      pc++; query += ` AND dl.date >= $${pc}`; params.push(date_from);
    }
    if (date_to) {
      pc++; query += ` AND dl.date <= $${pc}`; params.push(date_to);
    }

    query += ' ORDER BY dl.date ASC, p.name ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get daily logs error:', err);
    res.status(500).json({ error: 'Failed to fetch daily logs.' });
  }
});

// GET /daily-logs/weekly-summary — Aggregated weekly view
router.get('/weekly-summary', authenticate, async (req, res) => {
  const { user_id, week_start } = req.query;
  const targetUserId = typeof user_id === 'string' ? user_id : req.user!.id;
  try {
    if (!(await canAccessUser(req.user!, targetUserId))) {
      return res.status(403).json({ error: 'You do not have permission to view this weekly summary.' });
    }

    // Get all log entries for this week
    const logs = await pool.query(`
      SELECT dl.*, p.name as project_name, p.code as project_code, p.max_hours_per_week
      FROM daily_logs dl
      JOIN projects p ON dl.project_id = p.id
      WHERE dl.user_id = $1 AND dl.week_start_date = $2
      ORDER BY p.name ASC, dl.date ASC
    `, [targetUserId, week_start]);

    // Get daily totals
    const dailyTotals = await pool.query(`
      SELECT date, SUM(hours) as total_hours, bool_and(is_filled) as all_filled
      FROM daily_logs
      WHERE user_id = $1 AND week_start_date = $2
      GROUP BY date ORDER BY date ASC
    `, [targetUserId, week_start]);

    // Get project totals
    const projectTotals = await pool.query(`
      SELECT project_id, p.name as project_name, p.code as project_code, SUM(hours) as total_hours
      FROM daily_logs dl JOIN projects p ON dl.project_id = p.id
      WHERE dl.user_id = $1 AND dl.week_start_date = $2
      GROUP BY dl.project_id, p.name, p.code
    `, [targetUserId, week_start]);

    const grandTotal = logs.rows.reduce((sum: number, r: any) => sum + parseFloat(r.hours || 0), 0);

    res.json({
      entries: logs.rows,
      daily_totals: dailyTotals.rows,
      project_totals: projectTotals.rows,
      grand_total: grandTotal,
    });
  } catch (err) {
    console.error('Weekly summary error:', err);
    res.status(500).json({ error: 'Failed to fetch weekly summary.' });
  }
});

// POST /daily-logs — Create or upsert daily log entry
router.post('/', authenticate, async (req, res) => {
  const { project_id, date, hours, notes, week_start_date } = req.body;
  const user_id = req.user!.id;

  if (!project_id || !date || !week_start_date) {
    return res.status(400).json({ error: 'project_id, date, and week_start_date are required.' });
  }

  try {
    const editError = await editableWeekError(user_id, week_start_date);
    if (editError) return res.status(400).json({ error: editError });

    const result = await pool.query(`
      INSERT INTO daily_logs (user_id, project_id, date, hours, notes, week_start_date, is_filled, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id, project_id, date)
      DO UPDATE SET hours = $4, notes = $5, is_filled = $7, updated_at = NOW()
      RETURNING *
    `, [user_id, project_id, date, hours || 0, notes || '', week_start_date, (hours || 0) > 0]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create daily log error:', err);
    res.status(500).json({ error: 'Failed to save daily log.' });
  }
});

// POST /daily-logs/batch — Batch upsert multiple entries
router.post('/batch', authenticate, async (req, res) => {
  const { entries } = req.body; // Array of { project_id, date, hours, notes, week_start_date }
  const user_id = req.user!.id;

  if (!entries || !Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries array is required.' });
  }

  const client = await pool.connect();
  try {
    const weekStarts = Array.from(new Set(entries.map((entry: any) => String(entry.week_start_date))));
    for (const weekStart of weekStarts) {
      const editError = await editableWeekError(user_id, weekStart);
      if (editError) return res.status(400).json({ error: editError });
    }

    await client.query('BEGIN');
    const results: any[] = [];

    for (const entry of entries) {
      const r = await client.query(`
        INSERT INTO daily_logs (user_id, project_id, date, hours, notes, week_start_date, is_filled, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (user_id, project_id, date)
        DO UPDATE SET hours = $4, notes = $5, is_filled = $7, updated_at = NOW()
        RETURNING *
      `, [user_id, entry.project_id, entry.date, entry.hours || 0, entry.notes || '', entry.week_start_date, (entry.hours || 0) > 0]);
      results.push(r.rows[0]);
    }

    await client.query('COMMIT');
    res.json({ saved: results.length, entries: results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Batch daily log error:', err);
    res.status(500).json({ error: 'Failed to save daily log entries.' });
  } finally {
    client.release();
  }
});

// PATCH /daily-logs/:id — Update single entry
// POST /daily-logs/day - Replace one calendar day with work or leave entries
router.post('/day', authenticate, async (req, res) => {
  const { date, week_start_date, entries = [], leave_type } = req.body;
  const user_id = req.user!.id;

  if (!date || !week_start_date) {
    return res.status(400).json({ error: 'date and week_start_date are required.' });
  }
  if (leave_type && !['annual_leave', 'sick_leave'].includes(leave_type)) {
    return res.status(400).json({ error: 'leave_type must be annual_leave or sick_leave.' });
  }
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries must be an array.' });
  }

  const client = await pool.connect();
  try {
    const editError = await editableWeekError(user_id, week_start_date);
    if (editError) return res.status(400).json({ error: editError });

    await client.query('BEGIN');
    await client.query('DELETE FROM daily_logs WHERE user_id = $1 AND date = $2', [user_id, date]);

    const results: any[] = [];
    if (leave_type) {
      const projectId = entries[0]?.project_id;
      if (!projectId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A project_id is required to mark leave for this day.' });
      }
      const r = await client.query(`
        INSERT INTO daily_logs (user_id, project_id, date, hours, notes, week_start_date, is_filled, updated_at)
        VALUES ($1, $2, $3, 0, $4, $5, true, NOW())
        RETURNING *
      `, [user_id, projectId, date, leave_type, week_start_date]);
      results.push(r.rows[0]);
    } else {
      for (const entry of entries) {
        if (!entry.project_id || !(Number(entry.hours) > 0)) continue;
        const r = await client.query(`
          INSERT INTO daily_logs (user_id, project_id, date, hours, notes, week_start_date, is_filled, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
          RETURNING *
        `, [user_id, entry.project_id, date, entry.hours, entry.notes || '', week_start_date]);
        results.push(r.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ saved: results.length, entries: results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Replace daily log day error:', err);
    res.status(500).json({ error: 'Failed to save daily log day.' });
  } finally {
    client.release();
  }
});

router.patch('/:id', authenticate, async (req, res) => {
  const { hours, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE daily_logs SET hours=COALESCE($1,hours), notes=COALESCE($2,notes), is_filled=(COALESCE($1,hours)>0), updated_at=NOW()
       WHERE id=$3 AND user_id=$4 RETURNING *`,
      [hours, notes, req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Log entry not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update log entry.' });
  }
});

export default router;
