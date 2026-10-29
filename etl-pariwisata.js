import * as xlsx from 'xlsx';
import { pool } from './db.js';

// Port of pariwisata/etl_engine.py so the Node admin tab ingests the exact same
// workbooks the Streamlit admin accepts, into the same tables.
export const PARIWISATA_TABLE = 'all_data';
export const PARIWISATA_REF_TABLE = 'pariwisata_ref_avg';
export const PARIWISATA_SHEET = 'Prov_Jenis_Kelas';
export const PARIWISATA_REF_SHEET = 'Prov_Jenis';

export const PROV_MAP = { 94: 'Papua', 95: 'Papua Selatan', 96: 'Papua Tengah', 97: 'Papua Pegunungan' };
export const JENIS_MAP = { 1: 'Hotel Bintang', 2: 'Hotel Non Bintang' };

const PROV_COLS = ['kd_prov', 'kd_provinsi', 'kode_prov', 'provinsi'];
const BASE_COLS = ['mktj', 'mkts', 'mtgab', 'tpk', 'rlmtgab'];
const NUM_COLS = ['mktj', 'mkts', 'mtgab', 'tpk', 'rlmtgab', 'tpk_rse', 'rlmtgab_rse', 'kelas_akomodasi'];
// Release-status text columns. "Tidak dapat rilis" means the figure must not be
// published as-is, so it gets the same (*) marker the RSE rule uses -- see
// isFlagged() in lib.js. These are text, not numbers, so they are kept out of
// NUM_COLS.
const KET_COLS = ['tpk_ket', 'rlmtgab_ket'];
const MAIN_COLS = ['kd_prov', 'kd_kab', 'jenis_akomodasi', 'kelas_akomodasi', 'mktj', 'mkts', 'mtgab',
  'tpk', 'rlmtgab', 'tpk_rse', 'rlmtgab_rse', 'tpk_ket', 'rlmtgab_ket', 'year', 'month'];

export function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const text = String(v).trim();
  if (text === '') return null;
  // The two number formats must be told apart, not guessed: blindly stripping
  // dots turned the raw cell "17.9977766075712" into 179977766075712.
  //   Indonesian  1.234.567,89 / 2,5 / 10.000  -> dot groups thousands, comma decimal
  //   Plain       1234.56 / -0.045 / 10.5      -> dot is the decimal point
  const hasComma = text.includes(',');
  // A thousands group never begins with a bare 0 integer part: "0.045" is a
  // fraction, while "10.000" groups. Hence the [1-9] on the leading digit.
  const groups = /^[1-9]\d{0,2}(\.\d{3})+$/.test(text);   // 10.000 / 1.234.567
  const indonesian = hasComma || groups;
  const normalised = indonesian
    ? text.replace(/\./g, '').replace(',', '.')
    : text.replace(/,/g, '');
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

function rawNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read one sheet as objects keyed by normalised (trimmed, lowercased) headers. */
export function readSheet(buffer, sheetName) {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  if (!wb.SheetNames.includes(sheetName)) return null;
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: true });
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[String(k).trim().toLowerCase()] = v;
    return out;
  });
}

/**
 * Mirror of ETLEngine._transform_data: normalise columns, fold *_b/*_nb pairs,
 * map province + accomodation codes, coerce numerics, drop undated rows, dedupe.
 */
