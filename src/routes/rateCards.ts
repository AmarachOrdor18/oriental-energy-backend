import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

// ── GET /rate-cards — list (optionally filter by grade, project, active-on-date)
router.get('/', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { grade, project_id, effective_on } = req.query;
  try {
    let sql = `
      SELECT rc.*, p.name AS project_name, p.code AS project_code
      FROM rate_cards rc
      LEFT JOIN projects p ON rc.project_id = p.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let pc = 0;
    if (grade) { pc++; sql += ` AND rc.grade = $${pc}`; params.push(grade); }
    if (project_id) { pc++; sql += ` AND rc.project_id = $${pc}`; params.push(project_id); }
    if (effective_on) {
      pc++;
      sql += ` AND rc.effective_from <= $${pc} AND (rc.effective_to IS NULL OR rc.effective_to >= $${pc})`;
      params.push(effective_on);
    }
    sql += ` ORDER BY rc.grade ASC, rc.effective_from DESC`;
    res.json((await pool.query(sql, params)).rows);
  } catch (err) {
    console.error('List rate cards error:', err);
    res.status(500).json({ error: 'Failed to fetch rate cards.' });
  }
});

// ── POST /rate-cards — create (admin only)
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { grade, project_id, cost_rate, charge_rate, currency, effective_from, effective_to } = req.body;
  if (!grade || cost_rate == null || !effective_from) {
    return res.status(400).json({ error: 'grade, cost_rate and effective_from are required.' });
  }
  if (effective_to && effective_to < effective_from) {
    return res.status(400).json({ error: 'effective_to cannot be before effective_from.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO rate_cards (grade, project_id, cost_rate, charge_rate, currency, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [grade, project_id || null, cost_rate, charge_rate ?? cost_rate, currency || 'NGN', effective_from, effective_to || null, req.user!.id]
    );
    await logAudit(req.user!.id, req.user!.name, 'create', 'rate_card', result.rows[0].id,
      `Rate card created: ${grade} / project ${project_id || 'all'} @ ${cost_rate} from ${effective_from}`);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    console.error('Create rate card error:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'A rate card already exists for this grade, project and effective date.' });
    res.status(500).json({ error: 'Failed to create rate card.' });
  }
});

// ── PATCH /rate-cards/:id — update (admin only)
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { cost_rate, charge_rate, effective_from, effective_to, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE rate_cards SET
         cost_rate = COALESCE($1, cost_rate),
         charge_rate = COALESCE($2, charge_rate),
         effective_from = COALESCE($3, effective_from),
         effective_to = COALESCE($4, effective_to),
         is_active = COALESCE($5, is_active),
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [cost_rate, charge_rate, effective_from, effective_to, is_active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rate card not found.' });
    await logAudit(req.user!.id, req.user!.name, 'update', 'rate_card', String(req.params.id), `Rate card updated`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update rate card error:', err);
    res.status(500).json({ error: 'Failed to update rate card.' });
  }
});

// ── DELETE /rate-cards/:id — soft delete (admin only)
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE rate_cards SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rate card not found.' });
    await logAudit(req.user!.id, req.user!.name, 'deactivate', 'rate_card', String(req.params.id), `Rate card deactivated`);
    res.json({ success: true });
  } catch (err) {
    console.error('Deactivate rate card error:', err);
    res.status(500).json({ error: 'Failed to deactivate rate card.' });
  }
});

export default router;
