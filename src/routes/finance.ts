import { Router } from 'express';
import { pool } from '../db';
import { authenticate, requireRole } from '../middleware/auth';
import { logAudit } from '../utils/audit';

const router = Router();

// GET /finance/review-queue
router.get('/review-queue', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { period, project_id, department_id } = req.query;
  try {
    let query = `
      SELECT t.id as timesheet_id, p.id as project_id, p.name as project_name, p.code as project_code,
             p.afe_code, d.name as department_name, u.id as user_id, u.name as user_name,
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
      GROUP BY t.id, p.id, p.name, p.code, d.name, u.id, u.name
      HAVING SUM(dl.hours) > 0
        OR COUNT(DISTINCT dl.date) FILTER (WHERE dl.notes IN ('annual_leave','sick_leave')) > 0
      ORDER BY p.name ASC, u.name ASC
    `;
    const result = await pool.query(query, params);
    const totalHours = result.rows.reduce((sum: number, row: any) => sum + parseFloat(row.total_hours || 0), 0);
    res.json({ rows: result.rows, summary: { total_hours: totalHours } });
  } catch (err) {
    console.error('Finance review error:', err);
    res.status(500).json({ error: 'Failed to generate finance review queue.' });
  }
});

// GET /finance/review-queue/lines?period=&user_id= — individual daily lines for drill-down
router.get('/review-queue/lines', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { period, user_id } = req.query;
  if (!period || !user_id) return res.status(400).json({ error: 'period and user_id are required.' });
  try {
    const result = await pool.query(`
      SELECT
        dl.id          AS log_id,
        dl.date,
        TO_CHAR(dl.date, 'Month YYYY')   AS month,
        dl.hours,
        dl.notes                          AS entry_notes,
        u.id           AS user_id,
        u.name         AS user_name,
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
        await client.query(`INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'system',$2,$3)`,
          [d.user_id,
           `Finance ${d.decision === 'queried' ? 'query' : 'rejection'} on your timesheet`,
           `${user.name} has ${d.decision === 'queried' ? 'queried' : 'rejected'} your timesheet for period ${period}: ${d.review_notes}`]);
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
router.get('/decisions', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period is required.' });
  try {
    const result = await pool.query(`
      SELECT fd.*, u.name as employee_name, p.name as project_name, rv.name as reviewer_name
      FROM finance_decisions fd
      JOIN users u ON fd.user_id=u.id
      JOIN projects p ON fd.project_id=p.id
      LEFT JOIN users rv ON fd.reviewed_by=rv.id
      WHERE fd.period=$1 ORDER BY fd.updated_at DESC
    `, [period]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch decisions.' });
  }
});

// GET /finance/decisions/history
router.get('/decisions/history', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { period, decision, user_id } = req.query;
  try {
    let query = `SELECT fd.*, u.name as employee_name, p.name as project_name, rv.name as reviewer_name
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
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

// GET /finance/review-queue/export — only ok_for_export rows
router.get('/review-queue/export', authenticate, requireRole('finance', 'admin'), async (req, res) => {
  const { period } = req.query;
  const user = req.user!;
  try {
    let query = `
      SELECT p.name as project, p.code, u.name as staff,
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
    if (period) { query += ` AND TO_CHAR(dl.date,'YYYY-MM')=$1`; params.push(period); }
    query += ` GROUP BY p.name, p.code, u.name HAVING SUM(dl.hours)>0 ORDER BY p.name, u.name`;
    const result = await pool.query(query, params);
    const seqNum = `EXP-${String(period || 'ALL').replace('-','')}-${Date.now()}`;
    await pool.query(
      `INSERT INTO export_runs (sequence_number, period, exported_by, record_count, status) VALUES ($1,$2,$3,$4,'completed')`,
      [seqNum, period || 'all', user.id, result.rows.length]
    );
    if (period) {
      await pool.query(
        `UPDATE finance_decisions SET decision='exported', exported_at=NOW(), exported_by=$1, export_sequence=$2
         WHERE period=$3 AND decision='ok_for_export'`,
        [user.id, seqNum, period]
      );
    }
    await logAudit(user.id, user.name, 'export_run', 'export_runs', seqNum,
      `Exported ${result.rows.length} rows for period ${period} — sequence ${seqNum}`);
    const csvRows = result.rows.map((row: any) =>
      `"${row.project}","${row.code}","${row.staff}",${row.hours},${row.leave_days||0},${row.public_holiday_days||0}`
    );
    const csv = ['Project,Code,Staff,Hours,Leave Days,Public Holiday Days', ...csvRows].join('\n');
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
      `"${row.project}","${row.code}","${row.staff}",${row.hours},${row.leave_days||0},${row.public_holiday_days||0}`
    );
    const csv = ['Project,Code,Staff,Hours,Leave Days,Public Holiday Days', ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="rerun-${sequenceNumber}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to re-run export.' });
  }
});

export default router;