export function transformRows(rows, { year = null, month = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const provCol = PROV_COLS.find((c) => c in rows[0]) || null;
  const out = [];

  for (const src of rows) {
    const row = { ...src };

    // Sum the Bintang / Non Bintang split columns into the combined metric.
    for (const base of BASE_COLS) {
      const b = rawNumber(row[`${base}_b`]);
      const nb = rawNumber(row[`${base}_nb`]);
      if (b !== null && nb !== null) row[base] = b + nb;
    }

    // Period: file columns win, otherwise fall back to the form values.
    const rowYear = rawNumber(row.year) ?? (year == null ? null : Number(year));
    const rowMonth = rawNumber(row.month) ?? (month == null ? null : Number(month));
    if (rowYear === null || rowMonth === null) continue;

    // Province: accept numeric codes, map to the names the dashboard reads.
    let kdProv = null;
    if (provCol) {
      const rawProv = row[provCol];
      const provNum = rawNumber(rawProv);
      if (provNum !== null) {
        if (!(provNum in PROV_MAP)) continue; // outside the four Papua provinces
        kdProv = PROV_MAP[provNum];
      } else if (rawProv != null && String(rawProv).trim() !== '') {
        kdProv = String(rawProv).trim();
      }
    }

    // Accomodation type: 1/2 codes map to the display labels.
    let jenis = row.jenis_akomodasi;
    const jenisNum = rawNumber(jenis);
    if (jenisNum !== null && jenisNum in JENIS_MAP) jenis = JENIS_MAP[jenisNum];
    else if (jenis != null) jenis = String(jenis).trim();

    const record = {
      kd_prov: kdProv,
      kd_kab: row.kd_kab == null || row.kd_kab === '' ? null : String(row.kd_kab).trim(),
      jenis_akomodasi: jenis ?? null,
      kelas_akomodasi: null,
      mktj: null, mkts: null, mtgab: null, tpk: null, rlmtgab: null,
      tpk_rse: null, rlmtgab_rse: null,
      tpk_ket: null, rlmtgab_ket: null,
      year: Math.trunc(rowYear),
      month: Math.trunc(rowMonth),
    };
    for (const col of NUM_COLS) {
      if (col === 'kelas_akomodasi') {
        const n = rawNumber(row[col]);
        record[col] = n === null ? null : Math.trunc(n);
      } else {
        const n = toNumber(row[col]);
        record[col] = n === null ? 0 : n;
      }
    }
    for (const col of KET_COLS) {
      const raw = row[col];
      record[col] = raw === null || raw === undefined || String(raw).trim() === ''
        ? null
        : String(raw).trim();
    }
    out.push(record);
  }

  // Dedupe on the natural key, keeping the last occurrence (mirrors drop_duplicates(keep='last')).
  const seen = new Map();
  for (const rec of out) {
    const key = [rec.kd_prov, rec.kd_kab, rec.jenis_akomodasi, rec.kelas_akomodasi, rec.year, rec.month].join('|');
    seen.set(key, rec);
  }
  return [...seen.values()];
}

/** Parse an uploaded workbook into main rows, reference rows and summary stats. */
export function parsePariwisataFile(buffer, { year = null, month = null } = {}) {
  const mainRaw = readSheet(buffer, PARIWISATA_SHEET);
  if (mainRaw === null) {
    throw new Error(`Sheet "${PARIWISATA_SHEET}" tidak ditemukan pada berkas ini.`);
  }
  const rows = transformRows(mainRaw, { year, month });
  if (!rows.length) {
    throw new Error('Tidak ada baris data yang bisa dibaca (periksa kolom kd_prov / year / month).');
  }

  const refRaw = readSheet(buffer, PARIWISATA_REF_SHEET);
  const refRows = refRaw ? transformRows(refRaw, { year, month }) : [];

  const periods = [...new Set(rows.map((r) => `${r.year}|${r.month}`))]
    .map((s) => s.split('|').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const provinces = [...new Set(rows.map((r) => r.kd_prov).filter(Boolean))].sort();
  const sum = (key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);

  return {
    rows,
    refRows,
    periods,
    stats: {
      jumlah_baris: rows.length,
      jumlah_periode: periods.length,
      periode_label: periods.map(([y, m]) => `${m}/${y}`).join(', '),
      jumlah_provinsi: provinces.length,
      provinsi: provinces,
      total_tpk_rata: rows.length ? sum('tpk') / rows.length : 0,
      total_rlmtgab_rata: rows.length ? sum('rlmtgab') / rows.length : 0,
      jumlah_kabupaten: new Set(rows.map((r) => r.kd_kab).filter(Boolean)).size,
      ada_ref_avg: refRows.length > 0,
    },
  };
}

const INSERT_MAIN = `INSERT INTO ${PARIWISATA_TABLE} (${MAIN_COLS.join(',')})
  VALUES (${MAIN_COLS.map((_, i) => `$${i + 1}`).join(',')})`;
const INSERT_REF = `INSERT INTO ${PARIWISATA_REF_TABLE} (kd_prov,jenis_akomodasi,year,month,tpk,rlmtgab,
  tpk_ket,rlmtgab_ket)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

// Idempotent schema upgrade: older databases predate the release-status columns.
// Without this the INSERT below fails with "column tpk_ket does not exist".
export async function ensurePariwisataColumns() {
  const stmts = [];
  for (const table of [PARIWISATA_TABLE, PARIWISATA_REF_TABLE]) {
    for (const col of KET_COLS) {
      stmts.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} text`);
    }
  }
  for (const sql of stmts) await pool.query(sql);
}

