import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole, requirePage } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

// GET /budgets?year=&department_id= — all projects with budget vs actual for the year
router.get('/', authenticate, requirePage('budgets'), async (req, res) => {
  const year = parseInt(String(req.query.year || new Date().getFullYear()), 10);
  const { department_id } = req.query;
  try {
    const result = await pool.query(
      `SELECT p.id AS project_id, p.name AS project_name, p.code AS project_code, p.is_active,
              COALESCE(pb.budgeted_hours, 0) AS budgeted_hours,
              COALESCE(pb.budgeted_cost, 0)  AS budgeted_cost,
              COALESCE(actual.logged_hours, 0) AS logged_hours,
              p.department_id AS department_id,
              d.name AS department_name
       FROM projects p
       LEFT JOIN project_budgets pb ON pb.project_id = p.id AND pb.year = $1
       LEFT JOIN (
         SELECT dl.project_id, SUM(dl.hours) AS logged_hours
         FROM daily_logs dl
         WHERE dl.date >= $2::date AND dl.date < ($2::date + interval '1 year')
           AND dl.hours > 0 AND (dl.notes IS NULL OR dl.notes NOT IN ('annual_leave','sick_leave'))
         GROUP BY dl.project_id
       ) actual ON actual.project_id = p.id
       LEFT JOIN departments d ON p.department_id = d.id
       WHERE p.is_active = true
         ${department_id ? 'AND p.department_id = $3' : ''}
       ORDER BY p.name ASC`,
      department_id ? [year, `${year}-01-01`, department_id] : [year, `${year}-01-01`]
    );

    // HODs are scoped to their own department(s) — same rule as Finance.
    if (req.user!.role === 'hod') {
      const hodDepts = await pool.query(
        `SELECT id FROM departments WHERE hod_id = $1
         UNION
         SELECT department_id FROM users WHERE id = $1 AND department_id IS NOT NULL`,
        [req.user!.id]
      );
      const allowed = new Set(hodDepts.rows.map((r: any) => r.id));
      result.rows = result.rows.filter((r: any) => allowed.has(r.department_id));
    }

    const rows = result.rows.map((r: any) => {
      const budgeted = parseFloat(r.budgeted_hours || 0);
      const logged = parseFloat(r.logged_hours || 0);
      const burn = budgeted > 0 ? Math.round((logged / budgeted) * 1000) / 10 : null;
      return {
        ...r,
        budgeted_hours: budgeted,
        budgeted_cost: r.budgeted_cost ? parseFloat(r.budgeted_cost) : null,
        logged_hours: logged,
        remaining_hours: Math.round((budgeted - logged) * 100) / 100,
        burn_pct: burn,
        status: burn == null ? 'no_budget' : burn >= 100 ? 'over' : burn >= 85 ? 'watch' : 'healthy',
      };
    });

    // Per-department burn rollup — budgeted/logged hours (and cost where budgeted)
    // aggregated by the project's owning department, with the weakest status winning.
    const rank: Record<string, number> = { over: 3, watch: 2, healthy: 1, no_budget: 0 };
    const deptMap: Record<string, any> = {};
    for (const r of rows) {
      const key = r.department_name || 'Unassigned';
      if (!deptMap[key]) deptMap[key] = { department_id: r.department_id, department_name: key, projects: 0, budgeted_hours: 0, logged_hours: 0, budgeted_cost: 0, has_cost_budget: false, statuses: [] as string[] };
      const g = deptMap[key];
      g.projects += 1;
      g.budgeted_hours += r.budgeted_hours || 0;
      g.logged_hours += r.logged_hours || 0;
      if (r.budgeted_cost != null) { g.budgeted_cost += r.budgeted_cost; g.has_cost_budget = true; }
      if (r.status !== 'no_budget') g.statuses.push(r.status);
    }
    const departments = Object.values(deptMap).map((g: any) => {
      const burn = g.budgeted_hours > 0 ? Math.round((g.logged_hours / g.budgeted_hours) * 1000) / 10 : null;
      return {
        department_id: g.department_id,
        department_name: g.department_name,
        projects: g.projects,
        budgeted_hours: Math.round(g.budgeted_hours * 100) / 100,
        logged_hours: Math.round(g.logged_hours * 100) / 100,
        remaining_hours: Math.round((g.budgeted_hours - g.logged_hours) * 100) / 100,
        burn_pct: burn,
        budgeted_cost: g.has_cost_budget ? Math.round(g.budgeted_cost * 100) / 100 : null,
        status: burn == null ? 'no_budget' : burn >= 100 ? 'over' : burn >= 85 ? 'watch' : 'healthy',
        project_over: g.statuses.filter((s: string) => s === 'over').length,
        project_watch: g.statuses.filter((s: string) => s === 'watch').length,
      };
    }).sort((a: any, b: any) => (rank[b.status] || 0) - (rank[a.status] || 0) || b.burn_pct - a.burn_pct);

    res.json({ year, rows, departments });
  } catch (err) {
    console.error('Budgets error:', err);
    res.status(500).json({ error: 'Failed to fetch budgets.' });
  }
});

// PUT /budgets/:projectId — set/replace the year's budget (admin only)
router.put('/:projectId', authenticate, requireRole('admin'), async (req, res) => {
  const { year, budgeted_hours, budgeted_cost } = req.body;
  if (!year || budgeted_hours == null) {
    return res.status(400).json({ error: 'year and budgeted_hours are required.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO project_budgets (project_id, year, budgeted_hours, budgeted_cost, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id, year)
       DO UPDATE SET budgeted_hours=$3, budgeted_cost=$4, created_by=$5
       RETURNING *`,
      [req.params.projectId, year, budgeted_hours, budgeted_cost ?? null, req.user!.id]
    );
    await logAudit(req.user!.id, req.user!.name, 'set_budget', 'project_budgets', result.rows[0].id,
      `Budget set for project ${req.params.projectId}, year ${year}: ${budgeted_hours}h`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Set budget error:', err);
    res.status(500).json({ error: 'Failed to set budget.' });
  }
});

export default router;
