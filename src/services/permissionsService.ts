// Page-level access control: the catalog of guardable pages, each role's
// defaults, and the resolver that combines role defaults with admin-set
// per-user overrides. Deny wins over allow, allow wins over the role default;
// admins always pass (safety net so an admin can never lock themselves out).
import { pool } from '../db';

export type Effect = 'allow' | 'deny';

export interface PageDef {
  key: string;
  label: string;
  description: string;
  roles: string[]; // role defaults
}

export const PAGES: PageDef[] = [
  { key: 'dashboard',     label: 'Dashboard',       description: 'Personal overview of hours and pending items', roles: ['user', 'line_manager', 'hod', 'finance', 'admin'] },
  { key: 'daily-logging', label: 'Daily Logging',   description: 'The calendar for logging and planning leave',   roles: ['user', 'line_manager', 'hod', 'admin'] },
  { key: 'submissions',   label: 'Submissions',     description: 'Own weekly timesheets and their statuses',     roles: ['user', 'line_manager', 'hod', 'admin'] },
  { key: 'approvals',     label: 'Review Queue',    description: 'Approve or return team timesheets',            roles: ['line_manager', 'hod', 'admin'] },
  { key: 'team',          label: 'Team Members',    description: 'Team roster with logging health',              roles: ['line_manager', 'hod', 'admin'] },
  { key: 'finance',       label: 'Finance Review',  description: 'Costed review queue and SUN export',           roles: ['finance', 'hod', 'admin'] },
  { key: 'reports',       label: 'Reports',         description: 'Hours summaries and not-posted reports',       roles: ['finance', 'admin', 'line_manager', 'hod'] },
  { key: 'utilisation',   label: 'Utilisation',     description: 'Capacity versus logged hours, by dept/person', roles: ['finance', 'admin', 'line_manager', 'hod'] },
  { key: 'budgets',       label: 'Budgets',         description: 'Budgeted hours versus actual burn',            roles: ['finance', 'hod', 'admin'] },
  { key: 'rate-cards',    label: 'Rate Cards',      description: 'Cost and charge rates per grade and project',  roles: ['admin'] },
  { key: 'admin',         label: 'Administration',  description: 'Users, periods, holidays, settings, audit',    roles: ['admin'] },
];

export const PAGE_KEYS = PAGES.map((p) => p.key);

const PAGE_KEYS_SET = new Set(PAGE_KEYS);

export function roleDefaults(role: string): string[] {
  if (role === 'admin') return [...PAGE_KEYS];
  return PAGES.filter((p) => p.roles.includes(role)).map((p) => p.key);
}

/**
 * Effective page permissions for a user: role defaults, overridden by explicit
 * per-user rows. deny > allow > role default. Admins always get everything.
 */
export async function effectivePermissions(userId: string, role: string): Promise<string[]> {
  if (role === 'admin') return [...PAGE_KEYS];

  const base = new Set(roleDefaults(role));

  const result = await pool.query(
    'SELECT page_key, effect FROM user_page_permissions WHERE user_id = $1',
    [userId]
  );
  for (const row of result.rows) {
    if (!PAGE_KEYS_SET.has(row.page_key)) continue; // ignore unknown keys
    if (row.effect === 'deny') base.delete(row.page_key);
    else base.add(row.page_key);
  }
  return PAGE_KEYS.filter((k) => base.has(k));
}
