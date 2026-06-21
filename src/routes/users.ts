import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';
import bcrypt from 'bcryptjs';

const router = Router();

// GET /users — List users with optional filters
router.get('/', authenticate, async (req, res) => {
  const { role, department_id, is_active } = req.query;
  const user = req.user!;
  try {
    let query = `
      SELECT u.id, u.email, u.name, u.role, u.department_id, u.manager_id, u.is_active, u.can_create_projects, u.created_at,
             d.name as department_name, d.code as department_code,
             m.name as manager_name
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      LEFT JOIN users m ON u.manager_id = m.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramCount = 0;

    if (user.role === 'user') {
      paramCount++;
      query += ` AND u.id = $${paramCount}`;
      params.push(user.id);
    } else if (user.role === 'line_manager') {
      paramCount++;
      query += ` AND (u.id = $${paramCount} OR u.manager_id = $${paramCount})`;
      params.push(user.id);
    } else if (user.role === 'hod') {
      paramCount++;
      query += ` AND u.department_id = $${paramCount}`;
      params.push(user.department_id);
    }

    if (role) {
      paramCount++;
      query += ` AND u.role = $${paramCount}`;
      params.push(role);
    }
    if (department_id) {
      paramCount++;
      query += ` AND u.department_id = $${paramCount}`;
      params.push(department_id);
    }
    if (is_active !== undefined) {
      paramCount++;
      query += ` AND u.is_active = $${paramCount}`;
      params.push(is_active === 'true');
    }

    query += ' ORDER BY u.name ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// GET /users/:id — Get single user profile
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.department_id, u.manager_id, u.is_active, u.can_create_projects, u.created_at,
              d.name as department_name, d.code as department_code,
              m.name as manager_name
       FROM users u
       LEFT JOIN departments d ON u.department_id = d.id
       LEFT JOIN users m ON u.manager_id = m.id
       WHERE u.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const target = result.rows[0];
    const user = req.user!;
    const allowed = user.role === 'admin'
      || user.role === 'finance'
      || target.id === user.id
      || (user.role === 'line_manager' && target.manager_id === user.id)
      || (user.role === 'hod' && target.department_id === user.department_id);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to view this user profile.' });
    }
    res.json(target);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// POST /users — Create new user (Admin only)
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { email, name, role, department_id, manager_id, can_create_projects } = req.body;
  if (!email || !name || !role) {
    return res.status(400).json({ error: 'Email, name, and role are required.' });
  }

  try {
    const hashedPw = await bcrypt.hash('Welcome123!', 10); // Default password
    const result = await pool.query(
      `INSERT INTO users (email, name, password_hash, role, department_id, manager_id, can_create_projects)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, name, role, department_id, manager_id, can_create_projects, is_active, created_at`,
      [email, name, hashedPw, role, department_id || null, manager_id || null, can_create_projects || false]
    );
    
    console.log(`[EMAIL STUB] Welcome email sent to ${email} with temporary password.`);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

// PATCH /users/:id — Admin only
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { name, email, role, department_id, manager_id, can_create_projects } = req.body;
  const user = req.user!;
  try {
    const existing = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    const old = existing.rows[0];
    const result = await pool.query(
      `UPDATE users SET
        name=COALESCE($1,name), email=COALESCE($2,email), role=COALESCE($3,role),
        department_id=COALESCE($4,department_id), manager_id=COALESCE($5,manager_id),
        can_create_projects=COALESCE($6,can_create_projects)
       WHERE id=$7 RETURNING *`,
      [name||null, email||null, role||null, department_id||null, manager_id||null,
       can_create_projects!==undefined?can_create_projects:null, req.params.id]
    );
    const changes: string[] = [];
    if (name && name !== old.name) changes.push(`name: ${old.name} → ${name}`);
    if (role && role !== old.role) changes.push(`role: ${old.role} → ${role}`);
    if (changes.length > 0) await logAudit(user.id, user.name, 'user_updated', 'user', String(req.params.id), `User updated: ${changes.join(', ')}`);
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use.' });
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

// PATCH /users/:id/status — Activate/deactivate user (Admin only)
router.patch('/:id/status', authenticate, requireRole('admin'), async (req, res) => {
  const { is_active } = req.body;
  if (is_active === undefined) {
    return res.status(400).json({ error: 'is_active field is required.' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET is_active = $1 WHERE id = $2 RETURNING id, email, name, role, is_active',
      [is_active, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

// GET /users/:id/direct-reports — Return organogram (direct reports)
router.get('/:id/direct-reports', authenticate, async (req, res) => {
  try {
    if (req.params.id !== req.user!.id && req.user!.role !== 'admin') {
      const manager = await pool.query('SELECT department_id FROM users WHERE id = $1', [req.params.id]);
      const sameDepartment = manager.rows[0]?.department_id === req.user!.department_id;
      if (req.user!.role !== 'hod' || !sameDepartment) {
        return res.status(403).json({ error: 'You do not have permission to view these direct reports.' });
      }
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.department_id, u.is_active,
              d.name as department_name
       FROM users u
       LEFT JOIN departments d ON u.department_id = d.id
       WHERE u.manager_id = $1 AND u.is_active = true
       ORDER BY u.name ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Direct reports error:', err);
    res.status(500).json({ error: 'Failed to fetch direct reports.' });
  }
});

// GET /users/:id/timesheet-summary — Timesheet + daily log summary for drill-down
router.get('/:id/timesheet-summary', authenticate, async (req, res) => {
  const { period } = req.query; // optional YYYY-MM filter
  try {
    const targetUser = await pool.query('SELECT id, manager_id, department_id FROM users WHERE id = $1', [req.params.id]);
    if (targetUser.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    const target = targetUser.rows[0];
    const user = req.user!;
    const allowed = user.role === 'admin'
      || user.role === 'finance'
      || target.id === user.id
      || (user.role === 'line_manager' && target.manager_id === user.id)
      || (user.role === 'hod' && target.department_id === user.department_id);
    if (!allowed) {
      return res.status(403).json({ error: 'You do not have permission to view this timesheet summary.' });
    }

    let tsQuery = `
      SELECT t.id, t.week_start_date, t.week_end_date, t.status, t.accounting_period, t.submitted_at, t.approved_at
      FROM timesheets t
      WHERE t.user_id = $1
    `;
    const tsParams: any[] = [req.params.id];

    if (period) {
      tsQuery += ` AND t.accounting_period = $2`;
      tsParams.push(period);
    }
    tsQuery += ' ORDER BY t.week_start_date DESC LIMIT 20';

    const timesheets = await pool.query(tsQuery, tsParams);

    // Daily log completeness
    const logStats = await pool.query(
      `SELECT 
        COUNT(DISTINCT date) as total_days,
        COUNT(DISTINCT CASE WHEN is_filled = true THEN date END) as filled_days
       FROM daily_logs
       WHERE user_id = $1`,
      [req.params.id]
    );

    // Hours by project
    const projectHours = await pool.query(
      `SELECT p.name as project_name, p.code as project_code, SUM(dl.hours) as total_hours
       FROM daily_logs dl
       JOIN projects p ON dl.project_id = p.id
       WHERE dl.user_id = $1
       GROUP BY p.id, p.name, p.code
       ORDER BY total_hours DESC`,
      [req.params.id]
    );

    res.json({
      timesheets: timesheets.rows,
      log_completeness: logStats.rows[0] || { total_days: 0, filled_days: 0 },
      hours_by_project: projectHours.rows,
    });
  } catch (err) {
    console.error('Timesheet summary error:', err);
    res.status(500).json({ error: 'Failed to fetch timesheet summary.' });
  }
});

export default router;
