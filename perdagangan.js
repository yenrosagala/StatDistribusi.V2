// Query modul Perdagangan Luar Negeri untuk halaman web.
//
// Semua nilai dibagi 1000 -> Ribu US$, sama seperti tabel BPS.
// Basis resmi: ekspor PROVORIG, impor KPPBC. Basis POD/KDPROV hanya untuk
// rincian pelabuhan/provinsi tujuan dan tidak boleh dijumlahkan dengan yang resmi.
import { pool } from './db.js';

const BASIS_EKSPOR = 'PROVORIG';
const BASIS_IMPOR = 'KPPBC';

const num = (v) => Number(v ?? 0);

async function safeRows(sql, params = [], label = 'perdagangan') {
  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (err) {
    console.warn(`[perdagangan] ${label} tidak terbaca: ${err.message}`);
    return [];
  }
}

/** Periode (tahun, bulan) yang tersedia, terbaru di akhir. */
export async function perdaganganPeriods() {
  const rows = await safeRows(
    `SELECT DISTINCT tahun, bulan FROM fact_ekspor
     UNION SELECT tahun, bulan FROM fact_impor
     ORDER BY tahun, bulan`, [], 'periode');
  return rows.map((r) => ({ tahun: num(r.tahun), bulan: num(r.bulan) }));
}

/** Ringkasan satu provinsi + bulan: total, migas/nonmigas, kumulatif, YoY. */
export async function perdaganganRingkasan(prov, tahun, bulan) {
  const ekspor = await safeRows(
    `SELECT migas, SUM(fob) AS nilai, SUM(netto) AS netto
     FROM fact_ekspor WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan<=$4
     GROUP BY migas`, [prov, BASIS_EKSPOR, tahun, bulan], 'ringkasan ekspor');
  const impor = await safeRows(
    `SELECT migas, SUM(cif) AS nilai, SUM(netto) AS netto
     FROM fact_impor WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan<=$4
     GROUP BY migas`, [prov, BASIS_IMPOR, tahun, bulan], 'ringkasan impor');

  const eksporBulan = await safeRows(
    `SELECT migas, SUM(fob) AS nilai FROM fact_ekspor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan=$4 GROUP BY migas`,
    [prov, BASIS_EKSPOR, tahun, bulan], 'ekspor bulan');
  const imporBulan = await safeRows(
    `SELECT migas, SUM(cif) AS nilai FROM fact_impor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan=$4 GROUP BY migas`,
    [prov, BASIS_IMPOR, tahun, bulan], 'impor bulan');

  const sum = (rows, key = 'nilai') => rows.reduce((a, r) => a + num(r[key]), 0);
  const by = (rows, migas) => sum(rows.filter((r) => r.migas === migas));

  const bulanIni = {
    ekspor: sum(eksporBulan), eksporMigas: by(eksporBulan, 'Migas'), eksporNonMigas: by(eksporBulan, 'NonMigas'),
    impor: sum(imporBulan), imporMigas: by(imporBulan, 'Migas'), imporNonMigas: by(imporBulan, 'NonMigas'),
  };
  // Provinsi tanpa data (mis. Papua Pegunungan) tidak boleh tampil sebagai
  // "0,00" -- itu terbaca seperti nol sungguhan. Kembalikan null agar halaman
  // menampilkan pesan "belum ada data".
  const adaData = eksporBulan.length > 0 || imporBulan.length > 0;
  if (!adaData) return null;
  return {
    bulanIni,
    kumulatif: { ekspor: sum(ekspor), impor: sum(impor) },
  };
}

