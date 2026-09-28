import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { PAGES, roleDefaults, effectivePermissions, PAGE_KEYS } from '../services/permissionsService';

const router = Router();

// Express 5 types allow string[] in route params; coerce to a single string.
const param = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';

/**
 * GET /permissions/pages
 * The page catalog plus each role's defaults — what the admin UI renders.
 */
router.get('/pages', authenticate, requireRole('admin'), (req, res) => {
  res.json({
    pages: PAGES,
    roleDefaults: Object.fromEntries(
      ['user', 'line_manager', 'hod', 'finance', 'admin'].map((r) => [r, roleDefaults(r)])
    ),
  });
});

/**
 * GET /permissions/users/:id
 * One user's effective permissions with their explicit overrides spelled out,
 * so the admin sees the base defaults AND what they've changed.
 */
router.get('/users/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const user = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [req.params.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const overrides = await pool.query(
      'SELECT page_key, effect, created_at FROM user_page_permissions WHERE user_id = $1 ORDER BY page_key',
      [param(req.params.id)]
    );
    const effective = await effectivePermissions(param(req.params.id), user.rows[0].role);

    res.json({
      user: user.rows[0],
      roleDefaults: roleDefaults(user.rows[0].role),
      overrides: overrides.rows,
      effective,
      catalog: PAGES,
    });
  } catch (err) {
    console.error('Get user permissions error:', err);
    res.status(500).json({ error: 'Failed to load permissions.' });
  }
});

/**
 * PUT /permissions/users/:id/:pageKey  { effect: 'allow' | 'deny' | 'inherit' }
 * 'inherit' removes the override so the role default applies again.
 */
router.put('/users/:id/:pageKey', authenticate, requireRole('admin'), async (req, res) => {
  const { effect } = req.body || {};
  const id = param(req.params.id);
  const pageKey = param(req.params.pageKey);

  if (!PAGE_KEYS.includes(pageKey)) {
    return res.status(400).json({ error: 'Unknown page key.' });
  }
  if (!['allow', 'deny', 'inherit'].includes(effect)) {
    return res.status(400).json({ error: "effect must be 'allow', 'deny' or 'inherit'." });
  }

  try {
    const target = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    if (target.rows[0].role === 'admin') {
      return res.status(400).json({ error: 'Admins always have full access; their permissions cannot be restricted.' });
    }

    if (effect === 'inherit') {
      await pool.query('DELETE FROM user_page_permissions WHERE user_id = $1 AND page_key = $2', [id, pageKey]);
    } else {
      await pool.query(
        `INSERT INTO user_page_permissions (user_id, page_key, effect, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, page_key) DO UPDATE SET effect = EXCLUDED.effect, granted_by = EXCLUDED.granted_by, created_at = NOW()`,
        [id, pageKey, effect, req.user!.id]
      );
    }

    const effective = await effectivePermissions(id, target.rows[0].role);
    res.json({ ok: true, effective });
  } catch (err: any) {
    if (err.code === '23503') {
      return res.status(404).json({ error: 'User not found.' });
    }
    console.error('Set permission error:', err);
    res.status(500).json({ error: 'Failed to update permission.' });
  }
});

export default router;
