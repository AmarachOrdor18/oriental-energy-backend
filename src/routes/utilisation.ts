import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole, requirePage } from '../middleware/auth';

const router = Router();

// GET /utilisation
// Capacity per person per month = weekdays in month × min_daily_hours, minus
// public holidays and approved leave days (both already known to the system).
// Logged = daily_logs in the month. Utilisation % = logged / capacity.
// Query: year, month, department_id (optional).
router.get('/', authenticate, requirePage('utilisation'), async (req, res) => {
  const now = new Date();
  const year = parseInt(String(req.query.year || now.getFullYear()), 10);
  const month = parseInt(String(req.query.month || now.getMonth() + 1), 10); // 1-12
  const { department_id } = req.query;

  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Valid year and month are required.' });
  }

  try {
    const standardDay = 8;
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = new Date(year, month, 0).toISOString().slice(0, 10); // last day of month

    // Effective capacity per user in one pass:
    //   weekdays × standardDay  −  holidays on weekdays  −  leave days (approved logs on weekdays)
    // Leave is a daily log whose notes are annual_leave/sick_leave.
    const capacitySql = `
      WITH days AS (
        SELECT d::date AS day
        FROM generate_series($1::date, $2::date, interval '1 day') d
      ),
      workdays AS (
        SELECT day FROM days
        WHERE EXTRACT(ISODOW FROM day) < 6
      ),
      holiday_days AS (
        SELECT ph.date FROM public_holidays ph
        JOIN workdays wd ON wd.day = ph.date
      ),
      leave_days AS (
        SELECT dl.user_id, dl.date
        FROM daily_logs dl
        JOIN workdays wd ON wd.day = dl.date
        WHERE dl.notes IN ('annual_leave','sick_leave')
          AND dl.date BETWEEN $1::date AND $2::date
      )
      SELECT u.id AS user_id, u.name, u.role, u.department_id, d.name AS department_name,
             (SELECT COUNT(*) FROM workdays) * $3::numeric
               - (SELECT COUNT(*) FROM holiday_days) * $3::numeric
               - (SELECT COUNT(*) FROM leave_days ld WHERE ld.user_id = u.id) * $3::numeric
             AS capacity_hours
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE u.is_active = true AND u.role IN ('user','line_manager','hod')
        ${department_id ? 'AND u.department_id = $4' : ''}
    `;
    const capParams: any[] = [monthStart, monthEnd, standardDay];
    if (department_id) capParams.push(department_id);
    const capacityRes = await pool.query(capacitySql, capParams);

    // Logged hours per user in the month (real work only — leave days carry no hours)
    const loggedRes = await pool.query(
      `SELECT user_id, SUM(hours) AS logged_hours
       FROM daily_logs
       WHERE date BETWEEN $1::date AND $2::date AND hours > 0
         AND (notes IS NULL OR notes NOT IN ('annual_leave','sick_leave'))
       GROUP BY user_id`,
      [monthStart, monthEnd]
    );
    const loggedMap = new Map<string, number>();
    loggedRes.rows.forEach((r: any) => loggedMap.set(r.user_id, parseFloat(r.logged_hours || 0)));

    // Project split for the month (which projects consumed the hours)
    const projectRes = await pool.query(
      `SELECT dl.user_id, p.id AS project_id, p.name AS project_name, p.code AS project_code,
              SUM(dl.hours) AS hours
       FROM daily_logs dl
       JOIN projects p ON dl.project_id = p.id
       WHERE dl.date BETWEEN $1::date AND $2::date AND dl.hours > 0
         AND (dl.notes IS NULL OR dl.notes NOT IN ('annual_leave','sick_leave'))
       GROUP BY dl.user_id, p.id, p.name, p.code
       ORDER BY hours DESC`,
      [monthStart, monthEnd]
    );
    const projectMap = new Map<string, any[]>();
    projectRes.rows.forEach((r: any) => {
      const list = projectMap.get(r.user_id) || [];
      list.push({ project_id: r.project_id, project_name: r.project_name, project_code: r.project_code, hours: parseFloat(r.hours) });
      projectMap.set(r.user_id, list);
    });

    const rows = capacityRes.rows.map((r: any) => {
      const capacity = parseFloat(r.capacity_hours || 0);
      const logged = loggedMap.get(r.user_id) || 0;
      const utilisation = capacity > 0 ? Math.round((logged / capacity) * 1000) / 10 : 0;
      return {
        user_id: r.user_id,
        name: r.name,
        role: r.role,
        department_id: r.department_id,
        department_name: r.department_name,
        capacity_hours: capacity,
        logged_hours: logged,
        utilisation_pct: utilisation,
        projects: projectMap.get(r.user_id) || [],
      };
    });

    // Department rollup
    const deptMap = new Map<string, any>();
    rows.forEach((r) => {
      if (!r.department_id) return;
      const d = deptMap.get(r.department_id) || {
        department_id: r.department_id,
        department_name: r.department_name,
        capacity_hours: 0,
        logged_hours: 0,
        headcount: 0,
      };
      d.capacity_hours += r.capacity_hours;
      d.logged_hours += r.logged_hours;
      d.headcount += 1;
      deptMap.set(r.department_id, d);
    });
    const departments = Array.from(deptMap.values()).map((d: any) => ({
      ...d,
      utilisation_pct: d.capacity_hours > 0 ? Math.round((d.logged_hours / d.capacity_hours) * 1000) / 10 : 0,
    }));

    res.json({
      year, month,
      standard_day_hours: standardDay,
      rows, departments,
    });
  } catch (err) {
    console.error('Utilisation error:', err);
    res.status(500).json({ error: 'Failed to compute utilisation.' });
  }
});

export default router;
