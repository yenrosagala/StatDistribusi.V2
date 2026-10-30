// Query modul Perdagangan Luar Negeri untuk halaman web.
//
// Semua nilai dibagi 1000 -> Ribu US$, sama seperti tabel BPS.
// Basis resmi: ekspor PROVORIG, impor KPPBC. Basis POD/KDPROV hanya untuk
// rincian pelabuhan/provinsi tujuan dan tidak boleh dijumlahkan dengan yang resmi.
import { pool } from './db.js';
import { namaPelabuhan } from './pelabuhan-nama.js';

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
    // Kode pelabuhan (mis. 35563) diubah ke nama lewat master yang sama
    // dengan halaman Laporan; kode tak dikenal ditampilkan apa adanya.
    nama: namaPelabuhan(r.pelabuhan),
    nilai: num(r.nilai) / 1000,
  }));
  return { ekspor: map(ekspor), impor: map(impor) };
}

/** Riwayat unggahan terakhir, termasuk hasil validasi terhadap berkas kontrol. */
export async function perdaganganEtlLog(limit = 20) {
  const rows = await safeRows(
    `SELECT tahun, bulan, arus, prov, basis, sumber, baris, dicocokkan, loaded_at
     FROM etl_log_perdagangan ORDER BY loaded_at DESC LIMIT $1`, [limit], 'etl log');
  return rows;
}

/**
 * Ringkasan cepat untuk halaman admin: berapa baris per periode.
 *
 * Hanya basis resmi yang dihitung (ekspor PROVORIG, impor KPPBC). Sebelumnya
 * query ini menjumlah semua basis, sehingga Agustus 2026 terbaca 406 baris
 * ekspor padahal angka resminya 172 -- 234 baris sisanya basis POD.
 */
export async function perdaganganRingkasPeriode() {
  const rows = await safeRows(
    `SELECT tahun, bulan,
            (SELECT count(*) FROM fact_ekspor e
              WHERE e.tahun=f.tahun AND e.bulan=f.bulan AND e.basis=$1)::int AS ekspor,
            (SELECT count(*) FROM fact_impor i
              WHERE i.tahun=f.tahun AND i.bulan=f.bulan AND i.basis=$2)::int AS impor
     FROM (SELECT DISTINCT tahun, bulan FROM fact_ekspor WHERE basis=$1
           UNION SELECT DISTINCT tahun, bulan FROM fact_impor WHERE basis=$2) f
     ORDER BY tahun DESC, bulan DESC`,
    [BASIS_EKSPOR, BASIS_IMPOR], 'ringkas periode');
  return rows;
}

// ---------------------------------------------------------------------------
// Laporan lengkap (tab Laporan) — meniru laporan perdagangan-papua.html:
// per arus 4 tabel (ringkasan, HS2, negara, pelabuhan) dengan 5 kolom periode
// dan 6 kolom turunan; ditambah 2 tabel neraca.
// ---------------------------------------------------------------------------

/** (tahun, bulan) sebelumnya, melewati batas tahun. */
function prevPeriod(tahun, bulan) {
  return bulan > 1 ? { tahun, bulan: bulan - 1 } : { tahun: tahun - 1, bulan: 12 };
}

/**
 * Ambil semua baris satu arus untuk tahun ini + tahun lalu sampai `bulan`,
 * lalu agregasikan di JS supaya hanya satu query per arus.
 */
async function barisArus(arus, prov, tahun, bulan, basis) {
  const tabel = arus === 'ekspor' ? 'fact_ekspor' : 'fact_impor';
  const kolom = arus === 'ekspor' ? 'fob' : 'cif';
  const kolomEntitas = arus === 'ekspor' ? 'negara_iso2' : 'negara_iso2';
  const rows = await safeRows(
    `SELECT tahun, bulan, migas, hs2, ${kolomEntitas} AS negara, pelabuhan, ${kolom} AS nilai
     FROM ${tabel}
     WHERE prov=$1 AND basis=$2 AND tahun IN ($3,$4) AND bulan <= $5`,
    [prov, basis, tahun, tahun - 1, bulan], `laporan ${arus}`);
  return rows.map((r) => ({
    tahun: num(r.tahun), bulan: num(r.bulan),
    migas: String(r.migas || '').trim(),
    hs2: String(r.hs2 || '').trim(),
    negara: String(r.negara || '').trim(),
    pelabuhan: String(r.pelabuhan || '').trim(),
    nilai: num(r.nilai) / 1000,
  }));
}

