import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

// GET /activities?project_id=
router.get('/', authenticate, async (req, res) => {
  const { project_id } = req.query;
  try {
    let query = `SELECT a.*, p.name as project_name, p.code as project_code
                 FROM activities a
                 JOIN projects p ON a.project_id = p.id
                 WHERE a.is_active = true`;
    const params: any[] = [];
    if (project_id) {
      query += ' AND a.project_id = $1';
      params.push(project_id);
    }
    query += ' ORDER BY p.name, a.name';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Activities GET error:', err);
    res.status(500).json({ error: 'Failed to fetch activities.' });
  }
});

// POST /activities
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { project_id, name, code } = req.body;
  if (!project_id || !name || !code) {
    return res.status(400).json({ error: 'project_id, name, and code are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO activities (project_id, name, code) VALUES ($1, $2, $3) RETURNING *',
      [project_id, name, code.toUpperCase()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An activity with this code already exists for this project.' });
    }
    console.error('Activity create error:', err);
    res.status(500).json({ error: 'Failed to create activity.' });
  }
});

// PATCH /activities/:id
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { name, code, is_active } = req.body;
  try {
    const sets: string[] = [];
    const params: any[] = [];
    let pc = 0;
    if (name !== undefined) { pc++; sets.push(`name=$${pc}`); params.push(name); }
    if (code !== undefined) { pc++; sets.push(`code=$${pc}`); params.push(code.toUpperCase()); }
    if (is_active !== undefined) { pc++; sets.push(`is_active=$${pc}`); params.push(is_active); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    pc++;
    params.push(id);
    const result = await pool.query(
      `UPDATE activities SET ${sets.join(', ')} WHERE id=$${pc} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Activity not found.' });
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Activity code already in use.' });
    console.error('Activity update error:', err);
    res.status(500).json({ error: 'Failed to update activity.' });
  }
});

// DELETE /activities/:id — soft delete
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE activities SET is_active = false WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Activity delete error:', err);
    res.status(500).json({ error: 'Failed to deactivate activity.' });
  }
});

export default router;
