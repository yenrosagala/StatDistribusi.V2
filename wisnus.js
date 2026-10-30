// ETL + kueri data Wisnus (Wisatawan Nusantara) per kabupaten/kota.
//
// Sumber: berkas Excel bulanan BPS "Prov <kode> Wisnus <tahun>-M<bb>.xlsx".
// Dua sheet yang dipakai:
//   "Series Home KabKota"   -> perjalanan menurut kab/kota ASAL
//   "Series Tujuan KabKota" -> perjalanan menurut kab/kota TUJUAN
// Keduanya berbentuk matriks: baris = kab/kota, kolom = bulan sejak Jan 2019,
// ditutup satu baris "Total". Baris Total tidak disimpan karena bisa dihitung
// ulang dari rincian (dan sudah diperiksa cocok dengan angka rilis BRS).
import * as xlsx from 'xlsx';
import { pool } from './db.js';

/** Nama sheet -> nilai kolom `arah` di database. */
export const SHEET_WISNUS = {
  'series home kabkota': 'asal',
  'series tujuan kabkota': 'tujuan',
};

const BULAN = {
  // "Ags" adalah singkatan BPS untuk Agustus; berkas memakai ketiganya
  // (Ags.'25 untuk 2025, Aug '26 untuk 2026, Agt di tahun lain).
  jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7,
  ags: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12,
};

/** "Jan.'19" atau "Sep '26" -> { tahun, bulan }; selain pola itu -> null. */
export function bacaKolomBulan(label) {
  const m = /^([A-Za-z]{3})\.?'?\s*'?(\d{2})$/.exec(String(label || '').trim());
  if (!m) return null;
  const bulan = BULAN[m[1].toLowerCase()];
  if (!bulan) return null;
  return { bulan, tahun: 2000 + Number(m[2]) };
}