/** Agregat satu dimensi pada satu irisan waktu. */
function agregat(rows, dimensi, slice) {
  const out = new Map();
  for (const r of rows) {
    if (!slice(r)) continue;
    const key = dimensi === 'migas' ? r.migas : r[dimensi];
    if (!key) continue;
    out.set(key, (out.get(key) || 0) + r.nilai);
  }
  return out;
}

/**
 * 5 nilai periode untuk semua kunci pada satu dimensi.
 *
 * `periodeAda` berisi kunci "tahun|bulan" yang punya data pada provinsi itu
 * (dari arus mana pun). Bila periodenya ada tetapi entitas ini tidak punya
 * baris, nilainya 0 — sama seperti perilaku laporan asli. Bila periodenya sama
 * sekali tidak ada, nilainya null dan ditampilkan "–".
 */
function seri5(rows, dimensi, tahun, bulan, periodeAda) {
  const prev = prevPeriod(tahun, bulan);
  const slices = [
    { cek: (r) => r.tahun === tahun - 1 && r.bulan === bulan, ada: (y, m) => periodeAda.has(`${y}|${m}`), },
    { cek: (r) => r.tahun === prev.tahun && r.bulan === prev.bulan, ada: () => periodeAda.has(`${prev.tahun}|${prev.bulan}`) },
    { cek: (r) => r.tahun === tahun && r.bulan === bulan, ada: () => periodeAda.has(`${tahun}|${bulan}`) },
    { cek: (r) => r.tahun === tahun - 1 && r.bulan <= bulan, ada: () => true },
    { cek: (r) => r.tahun === tahun && r.bulan <= bulan, ada: () => true },
  ];
  const maps = slices.map((s) => agregat(rows, dimensi, s.cek));
  const kumAda = [
    [...periodeAda].some((k) => k.startsWith(`${tahun - 1}|`)),
    [...periodeAda].some((k) => k.startsWith(`${tahun}|`)),
  ];
  const keys = new Set();
  maps.forEach((m) => m.forEach((_v, k) => keys.add(k)));
  const hasil = new Map();
  for (const k of keys) {
    hasil.set(k, maps.map((m, i) => {
      if (m.has(k)) return m.get(k);
      // periode ada -> 0; kumulatif -> 0 bila tahun itu punya data
      if (i < 3) return slices[i].ada() ? 0 : null;
      return kumAda[i - 3] ? 0 : null;
    }));
  }
  return hasil;
}

