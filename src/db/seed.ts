import { pool } from './index';
import bcrypt from 'bcryptjs';

const DEPARTMENTS = [
  { name: 'Engineering', code: 'ENG' },
  { name: 'Operations', code: 'OPS' },
  { name: 'Finance & Accounting', code: 'FIN' },
  { name: 'Human Resources', code: 'HR' },
  { name: 'Health Safety & Environment', code: 'HSE' },
  { name: 'Executive Management', code: 'EXEC' },
  { name: 'Information Technology', code: 'IT' },
  { name: 'Drilling', code: 'DRL' },
];

const PROJECTS = [
  { name: 'Rig Maintenance 2026', code: 'RIG-26', dept: 'ENG', maxH: 40 },
  { name: 'Pipeline Inspection', code: 'PIPE-INSP', dept: 'ENG', maxH: 20 },
  { name: 'Wellhead Monitoring', code: 'WH-MON', dept: 'ENG', maxH: 30 },
  { name: 'Fleet Management', code: 'FLEET-OPS', dept: 'OPS', maxH: 40 },
  { name: 'Logistics Planning', code: 'LOG-PLN', dept: 'OPS', maxH: 25 },
  { name: 'HQ Renovation', code: 'HQ-REN', dept: 'EXEC', maxH: 10 },
  { name: 'Cybersecurity Upgrade', code: 'CYBER-UPG', dept: 'IT', maxH: 40 },
  { name: 'Network Infrastructure', code: 'NET-INF', dept: 'IT', maxH: 30 },
  { name: 'Annual Audit', code: 'FIN-AUD', dept: 'FIN', maxH: 20 },
  { name: 'Budget Planning FY27', code: 'BUD-27', dept: 'FIN', maxH: 15 },
  { name: 'Staff Training Programme', code: 'HR-TRN', dept: 'HR', maxH: 20 },
  { name: 'Recruitment Drive Q3', code: 'HR-REC', dept: 'HR', maxH: 15 },
  { name: 'Safety Compliance Review', code: 'HSE-REV', dept: 'HSE', maxH: 30 },
  { name: 'Offshore Drilling Phase 2', code: 'DRL-P2', dept: 'DRL', maxH: 45 },
  { name: 'Exploratory Well Site C', code: 'DRL-EXP', dept: 'DRL', maxH: 40 },
];

const FIRST_NAMES = ['Adaeze','Chinedu','Emeka','Ngozi','Obinna','Ifeoma','Tunde','Yemi','Funke','Bola','Chisom','Uche','Kelechi','Amara','Ikenna','Chidinma','Eze','Oluchi','Nkem','Tobi','Segun','Aisha','Ibrahim','Fatima','Hassan','Musa','Grace','Peter','David','Samuel','Blessing','Joy','Faith','Hope','Mercy','Victor','Michael','Daniel','Joseph','Benjamin','Emmanuel','Christopher','Stephen','Philip','Andrew','Simon','James','John','Paul','Luke'];
const LAST_NAMES = ['Okafor','Adeyemi','Nwachukwu','Obi','Eze','Igwe','Nwosu','Chukwu','Okoro','Nnadi','Uzoma','Agu','Anyanwu','Okeke','Udeh','Afolabi','Adeniyi','Bakare','Ogunleye','Akinwale','Bello','Sanni','Mohammed','Abdullahi','Yusuf','Okonkwo','Amadi','Ibe','Onyema','Ogbu'];

