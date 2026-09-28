import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';
import { notify } from '../services/emailService';

const router = Router();

// GET /finance/review-queue
router.get('/review-queue', authenticate, requireRole('finance', 'admin', 'hod'), async (req, res) => {
  const { period, project_id, department_id } = req.query;
  try {
    let query = `
      SELECT t.id as timesheet_id, p.id as project_id, p.name as project_name, p.code as project_code,
             p.afe_code, d.id as department_id, d.name as department_name, u.id as user_id, u.name as user_name, u.role as user_role,
             SUM(dl.hours) as total_hours,
             COUNT(DISTINCT dl.date) FILTER (WHERE dl.notes IN ('annual_leave','sick_leave')) as leave_days,
             COUNT(DISTINCT dl.date) FILTER (WHERE ph.id IS NOT NULL) as public_holiday_days,
             MAX(fd.decision) as decision, MAX(fd.review_notes) as review_notes,
             MAX(fd.reviewed_at) as reviewed_at, MAX(fd.id) as decision_id
      FROM daily_logs dl
      JOIN timesheets t ON t.user_id=dl.user_id AND t.week_start_date=dl.week_start_date AND t.status='approved'
      JOIN projects p ON dl.project_id=p.id
      JOIN users u ON dl.user_id=u.id
      LEFT JOIN departments d ON p.department_id=d.id
      LEFT JOIN public_holidays ph ON ph.date=dl.date
      LEFT JOIN finance_decisions fd ON fd.timesheet_id=t.id AND fd.user_id=u.id AND fd.project_id=p.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let pc = 0;
    if (period) { pc++; query += ` AND TO_CHAR(dl.date,'YYYY-MM')=$${pc}`; params.push(period); }
    if (project_id) { pc++; query += ` AND p.id=$${pc}`; params.push(project_id); }
    if (department_id) { pc++; query += ` AND p.department_id=$${pc}`; params.push(department_id); }
    query += `
      GROUP BY t.id, p.id, p.name, p.code, d.id, d.name, u.id, u.name
      HAVING SUM(dl.hours) > 0
        OR COUNT(DISTINCT dl.date) FILTER (WHERE dl.notes IN ('annual_leave','sick_leave')) > 0
      ORDER BY p.name ASC, u.name ASC
    `;
    const result = await pool.query(query, params);

    // HODs are scoped to their own department(s) — where they are the HOD, or
    // where the timesheet owner belongs to their department. Rows outside the
    // HOD's department(s) are removed before any money math runs.
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

    // Attach effective-dated cost/charge values per line via fn_rate_for.
    // Grade = user's current role-based grade proxy (user → 'STAFF', managers/HODs → 'MANAGEMENT')
    // until a dedicated grade column exists on users. Missing rate ⇒ null values, shown as '—'.
    const rateCache = new Map<string, { cost: number; charge: number; currency: string } | null>();
    let totalCost = 0, totalCharge = 0, ratedLines = 0;
    for (const row of result.rows) {
      const grade = ['line_manager', 'hod'].includes(String(row.user_role || '')) ? 'MANAGEMENT' : 'STAFF';
      const key = `${grade}|${row.project_id}|${period || 'ALL'}`;
      if (!rateCache.has(key)) {
        const onDate = period ? `${period}-28` : new Date().toISOString().slice(0, 10);
        const r = await pool.query(
          `SELECT cost_rate, charge_rate, currency FROM fn_rate_for($1, $2, $3::date)`,
          [grade, row.project_id, onDate]
        );
        rateCache.set(key, r.rows.length ? { cost: parseFloat(r.rows[0].cost_rate), charge: parseFloat(r.rows[0].charge_rate), currency: r.rows[0].currency } : null);
      }
      const rate = rateCache.get(key);
      if (rate) {
        row.cost_value = Math.round(row.total_hours * rate.cost * 100) / 100;
        row.charge_value = Math.round(row.total_hours * rate.charge * 100) / 100;
        row.rate_currency = rate.currency;
        totalCost += row.cost_value; totalCharge += row.charge_value; ratedLines++;
      } else {
        row.cost_value = null; row.charge_value = null; row.rate_currency = null;
      }
    }

    const totalHours = result.rows.reduce((sum: number, row: any) => sum + parseFloat(row.total_hours || 0), 0);
    res.json({
      rows: result.rows,
      summary: {
        total_hours: totalHours,
        total_cost: Math.round(totalCost * 100) / 100,
        total_charge: Math.round(totalCharge * 100) / 100,
        lines_with_rates: ratedLines,
        lines_total: result.rows.length,
      },
    });
  } catch (err) {
    console.error('Finance review error:', err);
    res.status(500).json({ error: 'Failed to generate finance review queue.' });
  }
});

// GET /finance/review-queue/lines?period=&user_id= — individual daily lines for drill-down
router.get('/review-queue/lines', authenticate, requireRole('finance', 'admin', 'hod'), async (req, res) => {
  const { period, user_id } = req.query;
  if (!period || !user_id) return res.status(400).json({ error: 'period and user_id are required.' });
  try {
    const result = await pool.query(`
      SELECT
        dl.id          AS log_id,
        dl.date,
        TO_CHAR(dl.date, 'YYYY-MM')      AS month,
        dl.hours,
        dl.notes                          AS entry_notes,
        u.id           AS user_id,
        u.name         AS user_name,
        u.role         AS user_role,
        p.id           AS project_id,
        p.name         AS project_name,
        p.code         AS project_code,
        p.afe_code,
        d.name         AS asset_name,
        d.code         AS asset_code,
        COALESCE(dl.activity_name, a.name, '—') AS activity_name,
        COALESCE(a.code, '—')            AS activity_code,
        t.id           AS timesheet_id,
        fd.decision,
        fd.review_notes
      FROM daily_logs dl
      JOIN timesheets t
        ON  t.user_id          = dl.user_id
        AND t.week_start_date  = dl.week_start_date
        AND t.status           = 'approved'
      JOIN projects p  ON dl.project_id = p.id
      JOIN users    u  ON dl.user_id    = u.id
      LEFT JOIN departments d  ON p.department_id = d.id
      LEFT JOIN activities  a  ON dl.activity_id  = a.id
      LEFT JOIN finance_decisions fd
        ON  fd.timesheet_id = t.id
        AND fd.user_id      = u.id
        AND fd.project_id   = p.id
        AND fd.period       = $2
      WHERE dl.user_id = $1
        AND TO_CHAR(dl.date, 'YYYY-MM') = $2
        AND dl.hours > 0
      ORDER BY dl.date ASC, p.name ASC
    `, [user_id, period]);

    // HODs may only drill into their own staff — same scoping rule as the queue.
    if (req.user!.role === 'hod') {
      const hodDepts = await pool.query(
        `SELECT id FROM departments WHERE hod_id = $1
         UNION
         SELECT department_id FROM users WHERE id = $1 AND department_id IS NOT NULL`,
        [req.user!.id]
      );
      const allowed = new Set(hodDepts.rows.map((r: any) => r.id));
      const target = await pool.query('SELECT department_id FROM users WHERE id = $1', [user_id]);
      if (!target.rows.length || !allowed.has(target.rows[0].department_id)) {
        return res.status(403).json({ error: 'You can only view staff in your department.' });
      }
    }

    // Attach effective-dated  cost/charge values per line via fn_rate_for,
    // looked up at each line's own date (same convention as the review queue).
    const rateCache = new Map<string, { cost: number; charge: number; currency: string } | null>();
    for (const row of result.rows) {
      const grade = ['line_manager', 'hod'].includes(String(row.user_role || '')) ? 'MANAGEMENT' : 'STAFF';
      const onDate = row.date ? new Date(row.date).toISOString().slice(0, 10) : `${period}-28`;
      const key = `${grade}|${row.project_id}|${onDate}`;
      if (!rateCache.has(key)) {
        const r = await pool.query(
          `SELECT cost_rate, charge_rate, currency FROM fn_rate_for($1, $2, $3::date)`,
          [grade, row.project_id, onDate]
        );
        rateCache.set(key, r.rows.length ? { cost: parseFloat(r.rows[0].cost_rate), charge: parseFloat(r.rows[0].charge_rate), currency: r.rows[0].currency } : null);
      }
      const rate = rateCache.get(key);
      if (rate) {
        row.cost_value = Math.round(parseFloat(row.hours) * rate.cost * 100) / 100;
        row.charge_value = Math.round(parseFloat(row.hours) * rate.charge * 100) / 100;
        row.rate_currency = rate.currency;
      } else {
        row.cost_value = null; row.charge_value = null; row.rate_currency = null;
      }
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Finance lines error:', err);
    res.status(500).json({ error: 'Failed to fetch review lines.' });
  }
});

// POST /finance/decisions — upsert batch of decisions
router.post('/decisions', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { decisions, period } = req.body;
  if (!decisions || !Array.isArray(decisions) || !period) {
    return res.status(400).json({ error: 'decisions array and period are required.' });
  }
  const user = req.user!;
  for (const d of decisions) {
    if ((d.decision === 'queried' || d.decision === 'rejected') && !d.review_notes?.trim()) {
      return res.status(400).json({ error: `review_notes required when decision is ${d.decision}.` });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const d of decisions) {
      const r = await client.query(`
        INSERT INTO finance_decisions (timesheet_id, user_id, project_id, period, decision, review_notes, reviewed_by, reviewed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (timesheet_id, user_id, project_id, period)
        DO UPDATE SET decision=$5, review_notes=$6, reviewed_by=$7, reviewed_at=NOW(), updated_at=NOW()
        RETURNING *
      `, [d.timesheet_id, d.user_id, d.project_id, period, d.decision, d.review_notes || null, user.id]);
      saved.push(r.rows[0]);
      if (d.decision === 'queried' || d.decision === 'rejected') {
        await notify(d.user_id, 'system',
          `Finance ${d.decision === 'queried' ? 'query' : 'rejection'} on your timesheet`,
          `${user.name} has ${d.decision === 'queried' ? 'queried' : 'rejected'} your timesheet for period ${period}: ${d.review_notes}`);
      }
    }
    await client.query('COMMIT');
    await logAudit(user.id, user.name, 'finance_decisions_committed', 'finance_review', null,
      `Committed ${saved.length} finance decisions for period ${period}`);
    res.json({ saved: saved.length, decisions: saved });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save decisions error:', err);
    res.status(500).json({ error: 'Failed to save decisions.' });
  } finally {
    client.release();
  }
});

// GET /finance/decisions?period=
router.get('/decisions', authenticate, requireRole('finance', 'admin', 'hod'), async (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period is required.' });
  try {
    const result = await pool.query(`
      SELECT fd.*, u.name as employee_name, u.department_id as emp_department_id, p.name as project_name, rv.name as reviewer_name
      FROM finance_decisions fd
      JOIN users u ON fd.user_id=u.id
      JOIN projects p ON fd.project_id=p.id
      LEFT JOIN users rv ON fd.reviewed_by=rv.id
      WHERE fd.period=$1 ORDER BY fd.updated_at DESC
    `, [period]);
    // HODs see decisions for their department's staff only.
    if (req.user!.role === 'hod') {
      const hodDepts = await pool.query(
        `SELECT id FROM departments WHERE hod_id = $1
         UNION
         SELECT department_id FROM users WHERE id = $1 AND department_id IS NOT NULL`,
        [req.user!.id]
      );
      const allowed = new Set(hodDepts.rows.map((r: any) => r.id));
      result.rows = result.rows.filter((r: any) => allowed.has(r.emp_department_id));
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch decisions.' });
  }
});

// GET /finance/decisions/history
router.get('/decisions/history', authenticate, requireRole('finance', 'admin', 'hod'), async (req, res) => {
  const { period, decision, user_id } = req.query;
  try {
    let query = `SELECT fd.*, u.name as employee_name, u.department_id as emp_department_id, p.name as project_name, rv.name as reviewer_name
                 FROM finance_decisions fd
                 JOIN users u ON fd.user_id=u.id JOIN projects p ON fd.project_id=p.id
                 LEFT JOIN users rv ON fd.reviewed_by=rv.id WHERE 1=1`;
    const params: any[] = [];
    let pc = 0;
    if (period) { pc++; query += ` AND fd.period=$${pc}`; params.push(period); }
    if (decision) { pc++; query += ` AND fd.decision=$${pc}`; params.push(decision); }
    if (user_id) { pc++; query += ` AND fd.user_id=$${pc}`; params.push(user_id); }
    query += ' ORDER BY fd.updated_at DESC LIMIT 500';
    const result = await pool.query(query, params);
    // HODs see history for their department's staff only.
    if (req.user!.role === 'hod') {
      const hodDepts = await pool.query(
        `SELECT id FROM departments WHERE hod_id = $1
         UNION
         SELECT department_id FROM users WHERE id = $1 AND department_id IS NOT NULL`,
        [req.user!.id]
      );
      const allowed = new Set(hodDepts.rows.map((r: any) => r.id));
      result.rows = result.rows.filter((r: any) => allowed.has(r.emp_department_id));
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

// GET /finance/review-queue/export — only ok_for_export rows
router.get('/review-queue/export', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { period, department_id } = req.query;
  const user = req.user!;
  try {
    let query = `
      SELECT p.name as project, p.code, u.name as staff, u.role as user_role,
             SUM(dl.hours) as hours,
             COUNT(DISTINCT dl.date) FILTER (WHERE dl.notes IN ('annual_leave','sick_leave')) as leave_days,
             COUNT(DISTINCT dl.date) FILTER (WHERE ph.id IS NOT NULL) as public_holiday_days
      FROM daily_logs dl
      JOIN timesheets t ON t.user_id=dl.user_id AND t.week_start_date=dl.week_start_date AND t.status='approved'
      JOIN projects p ON dl.project_id=p.id
      JOIN users u ON dl.user_id=u.id
      JOIN finance_decisions fd ON fd.timesheet_id=t.id AND fd.user_id=u.id AND fd.project_id=p.id
        AND fd.decision='ok_for_export'
      LEFT JOIN public_holidays ph ON ph.date=dl.date
      WHERE 1=1
    `;
    const params: any[] = [];
    let pc = 0;
    if (period) { pc++; query += ` AND TO_CHAR(dl.date,'YYYY-MM')=$${pc}`; params.push(period); }
    if (department_id) { pc++; query += ` AND p.department_id=$${pc}`; params.push(department_id); }
    query += ` GROUP BY p.name, p.code, u.name HAVING SUM(dl.hours)>0 ORDER BY p.name, u.name`;
    const result = await pool.query(query, params);
    const seqNum = `EXP-${String(period || 'ALL').replace('-','')}-${Date.now()}`;
    await pool.query(
      `INSERT INTO export_runs (sequence_number, period, exported_by, record_count, status) VALUES ($1,$2,$3,$4,'completed')`,
      [seqNum, period || 'all', user.id, result.rows.length]
    );
    if (period) {
      // Scope the decision flip to the same filter the CSV was built with —
      // exporting one department must not mark other departments as exported.
      await pool.query(
        `UPDATE finance_decisions fd SET decision='exported', exported_at=NOW(), exported_by=$1, export_sequence=$2
         WHERE fd.period=$3 AND fd.decision='ok_for_export'
           ${department_id ? 'AND fd.project_id IN (SELECT id FROM projects WHERE department_id=$4)' : ''}`,
        department_id ? [user.id, seqNum, period, department_id] : [user.id, seqNum, period]
      );
    }
    await logAudit(user.id, user.name, 'export_run', 'export_runs', seqNum,
      `Exported ${result.rows.length} rows for period ${period} — sequence ${seqNum}`);

    // Money columns via effective-dated rates (same grading proxy as review queue)
    const rateCache = new Map<string, { cost: number; charge: number; currency: string } | null>();
    let csvRows = [];
    for (const row of result.rows) {
      const grade = ['line_manager', 'hod'].includes(String(row.user_role || '')) ? 'MANAGEMENT' : 'STAFF';
      const key = `${grade}|${row.project}`;
      if (!rateCache.has(key)) {
        const r = await pool.query(
          `SELECT cost_rate, charge_rate, currency FROM fn_rate_for($1, (SELECT id FROM projects WHERE name=$2 LIMIT 1), $3::date)`,
          [grade, row.project, period ? `${period}-28` : new Date().toISOString().slice(0, 10)]
        );
        rateCache.set(key, r.rows.length ? { cost: parseFloat(r.rows[0].cost_rate), charge: parseFloat(r.rows[0].charge_rate), currency: r.rows[0].currency } : null);
      }
      const rate = rateCache.get(key);
      const cost = rate ? Math.round(row.hours * rate.cost * 100) / 100 : '';
      const charge = rate ? Math.round(row.hours * rate.charge * 100) / 100 : '';
      csvRows.push(`"${row.project}","${row.code}","${row.staff}",${row.hours},${row.leave_days||0},${row.public_holiday_days||0},${cost},${charge},${rate ? rate.currency : ''}`);
    }
    const csv = ['Project,Code,Staff,Hours,Leave Days,Public Holiday Days,Cost Value,Charge Value,Currency', ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="approved-time-${period||'all'}-${seqNum}.csv"`);
    res.setHeader('X-Export-Sequence', seqNum);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export.' });
  }
});

