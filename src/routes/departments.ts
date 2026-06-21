import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

// GET /departments — List all departments
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.id, d.name, d.code, d.hod_id, d.is_active, d.created_at,
             h.name as hod_name,
             (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = true) as user_count
      FROM departments d
      LEFT JOIN users h ON d.hod_id = h.id
      ORDER BY d.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Get departments error:', err);
    res.status(500).json({ error: 'Failed to fetch departments.' });
  }
});

// GET /departments/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.id, d.name, d.code, d.hod_id, d.is_active, d.created_at,
             h.name as hod_name, h.email as hod_email,
             (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = true) as user_count
      FROM departments d
      LEFT JOIN users h ON d.hod_id = h.id
      WHERE d.id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Department not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch department.' });
  }
});

// POST /departments
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { name, code, hod_id } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Name and code are required.' });
  try {
    const result = await pool.query(
      'INSERT INTO departments (name, code, hod_id) VALUES ($1, $2, $3) RETURNING *',
      [name, code, hod_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Department name or code already exists.' });
    res.status(500).json({ error: 'Failed to create department.' });
  }
});

// PATCH /departments/:id
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const user = req.user!;
  const { name, code, hod_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE departments SET name=COALESCE($1,name), code=COALESCE($2,code), hod_id=COALESCE($3,hod_id) WHERE id=$4 RETURNING *`,
      [name||null, code||null, hod_id||null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await logAudit(user.id, user.name, 'department_updated', 'department', String(req.params.id), `Department ${result.rows[0].name} updated`);
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Name or code already in use.' });
    res.status(500).json({ error: 'Failed to update.' });
  }
});

export default router;