export async function ensureWisnus() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wisnus_series (
      id bigserial PRIMARY KEY,
      prov text NOT NULL,
      arah text NOT NULL,
      kode_kab text NOT NULL,
      nama_kab text NOT NULL,
      tahun integer NOT NULL,
      bulan integer NOT NULL,
      jumlah integer NOT NULL,
      UNIQUE (prov, arah, kode_kab, tahun, bulan));
    CREATE INDEX IF NOT EXISTS wisnus_series_periode ON wisnus_series (prov, tahun, bulan);
    CREATE INDEX IF NOT EXISTS wisnus_series_arah ON wisnus_series (prov, arah, tahun);`);
}

/** Ambil baris {kode_kab, nama_kab, bulan:[{tahun,bulan,jumlah}]} dari satu sheet. */
function bacaSheet(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
  if (!rows.length) return [];
  const kepala = rows[0];
  const kolom = [];
  kepala.forEach((label, i) => {
    const b = bacaKolomBulan(label);
    if (b) kolom.push({ ...b, i });
  });
  const hasil = [];
  for (const r of rows.slice(1)) {
    const kode = r[0] == null ? '' : String(r[0]).trim();
    const nama = r[1] == null ? '' : String(r[1]).trim();
    // Baris "Total" tidak punya kode; rincian kab/kota selalu berkode angka.
    if (!/^\d+$/.test(kode)) continue;
    const nilai = kolom
      .map(({ i, tahun, bulan }) => ({ tahun, bulan, jumlah: Number(r[i]) || 0 }))
      .filter((x) => x.jumlah > 0);
    if (nilai.length) hasil.push({ kode_kab: kode, nama_kab: nama.replace(/^PAPUA--/, ''), nilai });
  }
  return hasil;
}

/**
 * Parse satu berkas Excel Wisnus menjadi baris siap simpan.
 * Kembalikan { baris, ringkas, periode }.
 */
export function parseWisnusWorkbook(buffer, prov) {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const baris = [];
  const ringkas = {};
  const periode = new Set();

  for (const [namaSheet, arah] of Object.entries(SHEET_WISNUS)) {
    const asli = wb.SheetNames.find((n) => n.toLowerCase() === namaSheet);
    if (!asli) continue;
    const kab = bacaSheet(wb.Sheets[asli]);
    let jumlahBaris = 0;
    for (const k of kab) {
      for (const v of k.nilai) {
        baris.push({
          prov, arah, kode_kab: k.kode_kab, nama_kab: k.nama_kab,
          tahun: v.tahun, bulan: v.bulan, jumlah: v.jumlah,
        });
        periode.add(`${v.tahun}-${v.bulan}`);
        jumlahBaris += 1;
      }
    }
    ringkas[arah] = { sheet: asli, kabkota: kab.length, baris: jumlahBaris };
  }

  if (!baris.length) {
    throw new Error(`Tidak ada sheet "Series Home KabKota"/"Series Tujuan KabKota" berisi data `
      + `(sheet yang ada: ${wb.SheetNames.join(', ')}).`);
  }
  const daftar = [...periode].sort();
  return { baris, ringkas, periode: daftar };
}

/** Simpan hasil parse: periode & provinsi yang sama diganti, bukan ditambah. */
export async function saveWisnus(prov, hasil, sumber = '') {
  await ensureWisnus();
  const klien = await pool.connect();
  try {
    await klien.query('BEGIN');
    for (const p of hasil.periode) {
      const [tahun, bulan] = p.split('-').map(Number);
      await klien.query('DELETE FROM wisnus_series WHERE prov=$1 AND tahun=$2 AND bulan=$3',
        [prov, tahun, bulan]);
    }
    const kolom = ['prov', 'arah', 'kode_kab', 'nama_kab', 'tahun', 'bulan', 'jumlah'];
    const per = 500;
    for (let i = 0; i < hasil.baris.length; i += per) {
      const potong = hasil.baris.slice(i, i + per);
      const nilai = [];
      const params = [];
      potong.forEach((r, ri) => {
        nilai.push(`(${kolom.map((_, ci) => `$${ri * kolom.length + ci + 1}`).join(',')})`);
        kolom.forEach((c) => params.push(r[c]));
      });
      await klien.query(`INSERT INTO wisnus_series (${kolom.join(',')}) VALUES ${nilai.join(',')}`,
        params);
    }
    await klien.query('COMMIT');
    return { baris: hasil.baris.length, periode: hasil.periode };
  } catch (err) {
    try { await klien.query('ROLLBACK'); } catch { /* sudah batal */ }
    throw err;
  } finally {
    klien.release();
  }
}

/** Bulan (1..12) yang punya data untuk provinsi & tahun tertentu. */
export async function wisnusBulanTersedia(prov, tahun) {
  const { rows } = await pool.query(
    `SELECT DISTINCT bulan FROM wisnus_series
      WHERE prov=$1 AND arah='tujuan' AND tahun=$2 ORDER BY 1`, [prov, tahun]);
  return rows.map((r) => Number(r.bulan));
}

/** "JAYAPURA" + kode 9471 -> "Kota Jayapura"; 9403 -> "Kabupaten Jayapura". */
export function labelKabkota(kode, nama) {
  const bersih = String(nama || kode).replace(/^PAPUA--/, '');
  const judul = bersih.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const kota = Number(String(kode).slice(-2)) >= 71;
  return `${kota ? 'Kota' : 'Kabupaten'} ${judul}`;
}

/**
 * Data untuk halaman Wisnus:
 *  - seri   : total perjalanan per bulan (arah 'tujuan') tahun lalu & tahun ini
 *  - tujuan : rincian kab/kota tujuan, kumulatif Jan..bulan
 */
export async function wisnusRekap(prov, tahun, bulan) {
  const seri = await pool.query(`
    SELECT tahun, bulan, SUM(jumlah)::bigint AS jumlah
      FROM wisnus_series
     WHERE prov=$1 AND arah='tujuan' AND tahun IN ($2, $3) AND bulan <= $4
     GROUP BY tahun, bulan ORDER BY tahun, bulan`,
    [prov, tahun, tahun - 1, bulan]);

  const tujuan = await pool.query(`
    SELECT kode_kab, nama_kab, SUM(jumlah)::bigint AS jumlah
      FROM wisnus_series
     WHERE prov=$1 AND arah='tujuan' AND tahun=$2 AND bulan <= $3
     GROUP BY kode_kab, nama_kab ORDER BY 3 DESC`,
    [prov, tahun, bulan]);

  const bulanIni = await pool.query(`
    SELECT SUM(jumlah)::bigint AS jumlah FROM wisnus_series
     WHERE prov=$1 AND arah='tujuan' AND tahun=$2 AND bulan=$3`,
    [prov, tahun, bulan]);

  const totalKum = tujuan.rows.reduce((a, r) => a + Number(r.jumlah), 0);
  return {
    seri: seri.rows.map((r) => ({ tahun: Number(r.tahun), bulan: Number(r.bulan), jumlah: Number(r.jumlah) })),
    tujuan: tujuan.rows.map((r) => ({
      kode: r.kode_kab,
      // Kode 9471 dan 9403 sama-sama bernama "JAYAPURA" di berkas; dua digit
      // terakhir >= 71 menandai kota, sisanya kabupaten.
      nama: labelKabkota(r.kode_kab, r.nama_kab),
      jumlah: Number(r.jumlah),
      peran: totalKum ? (Number(r.jumlah) / totalKum) * 100 : 0,
    })),
    bulanIni: bulanIni.rows[0]?.jumlah ? Number(bulanIni.rows[0].jumlah) : 0,
    totalKum,
    bulanTersedia: await wisnusBulanTersedia(prov, tahun),
  };
}
