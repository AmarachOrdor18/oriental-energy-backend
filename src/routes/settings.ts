import { Router } from 'express';
import { pool } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

// GET /settings/system — any signed-in user; the Daily Logging calendar reads
// go_live_date from here to know when attendance tracking began.
router.get('/system', authenticate, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM system_settings WHERE key = ANY($1)`,
      [['go_live_date', 'min_daily_hours', 'hour_enforcement_mode']]
    );
    const settings: Record<string, string> = {};
    result.rows.forEach((row: any) => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error('GET /settings/system error:', err);
    res.status(500).json({ error: 'Failed to fetch system settings.' });
  }
});

export default router;
