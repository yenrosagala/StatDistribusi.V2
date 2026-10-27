import { pool } from './db.js';

// One editable justification per growth cell. Empty strings / -1 stand in for
// "not applicable" so the uniqueness rule can stay a plain UNIQUE constraint
// (Postgres cannot put coalesce() expressions in a table constraint).
let ready = false;
async function ensureTable() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_notes (
      id          bigserial PRIMARY KEY,
      dataset     text    NOT NULL,
      provinsi    text    NOT NULL DEFAULT '',
      entity      text    NOT NULL DEFAULT '',
      jenis       text    NOT NULL DEFAULT '',
      kelas       integer NOT NULL DEFAULT -1,
      indicator   text    NOT NULL,
      year        integer NOT NULL,
      month       integer NOT NULL,
      comparison  text    NOT NULL,
      growth_value numeric,
      reason      text    NOT NULL,
      author      text    NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (dataset, provinsi, entity, jenis, kelas, indicator, year, month, comparison)
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS growth_notes_period_idx ON growth_notes (dataset, year, month)');
  ready = true;
}

/** Normalise an incoming cell descriptor; returns null when it cannot be keyed. */
export function normaliseCell(input = {}) {
  const dataset = String(input.dataset || '').trim();
  const indicator = String(input.indicator || '').trim();
  const year = Number(input.year);
  const month = Number(input.month);
  const comparison = String(input.comparison || '').trim();
  if (!dataset || !indicator || !Number.isInteger(year) || !Number.isInteger(month) || !comparison) {
    return null;
  }
  if (month < 1 || month > 12) return null;
  return {
    dataset,
    provinsi: String(input.provinsi || '').trim(),
    entity: String(input.entity || '').trim(),
    jenis: String(input.jenis || '').trim(),
    kelas: Number.isInteger(Number(input.kelas)) ? Number(input.kelas) : -1,
    indicator,
    year,
    month,
    comparison,
    growth_value: Number.isFinite(Number(input.growth_value)) ? Number(input.growth_value) : null,
  };
}

/** Stable string used by the table renderer to mark cells that already have a note. */
export function cellKey(c) {
  return [c.dataset, c.provinsi, c.entity, c.jenis, c.kelas, c.indicator, c.year, c.month, c.comparison].join('|');
}

export async function getNote(cell) {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT id, reason, author, created_at, updated_at
       FROM growth_notes
      WHERE dataset=$1 AND provinsi=$2 AND entity=$3 AND jenis=$4 AND kelas=$5
        AND indicator=$6 AND year=$7 AND month=$8 AND comparison=$9`,
    [cell.dataset, cell.provinsi, cell.entity, cell.jenis, cell.kelas,
      cell.indicator, cell.year, cell.month, cell.comparison],
  );
  return rows[0] || null;
}

export async function saveNote(cell, reason, author) {
  await ensureTable();
  const { rows } = await pool.query(
    `INSERT INTO growth_notes
       (dataset, provinsi, entity, jenis, kelas, indicator, year, month, comparison,
        growth_value, reason, author)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (dataset, provinsi, entity, jenis, kelas, indicator, year, month, comparison)
     DO UPDATE SET reason = EXCLUDED.reason,
                   author = EXCLUDED.author,
                   growth_value = EXCLUDED.growth_value,
                   updated_at = now()
     RETURNING id, reason, author, created_at, updated_at`,
    [cell.dataset, cell.provinsi, cell.entity, cell.jenis, cell.kelas,
      cell.indicator, cell.year, cell.month, cell.comparison,
      cell.growth_value, reason, author],
  );
  return rows[0];
}

/** Keys of every note in one dataset+period, so the table can mark them. */
export async function noteKeysFor(dataset, year, month) {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT dataset, provinsi, entity, jenis, kelas, indicator, year, month, comparison
       FROM growth_notes WHERE dataset=$1 AND year=$2 AND month=$3`,
    [dataset, year, month],
  );
  const set = new Set();
  for (const r of rows) set.add(cellKey({ ...r, year: Number(r.year), month: Number(r.month) }));
  return set;
}
