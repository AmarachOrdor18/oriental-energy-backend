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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // New periods start open — close any currently open period first so only
    // one accounting period is ever open at a time.
    await client.query('UPDATE accounting_periods SET is_closed=true WHERE is_closed=false');
    const result = await client.query('INSERT INTO accounting_periods (period_code, start_date, end_date) VALUES ($1,$2,$3) RETURNING *', [period_code, start_date, end_date]);
    await client.query('COMMIT');
    await logAudit(user.id, user.name, 'period_created', 'period', result.rows[0].id, `Period ${period_code} created (single-open enforced)`);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Period code already exists.' });
    res.status(500).json({ error: 'Failed to create period.' });
  } finally {
    client.release();
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Enforce a single open period: close every other open period first.
    await client.query('UPDATE accounting_periods SET is_closed=true WHERE is_closed=false AND id != $1', [req.params.id]);
    const result = await client.query('UPDATE accounting_periods SET is_closed=false WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found.' });
    }
    const others = await client.query('SELECT period_code FROM accounting_periods WHERE is_closed=false AND id != $1', [req.params.id]);
    await client.query('COMMIT');
    await logAudit(user.id, user.name, 'period_opened', 'period', String(req.params.id),
      `Period ${result.rows[0].period_code} opened${others.rows.length ? ` — ${others.rows.length} other period(s) auto-closed` : ''}`);
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to open.' });
  } finally {
    client.release();
  }
});

export default router;
