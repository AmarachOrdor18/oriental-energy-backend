import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

// GET /admin/health
router.get('/health', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const [usersRes, periodsRes, approvalsRes, financeRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users WHERE is_active = true`),
      pool.query(`SELECT COUNT(*) FROM accounting_periods WHERE is_closed = false`),
      pool.query(`SELECT COUNT(*) FROM timesheets WHERE status IN ('submitted','under_review')`),
      pool.query(`SELECT COUNT(DISTINCT t.id) FROM timesheets t
                  LEFT JOIN finance_decisions fd ON fd.timesheet_id = t.id
                  WHERE t.status = 'approved' AND (fd.id IS NULL OR fd.decision = 'pending_review')`)
    ]);
    res.json({
      total_active_users: parseInt(usersRes.rows[0].count),
      open_periods: parseInt(periodsRes.rows[0].count),
      pending_approvals_org: parseInt(approvalsRes.rows[0].count),
      finance_review_queue_depth: parseInt(financeRes.rows[0].count),
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({ error: 'Failed to fetch health data.' });
  }
});

// GET /admin/settings
router.get('/settings', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value, updated_at FROM system_settings ORDER BY key');
    const settings: Record<string, string> = {};
    result.rows.forEach((row: any) => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

// PATCH /admin/settings
router.patch('/settings', authenticate, requireRole('admin'), async (req, res) => {
  const { min_daily_hours, hour_enforcement_mode } = req.body;
  const user = req.user!;
  try {
    if (min_daily_hours !== undefined) {
      const val = Number(min_daily_hours);
      if (isNaN(val) || val < 1 || val > 24) {
        return res.status(400).json({ error: 'min_daily_hours must be between 1 and 24.' });
      }
      await pool.query(
        `UPDATE system_settings SET value=$1, updated_by=$2, updated_at=NOW() WHERE key='min_daily_hours'`,
        [String(val), user.id]
      );
    }
    if (hour_enforcement_mode !== undefined) {
      if (!['block','flag','warn'].includes(hour_enforcement_mode)) {
        return res.status(400).json({ error: 'hour_enforcement_mode must be block, flag, or warn.' });
      }
      await pool.query(
        `UPDATE system_settings SET value=$1, updated_by=$2, updated_at=NOW() WHERE key='hour_enforcement_mode'`,
        [hour_enforcement_mode, user.id]
      );
    }
    await logAudit(user.id, user.name, 'settings_updated', 'system_settings', null,
      `Settings updated: ${JSON.stringify(req.body)}`);
    const result = await pool.query('SELECT key, value FROM system_settings ORDER BY key');
    const settings: Record<string, string> = {};
    result.rows.forEach((row: any) => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// GET /admin/audit-log
router.get('/audit-log', authenticate, requireRole('admin'), async (req, res) => {
  const { date_from, date_to, actor_id, action, offset = '0' } = req.query;
  try {
    let query = `SELECT al.*, u.email as actor_email FROM audit_log al
                 LEFT JOIN users u ON al.actor_id = u.id WHERE 1=1`;
    const params: any[] = [];
    let pc = 0;
    if (date_from) { pc++; query += ` AND al.created_at >= $${pc}`; params.push(date_from); }
    if (date_to) { pc++; query += ` AND al.created_at <= $${pc}::date + interval '1 day'`; params.push(date_to); }
    if (actor_id) { pc++; query += ` AND al.actor_id = $${pc}`; params.push(actor_id); }
    if (action) { pc++; query += ` AND al.action = $${pc}`; params.push(action); }
    query += ` ORDER BY al.created_at DESC LIMIT 50 OFFSET $${pc + 1}`;
    params.push(parseInt(String(offset)) || 0);
    const result = await pool.query(query, params);
    const countQuery = query.split('ORDER BY')[0].replace('SELECT al.*, u.email as actor_email', 'SELECT COUNT(*)');
    const countParams = params.slice(0, params.length - 1);
    let total = 0;
    try {
      const countRes = await pool.query(countQuery, countParams);
      total = parseInt(countRes.rows[0].count || '0');
    } catch { total = result.rows.length; }
    res.json({ rows: result.rows, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log.' });
  }
});

// POST /admin/reassign-manager
router.post('/reassign-manager', authenticate, requireRole('admin'), async (req, res) => {
  const { from_manager_id, to_manager_id, user_ids } = req.body;
  if (!from_manager_id || !to_manager_id) {
    return res.status(400).json({ error: 'from_manager_id and to_manager_id are required.' });
  }
  const user = req.user!;
  try {
    let query: string;
    let params: any[];
    if (user_ids && Array.isArray(user_ids) && user_ids.length > 0) {
      query = `UPDATE users SET manager_id=$1 WHERE id=ANY($2) AND manager_id=$3 RETURNING id, name`;
      params = [to_manager_id, user_ids, from_manager_id];
    } else {
      query = `UPDATE users SET manager_id=$1 WHERE manager_id=$2 RETURNING id, name`;
      params = [to_manager_id, from_manager_id];
    }
    const result = await pool.query(query, params);
    for (const u of result.rows) {
      await logAudit(user.id, user.name, 'user_manager_changed', 'user', u.id,
        `${u.name} reassigned from manager ${from_manager_id} to ${to_manager_id}`);
    }
    res.json({ reassigned: result.rows.length, users: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reassign manager.' });
  }
});

export default router;
