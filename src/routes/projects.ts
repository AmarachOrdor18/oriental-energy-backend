import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

// GET /projects — List projects (department-scoped for non-admin)
router.get('/', authenticate, async (req, res) => {
  const { department_id } = req.query;
  try {
    let query = `
      SELECT p.*, d.name as department_name, d.code as department_code, u.name as created_by_name
      FROM projects p
      LEFT JOIN departments d ON p.department_id = d.id
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.is_active = true
    `;
    const params: any[] = [];
    if (department_id) {
      query += ' AND p.department_id = $1';
      params.push(department_id);
    }
    query += ' ORDER BY p.name ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch projects.' });
  }
});

// POST /projects — Create project (requires can_create_projects or admin)
router.post('/', authenticate, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin' && !user.can_create_projects) {
    return res.status(403).json({ error: 'You do not have permission to create projects.' });
  }

  const { name, code, max_hours_per_week, department_id } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Project name and code are required.' });

  // Non-admin can only create for their department
  const deptId = user.role === 'admin' ? (department_id || null) : user.department_id;

  try {
    const result = await pool.query(
      `INSERT INTO projects (name, code, max_hours_per_week, department_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, code, max_hours_per_week || 40, deptId, user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Project code already exists.' });
    res.status(500).json({ error: 'Failed to create project.' });
  }
});

// PATCH /projects/:id
router.patch('/:id', authenticate, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin' && !user.can_create_projects) return res.status(403).json({ error: 'Access denied.' });
  const { name, code, max_hours_per_week, department_id, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE projects SET name=COALESCE($1,name), code=COALESCE($2,code),
       max_hours_per_week=COALESCE($3,max_hours_per_week), department_id=COALESCE($4,department_id),
       is_active=COALESCE($5,is_active) WHERE id=$6 RETURNING *`,
      [name||null, code||null, max_hours_per_week||null, department_id||null,
       is_active!==undefined?is_active:null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await logAudit(user.id, user.name, 'project_updated', 'project', String(req.params.id), `Project ${result.rows[0].name} updated`);
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Code already in use.' });
    res.status(500).json({ error: 'Failed to update.' });
  }
});

export default router;
