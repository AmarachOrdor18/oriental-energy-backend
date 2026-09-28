import { Router } from 'express';
import { notify } from '../services/emailService';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';
import { dispatchBroadcast } from '../services/broadcastService';

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
    await notify(result.rows[0].user_id, 'approval', 'Timesheet approved',
      `Your timesheet has been approved by ${user.name}.`);
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
    await notify(result.rows[0].user_id, 'approval', 'Timesheet returned',
      `Your timesheet was returned by ${user.name}. Reason: ${reason}`);
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
      await notify(ts.user_id, 'approval', 'Timesheet approved',
        `Your timesheet approved by ${user.name} (bulk).`);
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
      await notify(user_id, 'approval', `All timesheets approved for ${period_code}`,
        `${user.name} approved all ${result.rows.length} timesheet(s) for period ${period_code}.`);
    }
    res.json({ approved: result.rows.length, period_code, ids: result.rows.map((r: any) => r.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve month.' });
  }
});

router.post('/broadcast-reminder', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const { message, defaulters_only } = req.body || {};
  const user = req.user!;
  try {
    const count = await dispatchBroadcast({
      senderId: user.id,
      senderName: user.name,
      role: user.role,
      departmentId: user.department_id,
      message: message || 'Please submit your timesheets.',
      defaultersOnly: !!defaulters_only,
    });
    res.json({ sent: count, message: `Reminder sent to ${count} member${count !== 1 ? 's' : ''}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send broadcast.' });
  }
});

// ── Scheduled broadcasts ────────────────────────────────────────────────────
// POST /broadcasts | schedule for later (scheduled_for ISO) or send now when omitted
router.post('/broadcasts', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  const { message, defaulters_only, scheduled_for } = req.body || {};
  const user = req.user!;
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }
  let scheduledFor: Date | null = null;
  if (scheduled_for) {
    scheduledFor = new Date(scheduled_for);
    if (Number.isNaN(scheduledFor.getTime())) {
      return res.status(400).json({ error: 'scheduled_for must be a valid datetime.' });
    }
  }
  try {
    if (!scheduledFor) {
      // Immediate send via the shared dispatcher.
      const count = await dispatchBroadcast({
        senderId: user.id,
        senderName: user.name,
        role: user.role,
        departmentId: user.department_id,
        message,
        defaultersOnly: !!defaulters_only,
      });
      const record = await pool.query(
        `INSERT INTO scheduled_broadcasts (sender_id, message, defaulters_only, sent_at, status, recipient_count)
         VALUES ($1,$2,$3,NOW(),'sent',$4) RETURNING id`,
        [user.id, message, !!defaulters_only, count]
      );
      return res.json({ id: record.rows[0].id, sent: count, status: 'sent' });
    }
    const record = await pool.query(
      `INSERT INTO scheduled_broadcasts (sender_id, message, defaulters_only, scheduled_for)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [user.id, message, !!defaulters_only, scheduledFor]
    );
    res.json({ id: record.rows[0].id, status: 'scheduled', scheduled_for: record.rows[0].scheduled_for });
  } catch (err) {
    console.error('Broadcast create error:', err);
    res.status(500).json({ error: 'Failed to create broadcast.' });
  }
});

// GET /broadcasts | this sender's history (scheduled + sent), newest first
router.get('/broadcasts', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, message, defaulters_only, scheduled_for, sent_at, status, recipient_count, created_at
       FROM scheduled_broadcasts WHERE sender_id = $1
       ORDER BY COALESCE(scheduled_for, sent_at, created_at) DESC LIMIT 50`,
      [req.user!.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load broadcasts.' });
  }
});

// DELETE /broadcasts/:id | cancel a pending scheduled broadcast (owner only)
router.delete('/broadcasts/:id', authenticate, requireRole('line_manager', 'hod', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE scheduled_broadcasts SET status='cancelled'
       WHERE id=$1 AND sender_id=$2 AND status='scheduled' RETURNING id`,
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending scheduled broadcast with that id.' });
    }
    res.json({ cancelled: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel broadcast.' });
  }
});

export default router;
