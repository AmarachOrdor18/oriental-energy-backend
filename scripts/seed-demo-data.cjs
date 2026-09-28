// Seed demo data for the eight demo accounts through the app's own API.
// Days 21-25 Sept get 8h logs; weeks of 14th and 21st get timesheets; the
// 21st week is submitted (so HOD/finance queues have rows) except Chisom
// Adeyemi's, which stays draft so she can demo the submit action live.
// Re-runnable: it checks for existing data before writing.
"use strict";
const http = require("http");

const BASE = "http://localhost:3000/api/v1";
const PASSWORD = "password123";
const WEEK3 = { start: "2026-09-14", end: "2026-09-18" }; // already approved era
const WEEK4 = { start: "2026-09-21", end: "2026-09-25" }; // the live week
const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];

// [email, role, department, project pool]
const CAST = [
  { email: "c.adeyemi@oriental-er.com",    projects: ["PRJ-000007", "PRJ-000013"], submitWeek4: false, label: "Chisom Adeyemi (Eng user)" },
  { email: "c.onyema8@oriental-er.com",    projects: ["PRJ-000007", "PRJ-000013"], submitWeek4: true,  label: "Chidinma Onyema (Eng LM)" },
  { email: "f.chukwu@oriental-er.com",     projects: ["PRJ-000013", "PRJ-000010"], submitWeek4: true,  label: "Funke Chukwu (Eng HOD)" },
  { email: "a.ordor@oriental-er.com",      projects: ["PRJ-000010", "PRJ-000006"], submitWeek4: true,  label: "Amarachi Ordor (admin)" },
  { email: "j.finance@oriental-er.com",    projects: ["PRJ-000009", "PRJ-000010"], submitWeek4: true,  label: "James Finance" },
  { email: "c.okafor@oriental-er.com",     projects: ["PRJ-000004", "PRJ-000015"], submitWeek4: true,  label: "Chisom Okafor (Ops HOD)" },
  { email: "c.chukwu12@oriental-er.com",   projects: ["PRJ-000004", "PRJ-000015"], submitWeek4: true,  label: "Christopher Chukwu (Ops LM)" },
  { email: "c.okoro@oriental-er.com",      projects: ["PRJ-000004", "PRJ-000011"], submitWeek4: false, label: "Christopher Okoro (Ops user)" },
];

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on("error", reject);
    r.setTimeout(15000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}

const login = async (email) => {
  const r = await req("POST", "/auth/login", null, { email, password: PASSWORD });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
};

(async () => {
  for (const person of CAST) {
    try {
      const token = await login(person.email);
      const me = await req("GET", "/auth/me", token);
      const userId = me.json?.id;

      // 1) Daily logs for the demo week (8h/day, split across two projects Fri)
      for (const [i, day] of DAYS.entries()) {
        const entries = i === 4
          ? [{ project_id: person.projects[0], hours: 5 }, { project_id: person.projects[1], hours: 3 }]
          : [{ project_id: person.projects[0], hours: 8 }];
        const existing = await req("GET", `/daily-logs?week_start=${WEEK4.start}`, token);
        const already = (Array.isArray(existing.json) ? existing.json : []).some(
          (l) => (l.date || "").startsWith(day) && l.user_id === userId
        );
        if (!already) {
          const saved = await req("POST", "/daily-logs/day", token, {
            date: day, week_start_date: WEEK4.start, entries, notes: "Demo week",
          });
          if (saved.status >= 300) console.log(`  ! log ${day} -> ${saved.status} ${JSON.stringify(saved.json).slice(0, 90)}`);
        }
      }

      // 2) Find or create the week-4 timesheet, then submit if wanted
      const tsRes = await req("GET", `/timesheets`, token);
      const sheets = Array.isArray(tsRes.json) ? tsRes.json : (tsRes.json?.timesheets || tsRes.json?.data || []);
      let week4 = sheets.find((t) => (t.week_start_date || "").startsWith(WEEK4.start));
      if (!week4) {
        const created = await req("POST", `/timesheets`, token, {
          week_start_date: WEEK4.start, week_end_date: WEEK4.end, accounting_period: "2026-09",
        });
        week4 = created.json;
      }
      if (week4 && person.submitWeek4 && week4.status === "draft") {
        const sub = await req("PATCH", `/timesheets/${week4.id}/submit`, token, {});
        console.log(`  submit ${week4.id} -> ${sub.status} ${(sub.json?.error || "").slice(0, 80)}`);
      }
      console.log(`ok: ${person.label} (timesheet ${week4 ? week4.id + " " + week4.status : "n/a"})`);
    } catch (e) {
      console.log(`FAIL ${person.label}: ${e.message}`);
    }
  }
})();
