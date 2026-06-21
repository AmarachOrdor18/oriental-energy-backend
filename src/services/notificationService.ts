import { pool } from '../db';

export const sendEmail = async (to: string, subject: string, body: string) => {
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}`);
  return { success: true };
};

const toDateKey = (date: Date) => {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
};

const getWeekStart = (date: Date) => {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
};

export async function createFridayOutstandingTimesheetSummaries(today = new Date()) {
  if (today.getDay() !== 5) return { created: 0, skipped: 'not_friday' };
  const weekStartDate = getWeekStart(today);
  const weekStart = toDateKey(weekStartDate);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekEndDate.getDate() + 6);

  const closedPeriod = await pool.query(
    `SELECT period_code FROM accounting_periods WHERE $1::date BETWEEN start_date AND end_date AND is_closed=true`,
    [weekStart]
  );
  if (closedPeriod.rows.length > 0) return { created: 0, skipped: 'closed_period' };

  const outstanding = await pool.query(
    `SELECT u.id, u.name, u.email FROM users u
     LEFT JOIN timesheets t ON t.user_id=u.id AND t.week_start_date=$1
     WHERE u.is_active=true AND u.role IN ('user','line_manager','hod')
       AND (t.id IS NULL OR t.status IN ('draft','rejected','overdue'))
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id=u.id AND n.type='reminder' AND n.week_of=$1::date
       )`,
    [weekStart]
  );

  for (const user of outstanding.rows) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, link, week_of)
       VALUES ($1,'reminder','Weekly timesheet reminder',$2,'/daily-logging',$3::date)`,
      [user.id, `Your timesheet for the week of ${weekStart} is outstanding. Please complete and submit.`, weekStart]
    );
  }
  return { created: outstanding.rows.length, week_start: weekStart };
}

export async function createMonthEndReminders(today = new Date()) {
  if (today.getDate() !== 25) return { created: 0, skipped: 'not_25th' };
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const periodMonth = `${year}-${String(month).padStart(2,'0')}`;

  const openPeriod = await pool.query(
    `SELECT period_code FROM accounting_periods WHERE TO_CHAR(end_date,'YYYY-MM')=$1 AND is_closed=false`,
    [periodMonth]
  );
  if (openPeriod.rows.length === 0) return { created: 0, skipped: 'no_open_period' };
  const periodCode = openPeriod.rows[0].period_code;

  const outstanding = await pool.query(
    `SELECT DISTINCT u.id, u.name FROM users u
     JOIN accounting_periods ap ON TO_CHAR(ap.end_date,'YYYY-MM')=$1 AND ap.is_closed=false
     WHERE u.is_active=true AND u.role IN ('user','line_manager','hod')
       AND EXISTS (
         SELECT 1 FROM timesheets t
         WHERE t.user_id=u.id AND t.accounting_period=ap.period_code
           AND t.status IN ('draft','rejected','overdue')
       )
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id=u.id AND n.title LIKE 'Month-end reminder%'
           AND n.created_at > NOW() - INTERVAL '7 days'
       )`,
    [periodMonth]
  );

  for (const user of outstanding.rows) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, link)
       VALUES ($1,'reminder',$2,$3,'/submissions')`,
      [user.id, `Month-end reminder: ${periodCode}`,
        `Period ${periodCode} closes at month end. You have unsubmitted timesheets. Please submit before the deadline.`]
    );
  }
  return { created: outstanding.rows.length, period: periodCode };
}

export function startNotificationJobs() {
  const run = async () => {
    try {
      const friday = await createFridayOutstandingTimesheetSummaries();
      if (friday.created) console.log(`[NOTIFICATIONS] Friday: ${friday.created} reminders sent.`);
      const monthEnd = await createMonthEndReminders();
      if (monthEnd.created) console.log(`[NOTIFICATIONS] Month-end: ${monthEnd.created} reminders sent.`);
    } catch (err) {
      console.error('[NOTIFICATIONS] Job error:', err);
    }
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}
