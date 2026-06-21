import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

router.get('/', authenticate, async (_req, res) => {
  try {
    res.json((await pool.query('SELECT * FROM accounting_periods ORDER BY start_date DESC')).rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch periods.' });
  }
});

router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { period_code, start_date, end_date } = req.body;
  if (!period_code || !start_date || !end_date) return res.status(400).json({ error: 'All fields required.' });
  const user = req.user!;
  try {
    const result = await pool.query('INSERT INTO accounting_periods (period_code, start_date, end_date) VALUES ($1,$2,$3) RETURNING *', [period_code, start_date, end_date]);
    await logAudit(user.id, user.name, 'period_created', 'period', result.rows[0].id, `Period ${period_code} created`);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Period code already exists.' });
    res.status(500).json({ error: 'Failed to create period.' });
  }
});

router.patch('/:id/close', authenticate, requireRole('admin'), async (req, res) => {
  const user = req.user!;
  try {
    const result = await pool.query('UPDATE accounting_periods SET is_closed=true WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await logAudit(user.id, user.name, 'period_closed', 'period', String(req.params.id), `Period ${result.rows[0].period_code} closed`);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to close.' });
  }
});

router.patch('/:id/open', authenticate, requireRole('admin'), async (req, res) => {
  const user = req.user!;
  try {
    const result = await pool.query('UPDATE accounting_periods SET is_closed=false WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await logAudit(user.id, user.name, 'period_opened', 'period', String(req.params.id), `Period ${result.rows[0].period_code} re-opened`);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to open.' });
  }
});

export default router;