export async function countExistingRows(year, month) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${PARIWISATA_TABLE} WHERE year = $1 AND month = $2`,
    [Number(year), Number(month)],
  );
  return r.rows[0].n;
}

export async function countExistingPeriods(periods) {
  let total = 0;
  for (const [y, m] of periods) total += await countExistingRows(y, m);
  return total;
}

/** Replace every period the upload touches, in one transaction. */
export async function savePariwisata(rows, refRows = []) {
  const periods = [...new Set(rows.map((r) => `${r.year}|${r.month}`))]
    .map((s) => s.split('|').map(Number));
  const refPeriods = [...new Set(refRows.map((r) => `${r.year}|${r.month}`))]
    .map((s) => s.split('|').map(Number));

  // Migrate before the transaction: ALTER TABLE would otherwise hold a lock
  // for the whole insert.
  await ensurePariwisataColumns();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [y, m] of periods) {
      await client.query(`DELETE FROM ${PARIWISATA_TABLE} WHERE year = $1 AND month = $2`, [y, m]);
    }
    for (const [y, m] of refPeriods) {
      await client.query(`DELETE FROM ${PARIWISATA_REF_TABLE} WHERE year = $1 AND month = $2`, [y, m]);
    }
    for (const r of rows) {
      await client.query(INSERT_MAIN, MAIN_COLS.map((c) => r[c]));
    }
    for (const r of refRows) {
      await client.query(INSERT_REF, [r.kd_prov, r.jenis_akomodasi, r.year, r.month, r.tpk, r.rlmtgab,
        r.tpk_ket, r.rlmtgab_ket]);
    }
    await client.query('COMMIT');
    return { inserted: rows.length, refInserted: refRows.length, periods: periods.length };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
    throw err;
  } finally {
    client.release();
  }
}

export function buildDeleteFilter({ provinsi, tahun, bulan }) {
  const where = [];
  const params = [];
  if (provinsi && provinsi !== 'SEMUA') {
    params.push(provinsi);
    where.push(`kd_prov = $${params.length}`);
  }
  if (tahun && tahun !== 'SEMUA') {
    params.push(String(tahun));
    where.push(`CAST(year AS TEXT) = $${params.length}`);
  }
  if (bulan && bulan !== 'SEMUA') {
    params.push(Number(bulan));
    where.push(`month = $${params.length}`);
  }
  return { clause: where.length ? where.join(' AND ') : '1=1', params };
}

export async function countFiltered(filters) {
  const { clause, params } = buildDeleteFilter(filters);
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${PARIWISATA_TABLE} WHERE ${clause}`, params);
  return r.rows[0].n;
}

export async function deleteFiltered(filters) {
  const { clause, params } = buildDeleteFilter(filters);
  const r = await pool.query(`DELETE FROM ${PARIWISATA_TABLE} WHERE ${clause}`, params);
  return r.rowCount;
}

export async function periodRows(year, month = null) {
  const params = [Number(year)];
  let sql = `SELECT * FROM ${PARIWISATA_TABLE} WHERE year = $1`;
  if (month != null) { params.push(Number(month)); sql += ' AND month = $2'; }
  sql += ' ORDER BY year, month, kd_prov, jenis_akomodasi, kelas_akomodasi';
  const r = await pool.query(sql, params);
  return r.rows;
}