function randomFrom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function generateEmail(first: string, last: string, idx: number): string {
  return `${first.toLowerCase().charAt(0)}.${last.toLowerCase()}${idx > 0 ? idx : ''}@oriental-er.com`;
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('🗑️  Cleaning existing data...');
    await client.query('TRUNCATE notifications, daily_logs, timesheet_entries, timesheets, public_holidays, accounting_periods, projects, users, departments CASCADE');
    // Reset sequences
    await client.query(`
      ALTER SEQUENCE dept_id_seq RESTART WITH 1;
      ALTER SEQUENCE user_id_seq RESTART WITH 1;
      ALTER SEQUENCE project_id_seq RESTART WITH 1;
      ALTER SEQUENCE timesheet_id_seq RESTART WITH 1;
      ALTER SEQUENCE entry_id_seq RESTART WITH 1;
      ALTER SEQUENCE holiday_id_seq RESTART WITH 1;
      ALTER SEQUENCE period_id_seq RESTART WITH 1;
      ALTER SEQUENCE daily_log_id_seq RESTART WITH 1;
      ALTER SEQUENCE notification_id_seq RESTART WITH 1;
    `);

    // 1. Departments
    console.log('🏢 Creating departments...');
    const deptMap: Record<string, string> = {};
    for (const dept of DEPARTMENTS) {
      const r = await client.query('INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id', [dept.name, dept.code]);
      deptMap[dept.code] = r.rows[0].id;
    }

    // 2. Users — Admin, HoDs, Line Managers, Staff
    console.log('👥 Creating ~200 users...');
    const hashedPw = await bcrypt.hash('password123', 10);
    const allUsers: any[] = [];

    // Admin
    const adminRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role, department_id, can_create_projects)
       VALUES ('Amarachi Ordor', 'a.ordor@oriental-er.com', $1, 'admin', $2, true) RETURNING *`,
      [hashedPw, deptMap['EXEC']]
    );
    allUsers.push(adminRes.rows[0]);

    // HoDs (one per department except EXEC)
    const hodMap: Record<string, any> = {};
    const hodDepts = DEPARTMENTS.filter(d => d.code !== 'EXEC');
    for (const dept of hodDepts) {
      const fn = randomFrom(FIRST_NAMES);
      const ln = randomFrom(LAST_NAMES);
      const r = await client.query(
        `INSERT INTO users (name, email, password_hash, role, department_id, can_create_projects)
         VALUES ($1, $2, $3, 'hod', $4, true) RETURNING *`,
        [`${fn} ${ln}`, generateEmail(fn, ln, 0), hashedPw, deptMap[dept.code]]
      );
      hodMap[dept.code] = r.rows[0];
      allUsers.push(r.rows[0]);
      await client.query('UPDATE departments SET hod_id = $1 WHERE id = $2', [r.rows[0].id, deptMap[dept.code]]);
    }

    // Line Managers (2-3 per department)
    const lmMap: Record<string, any[]> = {};
    for (const dept of hodDepts) {
      lmMap[dept.code] = [];
      const lmCount = dept.code === 'DRL' || dept.code === 'ENG' ? 3 : 2;
      for (let i = 0; i < lmCount; i++) {
        const fn = randomFrom(FIRST_NAMES);
        const ln = randomFrom(LAST_NAMES);
        const r = await client.query(
          `INSERT INTO users (name, email, password_hash, role, department_id, manager_id, can_create_projects)
           VALUES ($1, $2, $3, 'line_manager', $4, $5, true) RETURNING *`,
          [`${fn} ${ln}`, generateEmail(fn, ln, allUsers.length), hashedPw, deptMap[dept.code], hodMap[dept.code].id]
        );
        lmMap[dept.code].push(r.rows[0]);
        allUsers.push(r.rows[0]);
      }
    }

    // Finance user
    const finRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role, department_id, manager_id)
       VALUES ('James Finance', 'j.finance@oriental-er.com', $1, 'finance', $2, $3) RETURNING *`,
      [hashedPw, deptMap['FIN'], hodMap['FIN'].id]
    );
    allUsers.push(finRes.rows[0]);

    // Staff — fill to ~200 total
    const targetTotal = 200;
    const staffPerDept = Math.ceil((targetTotal - allUsers.length) / hodDepts.length);
    const usedEmails = new Set(allUsers.map((u: any) => u.email));

    for (const dept of hodDepts) {
      const managers = lmMap[dept.code];
      for (let i = 0; i < staffPerDept; i++) {
        const fn = randomFrom(FIRST_NAMES);
        const ln = randomFrom(LAST_NAMES);
        let email = generateEmail(fn, ln, 0);
        let suffix = 1;
        while (usedEmails.has(email)) { email = generateEmail(fn, ln, suffix++); }
        usedEmails.add(email);

        const manager = managers[i % managers.length];
        const r = await client.query(
          `INSERT INTO users (name, email, password_hash, role, department_id, manager_id)
           VALUES ($1, $2, $3, 'user', $4, $5) RETURNING *`,
          [`${fn} ${ln}`, email, hashedPw, deptMap[dept.code], manager.id]
        );
        allUsers.push(r.rows[0]);
        if (allUsers.length >= targetTotal) break;
      }
      if (allUsers.length >= targetTotal) break;
    }

    console.log(`   ✅ Created ${allUsers.length} users`);

    // 3. Projects
    console.log('📋 Creating projects...');
    const projectMap: Record<string, string> = {};
    for (const proj of PROJECTS) {
      const creator = hodMap[proj.dept] || allUsers[0];
      const r = await client.query(
        `INSERT INTO projects (name, code, max_hours_per_week, department_id, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [proj.name, proj.code, proj.maxH, deptMap[proj.dept], creator.id]
      );
      projectMap[proj.code] = r.rows[0].id;
    }

    // 4. Accounting Periods
    console.log('📅 Creating accounting periods...');
    for (let m = 1; m <= 12; m++) {
      const code = `2026-${String(m).padStart(2, '0')}`;
      const start = `2026-${String(m).padStart(2, '0')}-01`;
      const end = new Date(2026, m, 0).toISOString().split('T')[0];
      await client.query(
        'INSERT INTO accounting_periods (period_code, start_date, end_date, is_closed) VALUES ($1, $2, $3, $4)',
        [code, start, end, m < 5] // Jan-Apr closed
      );
    }

    // 5. Public Holidays 2026
    console.log('🎉 Creating public holidays...');
    const holidays = [
      { name: "New Year's Day", date: '2026-01-01' },
      { name: 'Workers Day', date: '2026-05-01' },
      { name: 'Democracy Day', date: '2026-06-12' },
      { name: 'Independence Day', date: '2026-10-01' },
      { name: 'Christmas Day', date: '2026-12-25' },
      { name: 'Boxing Day', date: '2026-12-26' },
    ];
    for (const h of holidays) {
      await client.query('INSERT INTO public_holidays (name, date, year) VALUES ($1, $2, 2026)', [h.name, h.date]);
    }

    // 6. Sample daily logs and timesheets for recent weeks
    console.log('📝 Creating sample timesheets & daily logs...');
    const projectCodes = Object.keys(projectMap);
    const sampleUsers = allUsers.filter((u: any) => u.role === 'user').slice(0, 30);

    for (const user of sampleUsers) {
      // Get 2 projects from user's department
      const deptCode = DEPARTMENTS.find(d => deptMap[d.code] === user.department_id)?.code || 'ENG';
      const deptProjects = PROJECTS.filter(p => p.dept === deptCode).slice(0, 2);
      if (deptProjects.length === 0) continue;

      // Create timesheets for last 3 weeks
      const weeks = [
        { start: '2026-05-04', end: '2026-05-10', period: '2026-05', status: 'approved' },
        { start: '2026-05-11', end: '2026-05-17', period: '2026-05', status: 'submitted' },
        { start: '2026-05-18', end: '2026-05-24', period: '2026-05', status: 'draft' },
      ];

      for (const week of weeks) {
        const tsRes = await client.query(
          `INSERT INTO timesheets (user_id, week_start_date, week_end_date, accounting_period, status, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [user.id, week.start, week.end, week.period, week.status, week.status !== 'draft' ? new Date() : null]
        );

        // Create daily logs for weekdays
        for (let dayOff = 0; dayOff < 5; dayOff++) {
          const d = new Date(week.start);
          d.setDate(d.getDate() + dayOff);
          const dateStr = d.toISOString().split('T')[0];

          for (const proj of deptProjects) {
            const hours = Math.floor(Math.random() * 5) + 2; // 2-6 hours
            await client.query(
              `INSERT INTO daily_logs (user_id, project_id, date, hours, week_start_date, is_filled)
               VALUES ($1, $2, $3, $4, $5, true)
               ON CONFLICT (user_id, project_id, date) DO NOTHING`,
              [user.id, projectMap[proj.code], dateStr, hours, week.start]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    console.log(`\n✅ Database seeded successfully!`);
    console.log(`   👥 ${allUsers.length} users across ${DEPARTMENTS.length} departments`);
    console.log(`   📋 ${PROJECTS.length} projects`);
    console.log(`   📅 12 accounting periods`);
    console.log(`   🎉 ${holidays.length} public holidays`);
    console.log(`\n🔑 Login credentials:`);
    console.log(`   Admin:   a.ordor@oriental-er.com / password123`);
    console.log(`   Finance: j.finance@oriental-er.com / password123`);
    console.log(`   All other users: [email] / password123`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed error:', err);
  } finally {
    client.release();
    process.exit();
  }
}

seed();
