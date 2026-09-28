import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Supabase's pooler occasionally drops idle sockets; without these the
  // process dies on the dropped connection instead of reconnecting.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

// A backend error on an idle client (socket dropped by the pooler) must not
// take the whole API down — pg returns the client to the pool and reconnects
// on the next query.
pool.on('error', (err) => {
  console.error('[db] idle client error (pool will reconnect):', err.message);
});
