import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

// GET /reports/not-posted?period_code=&department_id=&manager_id=
router.get('/not-posted', authenticate, requireRole('finance', 'admin', 'hod', 'line_manager'), async (req, res) => {
  const { period_code, department_id, manager_id } = req.query;
  if (!period_code) return res.status(400).json({ error: 'period_code is required.' });
  const user = req.user!;
  try {
    const periodRes = await pool.query('SELECT * FROM accounting_periods WHERE period_code=$1', [period_code]);
    if (periodRes.rows.length === 0) return res.status(404).json({ error: 'Period not found.' });
    const period = periodRes.rows[0];

    let scopeFilter = '';
    const params: any[] = [period.start_date, period.end_date];
    let pc = 2;

    if (user.role === 'line_manager') { pc++; scopeFilter += ` AND u.manager_id=$${pc}`; params.push(user.id); }
    else if (user.role === 'hod') { pc++; scopeFilter += ` AND u.department_id=$${pc}`; params.push(user.department_id); }
    if (department_id) { pc++; scopeFilter += ` AND u.department_id=$${pc}`; params.push(department_id); }
    if (manager_id) { pc++; scopeFilter += ` AND u.manager_id=$${pc}`; params.push(manager_id); }

    const result = await pool.query(`
      SELECT u.id, u.name, u.email,
             d.name as department_name, m.name as manager_name,
             (SELECT MAX(t.submitted_at) FROM timesheets t WHERE t.user_id=u.id) as last_submitted
      FROM users u
      LEFT JOIN departments d ON u.department_id=d.id
      LEFT JOIN users m ON u.manager_id=m.id
      WHERE u.is_active=true AND u.role IN ('user','line_manager','hod')
        ${scopeFilter}
        AND NOT EXISTS (
          SELECT 1 FROM timesheets t
          WHERE t.user_id=u.id
            AND t.status IN ('submitted','under_review','approved')
            AND t.week_start_date BETWEEN $1 AND $2
        )
      ORDER BY u.name
    `, params);
    res.json({ period, not_posted: result.rows });
  } catch (err) {
    console.error('Not-posted report error:', err);
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

// GET /reports/hours-summary?date_from=&date_to=&user_id=&department_id=&project_id=
router.get('/hours-summary', authenticate, requireRole('finance', 'admin', 'hod', 'line_manager'), async (req, res) => {
  const { date_from, date_to, user_id, department_id, project_id } = req.query;
  if (!date_from || !date_to) return res.status(400).json({ error: 'date_from and date_to are required.' });
  const user = req.user!;
  try {
    let scopeFilter = '';
    const params: any[] = [date_from, date_to];
    let pc = 2;

    if (user.role === 'line_manager') { pc++; scopeFilter += ` AND u.manager_id=$${pc}`; params.push(user.id); }
    else if (user.role === 'hod') { pc++; scopeFilter += ` AND u.department_id=$${pc}`; params.push(user.department_id); }
    if (user_id) { pc++; scopeFilter += ` AND dl.user_id=$${pc}`; params.push(user_id); }
    if (department_id) { pc++; scopeFilter += ` AND u.department_id=$${pc}`; params.push(department_id); }
    if (project_id) { pc++; scopeFilter += ` AND dl.project_id=$${pc}`; params.push(project_id); }

    const result = await pool.query(`
      SELECT u.name as user_name, d.name as department_name,
             p.name as project_name, p.code as project_code,
             SUM(dl.hours) as total_hours,
             COUNT(DISTINCT dl.date) as days_logged
      FROM daily_logs dl
      JOIN users u ON dl.user_id=u.id
      LEFT JOIN departments d ON u.department_id=d.id
      JOIN projects p ON dl.project_id=p.id
      WHERE dl.date BETWEEN $1 AND $2 AND dl.hours > 0
        ${scopeFilter}
      GROUP BY u.name, d.name, p.name, p.code
      ORDER BY u.name, p.name
    `, params);
    const total = result.rows.reduce((s: number, r: any) => s + parseFloat(r.total_hours || 0), 0);
    res.json({ rows: result.rows, summary: { total_hours: total, date_from, date_to } });
  } catch (err) {
    console.error('Hours summary error:', err);
    res.status(500).json({ error: 'Failed to generate summary.' });
  }
});

export default router;