// GET /finance/exports
router.get('/exports', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT er.*, u.name as exported_by_name FROM export_runs er
      JOIN users u ON er.exported_by=u.id ORDER BY er.exported_at DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch exports.' });
  }
});

// POST /finance/exports/:sequenceNumber/rerun
router.post('/exports/:sequenceNumber/rerun', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { sequenceNumber } = req.params;
  const user = req.user!;
  try {
    const runRes = await pool.query('SELECT * FROM export_runs WHERE sequence_number=$1', [sequenceNumber]);
    if (runRes.rows.length === 0) return res.status(404).json({ error: 'Export sequence not found.' });
    const run = runRes.rows[0];
    const result = await pool.query(`
      SELECT p.name as project, p.code, u.name as staff,
             SUM(dl.hours) as hours,
             COUNT(DISTINCT dl.date) FILTER (WHERE dl.notes IN ('annual_leave','sick_leave')) as leave_days,
             COUNT(DISTINCT dl.date) FILTER (WHERE ph.id IS NOT NULL) as public_holiday_days
      FROM daily_logs dl
      JOIN timesheets t ON t.user_id=dl.user_id AND t.week_start_date=dl.week_start_date AND t.status='approved'
      JOIN projects p ON dl.project_id=p.id JOIN users u ON dl.user_id=u.id
      JOIN finance_decisions fd ON fd.timesheet_id=t.id AND fd.user_id=u.id
        AND fd.project_id=p.id AND fd.export_sequence=$1
      LEFT JOIN public_holidays ph ON ph.date=dl.date
      GROUP BY p.name, p.code, u.name ORDER BY p.name, u.name
    `, [sequenceNumber]);
    await logAudit(user.id, user.name, 'export_rerun', 'export_runs', String(sequenceNumber),
      `Re-ran export ${sequenceNumber} for period ${run.period}`);
    const csvRows = result.rows.map((row: any) =>
      `"${row.project}","${row.code}","${row.staff}",${row.hours},${row.leave_days||0},${row.public_holiday_days||0},,,`
    );
    const csv = ['Project,Code,Staff,Hours,Leave Days,Public Holiday Days,Cost Value,Charge Value,Currency', ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="rerun-${sequenceNumber}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to re-run export.' });
  }
});

export default router;