/** Deret bulanan untuk grafik: ekspor, impor, neraca per bulan (satu tahun). */
export async function perdaganganSeri(prov, tahun) {
  const ekspor = await safeRows(
    `SELECT bulan, SUM(fob) AS nilai FROM fact_ekspor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 GROUP BY bulan ORDER BY bulan`,
    [prov, BASIS_EKSPOR, tahun], 'seri ekspor');
  const impor = await safeRows(
    `SELECT bulan, SUM(cif) AS nilai FROM fact_impor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 GROUP BY bulan ORDER BY bulan`,
    [prov, BASIS_IMPOR, tahun], 'seri impor');
  const map = (rows) => {
    const out = new Array(12).fill(null);
    rows.forEach((r) => { out[num(r.bulan) - 1] = num(r.nilai) / 1000; });
    return out;
  };
  const e = map(ekspor);
  const i = map(impor);
  return {
    ekspor: e,
    impor: i,
    neraca: e.map((v, k) => (v == null || i[k] == null ? null : v - i[k])),
  };
}

/** Golongan HS 2 digit teratas untuk bulan itu. */
export async function perdaganganHs2(prov, tahun, bulan) {
  const ekspor = await safeRows(
    `SELECT hs2, SUM(fob) AS nilai FROM fact_ekspor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan=$4 GROUP BY hs2 ORDER BY 2 DESC`,
    [prov, BASIS_EKSPOR, tahun, bulan], 'hs2 ekspor');
  const impor = await safeRows(
    `SELECT hs2, SUM(cif) AS nilai FROM fact_impor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan=$4 GROUP BY hs2 ORDER BY 2 DESC`,
    [prov, BASIS_IMPOR, tahun, bulan], 'hs2 impor');
  const label = await safeRows('SELECT kode, label FROM dim_perdagangan_hs2', [], 'label hs2');
  const labelBy = new Map(label.map((r) => [r.kode, r.label]));
  const map = (rows) => rows.map((r) => ({
    kode: r.hs2,
    label: labelBy.get(r.hs2) || `HS${r.hs2}`,
    nilai: num(r.nilai) / 1000,
  }));
  return { ekspor: map(ekspor), impor: map(impor) };
}

/** Negara tujuan/asal teratas. */
export async function perdaganganNegara(prov, tahun, bulan) {
  const ekspor = await safeRows(
    `SELECT negara_iso2, negara_kode, SUM(fob) AS nilai FROM fact_ekspor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan=$4
     GROUP BY negara_iso2, negara_kode ORDER BY 3 DESC`,
    [prov, BASIS_EKSPOR, tahun, bulan], 'negara ekspor');
  const impor = await safeRows(
    `SELECT negara_iso2, negara_kode, SUM(cif) AS nilai FROM fact_impor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan=$4
     GROUP BY negara_iso2, negara_kode ORDER BY 3 DESC`,
    [prov, BASIS_IMPOR, tahun, bulan], 'negara impor');
  const map = (rows) => rows.slice(0, 10).map((r) => ({
    nama: r.negara_iso2 || r.negara_kode || '-',
    nilai: num(r.nilai) / 1000,
  }));
  return { ekspor: map(ekspor), impor: map(impor) };
}

/** Pelabuhan muat/bongkar teratas. */
export async function perdaganganPelabuhan(prov, tahun, bulan) {
  const ekspor = await safeRows(
    `SELECT pelabuhan, SUM(fob) AS nilai FROM fact_ekspor
     WHERE prov=$1 AND basis='POD' AND tahun=$2 AND bulan=$3
     GROUP BY pelabuhan ORDER BY 2 DESC`,
    [prov, tahun, bulan], 'pelabuhan ekspor');
  const impor = await safeRows(
    `SELECT pelabuhan, SUM(cif) AS nilai FROM fact_impor
     WHERE prov=$1 AND basis=$2 AND tahun=$3 AND bulan=$4
     GROUP BY pelabuhan ORDER BY 2 DESC`,
    [prov, BASIS_IMPOR, tahun, bulan], 'pelabuhan impor');
  const map = (rows) => rows.slice(0, 10).map((r) => ({
    nama: r.pelabuhan || '-',
    nilai: num(r.nilai) / 1000,
  }));
  return { ekspor: map(ekspor), impor: map(impor) };
}

export const PERDAGANGAN_PROVINSI = ['Papua', 'Papua Selatan', 'Papua Tengah', 'Papua Pegunungan'];
