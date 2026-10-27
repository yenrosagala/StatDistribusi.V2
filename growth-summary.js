import crypto from 'node:crypto';
import { pool } from './db.js';

// One summary per (module, month) covering every province. Cached by a hash of
// the notes it was built from, so editing any justification invalidates it.
let ready = false;
async function ensureTable() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_summaries (
      id          bigserial PRIMARY KEY,
      module      text    NOT NULL,
      year        integer NOT NULL,
      month       integer NOT NULL,
      input_hash  text    NOT NULL,
      model       text,
      summary     text    NOT NULL,
      note_count  integer NOT NULL,
      cell_count  integer NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (module, year, month, input_hash)
    )`);
  ready = true;
}

export const MODULE_DATASETS = {
  pariwisata: ['all_data'],
  transportasi: ['transportasi_udara', 'transportasi_laut'],
};

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
  'Agustus', 'September', 'Oktober', 'November', 'Desember'];

export function monthName(month) {
  return MONTHS[Number(month) - 1] || String(month);
}

/** All justifications for one module + month, across every province. */
export async function collectNotes(module, year, month) {
  await ensureTable();
  const datasets = MODULE_DATASETS[module];
  if (!datasets) throw new Error('Modul tidak dikenal');

  const { rows } = await pool.query(
    `SELECT dataset, provinsi, entity, jenis, kelas, indicator, comparison,
            growth_value, reason, author, updated_at
       FROM growth_notes
      WHERE dataset = ANY($1::text[]) AND year = $2 AND month = $3
      ORDER BY provinsi, dataset, entity, jenis, kelas, indicator`,
    [datasets, Number(year), Number(month)],
  );

  const notes = rows.map((r) => ({
    ...r,
    growth_value: r.growth_value == null ? null : Number(r.growth_value),
    kelas: Number(r.kelas),
  }));

  return { notes, coverage: await coverageFor(module, year, month, notes.length) };
}

/**
 * Coverage = how many growth cells had a note. Cells are counted from the same
 * tables the report renders, so the percentage is meaningful rather than a guess.
 */
async function coverageFor(module, year, month, noteCount) {
  let cells = 0;
  try {
    if (module === 'pariwisata') {
      const r = await pool.query(
        'SELECT COUNT(*)::int AS n FROM all_data WHERE year = $1 AND month = $2',
        [Number(year), Number(month)],
      );
      cells = r.rows[0].n;
    } else {
      for (const t of MODULE_DATASETS.transportasi) {
        const r = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${t} WHERE CAST(tahun AS TEXT) = $1 AND bulan = $2`,
          [String(year), monthName(month)],
        );
        cells += r.rows[0].n;
      }
    }
  } catch { /* coverage is advisory */ }
  const percent = cells ? Math.round((noteCount / cells) * 1000) / 10 : null;
  return { notes: noteCount, cells, percent };
}

export function hashNotes(notes) {
  const basis = notes
    .map((n) => `${n.dataset}|${n.provinsi}|${n.entity}|${n.jenis}|${n.kelas}|${n.indicator}|${n.comparison}|${n.updated_at}`)
    .sort()
    .join('\n');
  return crypto.createHash('md5').update(basis).digest('hex');
}

export async function getCached(module, year, month, inputHash) {
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT id, summary, model, note_count, cell_count, created_at
       FROM growth_summaries
      WHERE module=$1 AND year=$2 AND month=$3 AND input_hash=$4`,
    [module, Number(year), Number(month), inputHash],
  );
  return rows[0] || null;
}

export async function saveSummary({ module, year, month, inputHash, model, summary, noteCount, cellCount }) {
  await ensureTable();
  const { rows } = await pool.query(
    `INSERT INTO growth_summaries (module, year, month, input_hash, model, summary, note_count, cell_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (module, year, month, input_hash)
     DO UPDATE SET summary = EXCLUDED.summary, model = EXCLUDED.model, created_at = now()
     RETURNING id, summary, model, note_count, cell_count, created_at`,
    [module, Number(year), Number(month), inputHash, model, summary, noteCount, cellCount],
  );
  return rows[0];
}

/** Periods that actually have justifications, newest first. */
export async function notePeriods(module) {
  await ensureTable();
  const datasets = MODULE_DATASETS[module];
  if (!datasets) throw new Error('Modul tidak dikenal');
  const { rows } = await pool.query(
    `SELECT year, month, COUNT(*)::int AS n
       FROM growth_notes
      WHERE dataset = ANY($1::text[])
      GROUP BY year, month
      ORDER BY year DESC, month DESC`,
    [datasets],
  );
  return rows.map((r) => ({ year: Number(r.year), month: Number(r.month), count: Number(r.n) }));
}
