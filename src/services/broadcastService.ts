import { pool } from '../db';

export interface BroadcastPayload {
  senderId: string;
  senderName: string;
  role: string;
  departmentId?: string | null;
  message: string;
  defaultersOnly: boolean;
}

// Resolve the audience for a sender. line_manager -> direct reports;
// hod/admin -> their department (admin: their own department scope, matching
// the existing manual broadcast behaviour).
export async function resolveAudience(sender: { id: string; role: string; department_id?: string | null }): Promise<string[]> {
  const isLineManager = sender.role === 'line_manager';
  const col = isLineManager ? 'manager_id' : 'department_id';
  const scope = isLineManager ? sender.id : sender.department_id;
  if (!scope) return [];
  const result = await pool.query(
    `SELECT id FROM users WHERE ${col} = $1 AND is_active = true`,
    [scope]
  );
  return result.rows.map((r: any) => r.id);
}

export async function resolveDefaulters(sender: { id: string; role: string; department_id?: string | null }): Promise<string[]> {
  const weekStart = new Date();
  const day = weekStart.getDay();
  weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const isLineManager = sender.role === 'line_manager';
  const col = isLineManager ? 'manager_id' : 'department_id';
  const scope = isLineManager ? sender.id : sender.department_id;
  if (!scope) return [];
  const result = await pool.query(
    `SELECT u.id FROM users u
     WHERE u.${col} = $1 AND u.is_active = true
       AND u.id NOT IN (
         SELECT user_id FROM timesheets
         WHERE week_start_date = $2
           AND status IN ('submitted', 'under_review', 'approved')
       )`,
    [scope, weekStartStr]
  );
  return result.rows.map((r: any) => r.id);
}

// Insert one broadcast notification per recipient. Same shape the manual send
// has always written, so history and notification centre behaviour are identical.
export async function dispatchBroadcast(payload: BroadcastPayload): Promise<number> {
  const { senderId, senderName, message, defaultersOnly } = payload;
  const audience = defaultersOnly
    ? await resolveDefaulters({ id: senderId, role: payload.role, department_id: payload.departmentId })
    : await resolveAudience({ id: senderId, role: payload.role, department_id: payload.departmentId });

  for (const id of audience) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message) VALUES ($1,'broadcast',$2,$3)`,
      [id, `Reminder from ${senderName}`, message]
    );
  }
  return audience.length;
}

// Scheduler sweep: send every due scheduled broadcast. Runs every minute from
// server.ts. Due = status 'scheduled' AND scheduled_for <= now.
export async function sendDueBroadcasts(): Promise<void> {
  const due = await pool.query(
    `SELECT b.id, b.message, b.defaulters_only, u.id AS sender_id, u.name AS sender_name, u.role, u.department_id
     FROM scheduled_broadcasts b
     JOIN users u ON b.sender_id = u.id
     WHERE b.status = 'scheduled' AND b.scheduled_for <= NOW()
     LIMIT 20`
  );
  for (const b of due.rows) {
    try {
      const count = await dispatchBroadcast({
        senderId: b.sender_id,
        senderName: b.sender_name,
        role: b.role,
        departmentId: b.department_id,
        message: b.message,
        defaultersOnly: !!b.defaulters_only,
      });
      await pool.query(
        `UPDATE scheduled_broadcasts SET status='sent', sent_at=NOW(), recipient_count=$2 WHERE id=$1`,
        [b.id, count]
      );
    } catch (err) {
      console.error('Broadcast dispatch failed for', b.id, err);
    }
  }
}
