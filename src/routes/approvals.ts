import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

async function canReviewTimesheet(requestUser: NonNullable<Express.Request['user']>, timesheetId: string) {
  if (requestUser.role === 'admin') return true;
  const params: any[] = [timesheetId];
  let scope = '';
  if (requestUser.role === 'line_manager') { params.push(requestUser.id); scope = 'AND u.manager_id=$2'; }
  else if (requestUser.role === 'hod') { params.push(requestUser.department_id); scope = 'AND u.department_id=$2'; }
  else return false;
  const result = await pool.query(`SELECT 1 FROM timesheets t JOIN users u ON t.user_id=u.id WHERE t.id=$1 ${scope}`, params);
  return result.rows.length > 0;
}

router.get('/pending', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const user = req.user!;
  try {
    let query = `SELECT t.*, u.name as user_name, u.email as user_email, d.name as department_name
                 FROM timesheets t JOIN users u ON t.user_id=u.id LEFT JOIN departments d ON u.department_id=d.id
                 WHERE t.status IN ('submitted','under_review')`;
    const params: any[] = [];
    if (user.role === 'line_manager') { query += ` AND t.user_id IN (SELECT id FROM users WHERE manager_id=$1)`; params.push(user.id); }
    else if (user.role === 'hod') { query += ` AND t.user_id IN (SELECT id FROM users WHERE department_id=$1)`; params.push(user.department_id); }
    query += ' ORDER BY t.submitted_at ASC';
    res.json((await pool.query(query, params)).rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch.' });
  }
});

router.patch('/:id/approve', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const user = req.user!;
  try {
    if (!(await canReviewTimesheet(user, String(req.params.id)))) return res.status(403).json({ error: 'Access denied.' });
    const result = await pool.query(`UPDATE timesheets SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2 RETURNING *`, [user.id, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await pool.query(`INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'approval','Timesheet approved',$2)`,
      [result.rows[0].user_id, `Your timesheet has been approved by ${user.name}.`]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve.' });
  }
});

router.patch('/:id/reject', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Rejection reason is required.' });
  const user = req.user!;
  try {
    if (!(await canReviewTimesheet(user, String(req.params.id)))) return res.status(403).json({ error: 'Access denied.' });
    const result = await pool.query(`UPDATE timesheets SET status='rejected', approved_by=$1, approved_at=NOW(), rejection_reason=$2 WHERE id=$3 RETURNING *`, [user.id, reason, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await pool.query(`INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'approval','Timesheet returned',$2)`,
      [result.rows[0].user_id, `Your timesheet was returned by ${user.name}. Reason: ${reason}`]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject.' });
  }
});

router.post('/bulk-approve', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids array required.' });
  const user = req.user!;
  try {
    let scopeFilter = '';
    const params: any[] = [ids];
    if (user.role === 'line_manager') { scopeFilter = 'AND u.manager_id=$2'; params.push(user.id); }
    else if (user.role === 'hod') { scopeFilter = 'AND u.department_id=$2'; params.push(user.department_id); }
    const scopedRes = await pool.query(`SELECT t.id FROM timesheets t JOIN users u ON t.user_id=u.id WHERE t.id=ANY($1) ${scopeFilter}`, params);
    const allowedIds = scopedRes.rows.map((r: any) => r.id);
    if (allowedIds.length === 0) return res.status(403).json({ error: 'No timesheets in scope.' });
    const result = await pool.query(
      `UPDATE timesheets SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=ANY($2) AND status IN ('submitted','under_review') RETURNING id, user_id`,
      [user.id, allowedIds]
    );
    for (const ts of result.rows) {
      await pool.query(`INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'approval','Timesheet approved',$2)`,
        [ts.user_id, `Your timesheet approved by ${user.name} (bulk).`]);
    }
    await logAudit(user.id, user.name, 'bulk_approval', 'timesheet', null, `Bulk approved ${result.rows.length} timesheets`);
    res.json({ approved: result.rows.length, ids: result.rows.map((r: any) => r.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to bulk approve.' });
  }
});

router.post('/approve-month', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const { user_id, period_code } = req.body;
  if (!user_id || !period_code) return res.status(400).json({ error: 'user_id and period_code required.' });
  const user = req.user!;
  try {
    const periodRes = await pool.query('SELECT * FROM accounting_periods WHERE period_code=$1', [period_code]);
    if (periodRes.rows.length === 0) return res.status(404).json({ error: 'Period not found.' });
    const p = periodRes.rows[0];
    if (user.role !== 'admin') {
      const checkCol = user.role === 'line_manager' ? 'manager_id' : 'department_id';
      const checkVal = user.role === 'line_manager' ? user.id : user.department_id;
      const check = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND ${checkCol}=$2`, [user_id, checkVal]);
      if (check.rows.length === 0) return res.status(403).json({ error: 'Access denied.' });
    }
    const result = await pool.query(
      `UPDATE timesheets SET status='approved', approved_by=$1, approved_at=NOW()
       WHERE user_id=$2 AND status IN ('submitted','under_review') AND week_start_date BETWEEN $3 AND $4
       RETURNING id, user_id`,
      [user.id, user_id, p.start_date, p.end_date]
    );
    for (const ts of result.rows) {
      await logAudit(user.id, user.name, 'timesheet_approved', 'timesheet', ts.id, `Month approval: ${period_code}`);
    }
    if (result.rows.length > 0) {
      await pool.query(`INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'approval',$2,$3)`,
        [user_id, `All timesheets approved for ${period_code}`,
          `${user.name} approved all ${result.rows.length} timesheet(s) for period ${period_code}.`]);
    }
    res.json({ approved: result.rows.length, period_code, ids: result.rows.map((r: any) => r.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve month.' });
  }
});

router.post('/broadcast-reminder', authenticate, requireRole('line_manager', 'hod'), async (req, res) => {
  const { message, defaulters_only } = req.body || {};
  const user = req.user!;
  try {
    const scope = user.role === 'line_manager' ? user.id : user.department_id;
    const col = user.role === 'line_manager' ? 'manager_id' : 'department_id';
    let memberIds: string[];
    if (defaulters_only) {
      const weekStart = new Date();
      const day = weekStart.getDay();
      weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));
      const weekStartStr = weekStart.toISOString().split('T')[0];
      const result = await pool.query(
        `SELECT u.id FROM users u
         WHERE u.${col} = $1 AND u.is_active = true
           AND u.id NOT IN (
             SELECT user_id FROM timesheets
             WHERE week_start_date = $2
               AND status IN ('submitted', 'under_review', 'approved')
           )`,
        [scope, weekStartStr]
      );
      memberIds = result.rows.map((r: any) => r.id);
    } else {
      const result = await pool.query(`SELECT id FROM users WHERE ${col}=$1 AND is_active=true`, [scope]);
      memberIds = result.rows.map((r: any) => r.id);
    }
    for (const id of memberIds) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'broadcast',$2,$3)`,
        [id, `Reminder from ${user.name}`, message || 'Please submit your timesheets.']
      );
    }
    res.json({ sent: memberIds.length, message: `Reminder sent to ${memberIds.length} member${memberIds.length !== 1 ? 's' : ''}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send broadcast.' });
  }
});

export default router;
