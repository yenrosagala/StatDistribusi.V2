import { pool } from './db.js';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
  'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

// Whitelists: indicator names arrive from the browser, so never interpolate raw.
export const TRANSPORT_INDICATORS = {
  transportasi_udara: {
    entityCol: 'nama_bandara',
    cols: ['pesawat_berangkat', 'pesawat_datang', 'penumpang_berangkat', 'penumpang_datang',
      'penumpang_transit', 'barang_muat_kg', 'barang_bongkar_kg', 'bagasi_muat_kg',
      'bagasi_bongkar_kg', 'pos_muat_kg', 'pos_bongkar_kg'],
  },
  transportasi_laut: {
    entityCol: 'nama_pelabuhan',
    cols: ['dn_penumpang_turun', 'dn_penumpang_naik', 'dn_bongkar_barang_ton',
      'dn_muat_barang_ton', 'ln_penumpang_turun', 'ln_penumpang_naik',
      'ln_bongkar_barang_ton', 'ln_muat_barang_ton'],
  },
};
export const PARIWISATA_INDICATORS = ['tpk', 'rlmtgab', 'mktj', 'mkts', 'mtgab'];

export function isKnownIndicator(dataset, indicator) {
  if (dataset === 'all_data') return PARIWISATA_INDICATORS.includes(indicator);
  const t = TRANSPORT_INDICATORS[dataset];
  return Boolean(t && t.cols.includes(indicator));
}

/** 12-slot arrays (index 0 = Januari) for `year` and `year - 1`. */
function blank() { return new Array(12).fill(null); }

async function transportSeries(cell) {
  const meta = TRANSPORT_INDICATORS[cell.dataset];
  const { rows } = await pool.query(
    `SELECT CAST(tahun AS TEXT) AS th, bulan, SUM(${cell.indicator}) AS val
       FROM ${cell.dataset}
      WHERE UPPER(${meta.entityCol}) = UPPER($1)
        AND UPPER(nama_provinsi) = UPPER($2)
        AND CAST(tahun AS TEXT) = ANY($3::text[])
      GROUP BY 1, bulan`,
    [cell.entity, cell.provinsi, [String(cell.year - 1), String(cell.year)]],
  );
  const prev = blank();
  const cur = blank();
  for (const r of rows) {
    const i = MONTHS.indexOf(r.bulan);
    if (i === -1) continue;
    const v = Number(r.val);
    if (Number(r.th) === cell.year - 1) prev[i] = v;
    else if (Number(r.th) === cell.year) cur[i] = v;
  }
  return { previous: prev, current: cur };
}

async function pariwisataSeries(cell) {
  const params = [cell.provinsi, cell.jenis, [cell.year - 1, cell.year]];
  let sql = `SELECT year, month, ${cell.kelas >= 0 ? 'MAX(' + cell.indicator + ')' : 'AVG(' + cell.indicator + ')'} AS val
               FROM all_data
              WHERE kd_prov = $1 AND jenis_akomodasi = $2 AND year = ANY($3::int[])`;
  if (cell.kelas >= 0) {
    params.push(cell.kelas);
    sql += ` AND kelas_akomodasi = $${params.length}`;
  }
  sql += ' GROUP BY year, month';
  const { rows } = await pool.query(sql, params);
  const prev = blank();
  const cur = blank();
  for (const r of rows) {
    const i = Number(r.month) - 1;
    if (i < 0 || i > 11) continue;
    const v = r.val == null ? null : Number(r.val);
    if (Number(r.year) === cell.year - 1) prev[i] = v;
    else if (Number(r.year) === cell.year) cur[i] = v;
  }
  return { previous: prev, current: cur };
}

export async function buildSeries(cell) {
  if (!isKnownIndicator(cell.dataset, cell.indicator)) {
    throw new Error(`Indikator tidak dikenal: ${cell.indicator}`);
  }
  const data = cell.dataset === 'all_data'
    ? await pariwisataSeries(cell)
    : await transportSeries(cell);
  return {
    labels: SHORT,
    years: [cell.year - 1, cell.year],
    ...data,
  };
}
