import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

// GET /holidays
router.get('/', authenticate, async (req, res) => {
  const { year } = req.query;
  try {
    let query = 'SELECT * FROM public_holidays';
    const params: any[] = [];
    if (year) { query += ' WHERE year = $1'; params.push(year); }
    query += ' ORDER BY date ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch holidays.' });
  }
});

// POST /holidays
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { name, date, year } = req.body;
  if (!name || !date || !year) return res.status(400).json({ error: 'name, date, and year are required.' });
  try {
    const result = await pool.query(
      'INSERT INTO public_holidays (name, date, year) VALUES ($1, $2, $3) RETURNING *',
      [name, date, year]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create holiday.' });
  }
});

// DELETE /holidays/:id
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM public_holidays WHERE id = $1', [req.params.id]);
    res.json({ message: 'Holiday deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete holiday.' });
  }
});

export default router;
