import { pool } from '../db';

export async function logAudit(
  actorId: string,
  actorName: string,
  action: string,
  entityType: string,
  entityId: string | null,
  description: string,
  reason?: string
) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, description, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actorId, actorName, action, entityType, entityId, description, reason || null]
    );
  } catch (err) {
    console.error('[AUDIT] Failed to write audit log:', err);
  }
}