/** Jumlahkan beberapa seri 5-nilai (mis. Migas + NonMigas = Total). */
function jumlahSeri(daftar) {
  return [0, 1, 2, 3, 4].map((i) => {
    const vals = daftar.map((s) => s[i]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  });
}

function barisDariSeri(seri, label) {
  return { label, nilai: seri };
}

/**
 * Total 5 periode dari Migas + NonMigas.
 *
 * Bila kedua rincian tidak punya baris tetapi periodenya ada, totalnya 0
 * (bukan null) supaya cocok dengan laporan BPS: periode yang ada dengan nol
 * transaksi ditulis 0,00.
 */
function totalDari(migas, tahun, bulan, periodeAda) {
  const prev = prevPeriod(tahun, bulan);
  const adaPeriode = [
    periodeAda.has(`${tahun - 1}|${bulan}`),
    periodeAda.has(`${prev.tahun}|${prev.bulan}`),
    periodeAda.has(`${tahun}|${bulan}`),
    [...periodeAda].some((k) => k.startsWith(`${tahun - 1}|`)),
    [...periodeAda].some((k) => k.startsWith(`${tahun}|`)),
  ];
  const m = migas.get('Migas') || [null, null, null, null, null];
  const n = migas.get('NonMigas') || [null, null, null, null, null];
  return [0, 1, 2, 3, 4].map((i) => {
    if (m[i] != null || n[i] != null) return (m[i] || 0) + (n[i] || 0);
    return adaPeriode[i] ? 0 : null;
  });
}

/** Susun 4 tabel satu arus. */
function tabelArus(rows, tahun, bulan, periodeAda, limit = 10) {
  const migas = seri5(rows, 'migas', tahun, bulan, periodeAda);
  const total = totalDari(migas, tahun, bulan, periodeAda);

  const isi = (key) => {
    const v = migas.get(key);
    if (v) return v;
    // periode ada tanpa baris -> 0, supaya konsisten dengan Total
    return total.map((x) => (x == null ? null : 0));
  };
  const ringkasan = [
    barisDariSeri(total, 'Total'),
    barisDariSeri(isi('Migas'), 'Migas'),
    barisDariSeri(isi('NonMigas'), 'Non Migas'),
  ];

  const entitas = (dimensi) => {
    const seri = seri5(rows, dimensi, tahun, bulan, periodeAda);
    let list = [...seri.entries()]
      .map(([k, v]) => ({ k, v }))
      .filter((r) => r.v.some((x) => x != null))
      .sort((a, b) => (b.v[2] ?? 0) - (a.v[2] ?? 0) || (b.v[4] ?? 0) - (a.v[4] ?? 0));
    if (limit && list.length > limit) {
      const sisa = list.slice(limit);
      list = list.slice(0, limit);
      const agg = [0, 1, 2, 3, 4].map((i) => {
        const vals = sisa.map((r) => r.v[i]).filter((x) => x != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      });
      list.push({ k: `Lainnya (${sisa.length})`, v: agg });
    }
    list.push({ k: 'Total', v: total });
    return list.map((r) => barisDariSeri(r.v, r.k));
  };

  return {
    ringkasan,
    hs2: entitas('hs2'),
    negara: entitas('negara'),
    pelabuhan: entitas('pelabuhan'),
  };
}

/** Rekap bulanan neraca: 12 bulan, dua tahun, plus kumulatif. */
function rekapNeraca(eksporRows, imporRows, tahun, bulan) {
  const out = [];
  let kumLast = null;
  let kumNow = null;
  for (let b = 1; b <= 12; b += 1) {
    const sum = (rows, th) => rows
      .filter((r) => r.tahun === th && r.bulan === b)
      .reduce((a, r) => a + r.nilai, 0);
    const ey = b <= bulan ? sum(eksporRows, tahun) : null;
    const iy = b <= bulan ? sum(imporRows, tahun) : null;
    const ep = sum(eksporRows, tahun - 1);
    const ip = sum(imporRows, tahun - 1);
    const by = ey != null && iy != null ? ey - iy : null;
    const bp = ep - ip;
    if (by != null) kumNow = (kumNow || 0) + by;
    kumLast = (kumLast || 0) + bp;
    out.push({ bulan: b, eksporLast: ep, imporLast: ip, neracaLast: bp,
      eksporNow: ey, imporNow: iy, neracaNow: by, kumLast, kumNow });
  }
  return out;
}

/** Nama negara untuk kode ISO2 yang muncul di data. */
export const NEGARA_NAMA = {
  CN: 'Tiongkok', JP: 'Jepang', US: 'Amerika Serikat', AU: 'Australia',
  SG: 'Singapura', MY: 'Malaysia', KR: 'Korea Selatan', IN: 'India',
  NZ: 'Selandia Baru', PG: 'Papua Nugini', TH: 'Thailand', VN: 'Vietnam',
  PH: 'Filipina', HK: 'Hong Kong', TW: 'Taiwan', DE: 'Jerman', GB: 'Inggris',
  NL: 'Belanda', FR: 'Prancis', IT: 'Italia', ES: 'Spanyol', BE: 'Belgia',
  CH: 'Swiss', CA: 'Kanada', BR: 'Brasil', RU: 'Rusia', ID: 'Indonesia',
  FI: 'Finlandia', MX: 'Meksiko', SE: 'Swedia', NO: 'Norwegia', DK: 'Denmark',
  AT: 'Austria', PL: 'Polandia', TR: 'Turki', SA: 'Arab Saudi', AE: 'Uni Emirat Arab',
  EG: 'Mesir', ZA: 'Afrika Selatan', AR: 'Argentina', CL: 'Cile', PE: 'Peru',
  KH: 'Kamboja', LA: 'Laos', MM: 'Myanmar', BD: 'Bangladesh', LK: 'Sri Lanka',
  PK: 'Pakistan', IR: 'Iran', IQ: 'Irak', KW: 'Kuwait', QA: 'Qatar',
};

/** Label HS 2 digit dari tabel dimensi, fallback "HSxx". */
async function labelHs2() {
  const rows = await safeRows('SELECT kode, label FROM dim_perdagangan_hs2', [], 'label hs2');
  return new Map(rows.map((r) => [String(r.kode), r.label]));
}

/** Ganti kode entitas menjadi label yang bisa dibaca. */
function beriLabel(daftar, dimensi, hs2Labels) {
  return daftar.map((r) => {
    if (dimensi === 'negara') {
      const kode = String(r.label).toUpperCase();
      return { ...r, label: NEGARA_NAMA[kode] || r.label };
    }
    if (dimensi === 'hs2') {
      const lab = hs2Labels.get(String(r.label));
      return { ...r, label: lab || `HS${r.label}` };
    }
    if (dimensi === 'pelabuhan') {
      return { ...r, label: namaPelabuhan(r.label) };
    }
    return r;
  });
}

/** Data lengkap tab Laporan. */
export async function perdaganganLaporan(prov, tahun, bulan) {
  const [eksporResmi, eksporPod, imporResmi] = await Promise.all([
    barisArus('ekspor', prov, tahun, bulan, BASIS_EKSPOR),
    barisArus('ekspor', prov, tahun, bulan, 'POD'),
    barisArus('impor', prov, tahun, bulan, BASIS_IMPOR),
  ]);

  // Periode dianggap "ada" bila arus mana pun punya baris. Di dalam periode
  // yang ada, entitas tanpa baris bernilai 0 (bukan null).
  const periodeAda = new Set();
  for (const r of [...eksporResmi, ...eksporPod, ...imporResmi]) {
    periodeAda.add(`${r.tahun}|${r.bulan}`);
  }

  const hs2Labels = await labelHs2();
  const ekspor = tabelArus(eksporResmi, tahun, bulan, periodeAda);
  ekspor.hs2 = beriLabel(ekspor.hs2, 'hs2', hs2Labels);
  ekspor.negara = beriLabel(ekspor.negara, 'negara', hs2Labels);
  // Pelabuhan muat memakai basis POD, bukan angka resmi.
  ekspor.pelabuhan = beriLabel(tabelArus(eksporPod, tahun, bulan, periodeAda).pelabuhan, 'pelabuhan', hs2Labels);
  const impor = tabelArus(imporResmi, tahun, bulan, periodeAda);
  impor.hs2 = beriLabel(impor.hs2, 'hs2', hs2Labels);
  impor.negara = beriLabel(impor.negara, 'negara', hs2Labels);
  impor.pelabuhan = beriLabel(impor.pelabuhan, 'pelabuhan', hs2Labels);

  const neraca = {
    ringkasan: ekspor.ringkasan.map((r, i) => ({
      label: i === 0 ? 'Total' : r.label,
      nilai: r.nilai.map((v, j) => (v == null || impor.ringkasan[i].nilai[j] == null
        ? null : v - impor.ringkasan[i].nilai[j])),
    })),
    rekap: rekapNeraca(eksporResmi, imporResmi, tahun, bulan),
  };

  return { ekspor, impor, neraca };
}

/** Narasi AI tersimpan untuk satu provinsi/periode, dipetakan per bagian. */
export async function perdaganganNarasi(prov, tahun, bulan) {
  const rows = await safeRows(
    `SELECT bagian, narrative, provider, updated_at
     FROM perdagangan_ai_narratives
     WHERE province=$1 AND year=$2 AND month=$3`,
    [prov, tahun, bulan], 'narasi perdagangan');
  const out = {};
  for (const r of rows) {
    out[r.bagian] = {
      teks: r.narrative,
      sumber: r.provider || 'AI',
      diperbarui: r.updated_at,
    };
  }
  return out;
}

export const PERDAGANGAN_PROVINSI = ['Papua', 'Papua Selatan', 'Papua Tengah', 'Papua Pegunungan'];
