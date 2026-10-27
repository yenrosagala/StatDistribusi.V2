import { pool } from './db.js';

// Staged uploads used to live in a module-level Map. That breaks on Vercel,
// where each invocation is a fresh process: the `stage` token handed to the
// preview/save steps would no longer resolve. Persist them instead, in the same
// PostgreSQL database the app already uses.
const TTL_MS = Number(process.env.UPLOAD_TTL_MS || 30 * 60 * 1000);
const TABLE = 'upload_staging';

let ready = false;
async function ensureTable() {
  if (ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    token text primary key,
    kind text not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`);
  ready = true;
}

function encode(record) {
  return {
    ...record,
    files: (record.files || []).map((f) => ({
      ...f,
      // Buffers do not survive JSON, so carry the bytes as base64.
      buffer: Buffer.isBuffer(f.buffer) ? f.buffer.toString('base64') : f.buffer,
    })),
  };
}

function decode(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    ...payload,
    files: (payload.files || []).map((f) => ({
      ...f,
      buffer: typeof f.buffer === 'string' ? Buffer.from(f.buffer, 'base64') : f.buffer,
    })),
  };
}

/** Stage a parsed upload under `token`, replacing any existing entry. */
export async function putStaged(token, record) {
  await ensureTable();
  await pool.query(
    `INSERT INTO ${TABLE} (token, kind, payload, expires_at)
     VALUES ($1, $2, $3::jsonb, now() + ($4 || ' milliseconds')::interval)
     ON CONFLICT (token) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
    [token, record.kind || 'generic', JSON.stringify(encode(record)), String(TTL_MS)],
  );
}

/** Read a staged upload, or null when missing/expired. */
export async function getStaged(token) {
  if (!token) return null;
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT payload FROM ${TABLE} WHERE token = $1 AND expires_at > now()`,
    [String(token)],
  );
  return rows.length ? decode(rows[0].payload) : null;
}

export async function deleteStaged(token) {
  if (!token) return;
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE token = $1`, [String(token)]);
}

export async function pruneStaged() {
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE expires_at <= now()`);
}

/** Object with the same shape the callers used for the old Map. */
export const stagingStore = { get: getStaged, put: putStaged, delete: deleteStaged };