/** TSV round-trip for the manual-correction textarea. */
export const EDIT_COLUMNS = ['kd_prov', 'kd_kab', 'jenis_akomodasi', 'kelas_akomodasi',
  'mktj', 'mkts', 'mtgab', 'tpk', 'rlmtgab', 'tpk_rse', 'rlmtgab_rse',
  'tpk_ket', 'rlmtgab_ket', 'year', 'month'];

export function rowsToTsv(rows) {
  const lines = [EDIT_COLUMNS.join('\t')];
  for (const row of rows) lines.push(EDIT_COLUMNS.map((c) => (row[c] == null ? '' : row[c])).join('\t'));
  return lines.join('\n');
}

const TEXT_COLS = new Set(['kd_prov', 'kd_kab', 'jenis_akomodasi']);

export function tsvToRows(tsv) {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const header = lines[0].split('\t').map((h) => h.trim());
  if (header.join('|') !== EDIT_COLUMNS.join('|')) {
    throw new Error(`Header tabel harus: ${EDIT_COLUMNS.join(', ')}`);
  }
  return lines.slice(1).map((line, index) => {
    const cells = line.split('\t');
    if (cells.length !== EDIT_COLUMNS.length) {
      throw new Error(`Baris ${index + 2} memiliki ${cells.length} kolom, seharusnya ${EDIT_COLUMNS.length}.`);
    }
    const row = {};
    EDIT_COLUMNS.forEach((col, i) => {
      const raw = cells[i].trim();
      if (TEXT_COLS.has(col)) row[col] = raw || null;
      else if (col === 'year' || col === 'month' || col === 'kelas_akomodasi') row[col] = raw === '' ? null : Math.trunc(Number(raw));
      else row[col] = raw === '' ? 0 : Number(raw.replace(/\./g, '').replace(',', '.'));
    });
    return row;
  });
}

/** Replace the given prov/year/month buckets with the edited rows. */
export async function replacePeriods(rows) {
  const periods = [...new Set(rows.map((r) => `${r.year}|${r.month}`))].map((s) => s.split('|').map(Number));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [y, m] of periods) {
      await client.query(`DELETE FROM ${PARIWISATA_TABLE} WHERE year = $1 AND month = $2`, [y, m]);
    }
    for (const r of rows) await client.query(INSERT_MAIN, MAIN_COLS.map((c) => r[c]));
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Aggregated series for the Data Series Graph panel. */
export async function seriesData({ provinsi, kabupaten, variabel }) {
  const vars = (variabel && variabel.length ? variabel : ['tpk', 'rlmtgab'])
    .filter((v) => ['tpk', 'rlmtgab', 'mktj', 'mkts', 'mtgab'].includes(v));
  if (!vars.length) throw new Error('Pilih minimal satu variabel indikator.');

  const where = [];
  const params = [];
  if (provinsi && provinsi !== 'SEMUA') { params.push(provinsi); where.push(`kd_prov = $${params.length}`); }
  if (kabupaten && kabupaten !== 'SEMUA') { params.push(String(kabupaten)); where.push(`kd_kab = $${params.length}`); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const sql = `SELECT year, month, ${vars.map((v) => `SUM(${v}) AS ${v}`).join(', ')}
    FROM ${PARIWISATA_TABLE}${clause} GROUP BY year, month ORDER BY year, month`;
  const { rows } = await pool.query(sql, params);
  if (!rows.length) return { empty: true, periods: [], series: [], variabel: vars };

  const MONTHS = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
    'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return {
    empty: false,
    periods: rows.map((r) => `${MONTHS[Number(r.month)]} ${Number(r.year)}`),
    series: vars.map((v) => ({ name: labelOf(v), data: rows.map((r) => Number(r[v]) || 0) })),
    variabel: vars,
  };
}

function labelOf(v) {
  return { tpk: 'TPK (%)', rlmtgab: 'RLMTGAB (malam)', mktj: 'MKTJ', mkts: 'MKTS', mtgab: 'MTGAB' }[v] || v;
}
