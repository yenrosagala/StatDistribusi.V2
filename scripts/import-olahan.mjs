/**
 * Impor tabel "olahan" 2025 (agregat terbit BRS) ke tabel perdagangan_olahan.
 *
 * Sumber: ZIP berisi "<kode>. Olahan <Ekspor|Impor> <Provinsi> 2025.xlsx", satu
 * sheet per bulan. Tiap sheet memuat tabel BRS yang sudah jadi:
 *   Tabel 1 Ringkasan  -> dimensi 'ringkasan' (Total / Migas / Non Migas)
 *   Tabel 2 HS 2 digit -> dimensi 'hs2'      (memuat baris sisa "Non Migas Lainnya")
 *   Tabel 3 Negara     -> dimensi 'negara'   (memuat "Lainnya")
 *   Tabel 4 Pelabuhan  -> dimensi 'pelabuhan'(memuat "Lainnya")
 *
 * Angka diambil dari blok satuan Ribu US$ (blok pertama tiap tabel); blok kedua
 * di sheet yang sama berisi nilai US$ penuh (1000x) dan sengaja dilewati.
 *
 * Pemakaian:
 *   node scripts/import-olahan.mjs "<folder hasil ekstrak ZIP>"
 */
import fs from 'node:fs';
import path from 'node:path';
import * as xlsx from 'xlsx';
import { pool } from '../db.js';

const BULAN = {
  jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7,
  ags: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12,
};
const PROV = { 94: 'Papua', 95: 'Papua Selatan', 96: 'Papua Tengah', 97: 'Papua Pegunungan' };

/** Judul tabel -> dimensi. */
function dimensiDariJudul(judul) {
  const j = judul.toLowerCase();
  if (j.includes('ringkasan')) return 'ringkasan';
  if (j.includes('golongan hs')) return 'hs2';
  if (j.includes('negara')) return 'negara';
  if (j.includes('pelabuhan')) return 'pelabuhan';
  return null;
}

function bulanDariSheet(nama) {
  const m = /^([A-Za-z]{3})/.exec(String(nama).trim());
  if (!m) return null;
  return BULAN[m[1].toLowerCase()] || null;
}

/** "   Kayu & Barang dari Kayu (HS44)" -> '44'; selain itu teks apa adanya. */
function kodeDariLabel(label, dimensi) {
  const teks = String(label).replace(/^\s+/, '').trim();
  if (dimensi === 'hs2') {
    const m = /\(HS(\d{2})\)/i.exec(teks);
    if (m) return m[1];
  }
  if (dimensi === 'ringkasan') {
    if (/^total/i.test(teks)) return 'Total';
    if (/^non\s*migas$/i.test(teks)) return 'Non Migas';
    if (/^migas$/i.test(teks)) return 'Migas';
  }
  return teks;
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS perdagangan_olahan (
      id bigserial PRIMARY KEY,
      prov text NOT NULL,
      arus text NOT NULL,
      dimensi text NOT NULL,
      kode text NOT NULL,
      tahun integer NOT NULL,
      bulan integer NOT NULL,
      nilai double precision NOT NULL,
      UNIQUE (prov, arus, dimensi, kode, tahun, bulan));
    CREATE INDEX IF NOT EXISTS perdagangan_olahan_cari
      ON perdagangan_olahan (prov, arus, dimensi, tahun, bulan);`);
}

/** Ambil baris data satu tabel: label di kolom 0, nilai di kolom 3 (Ribu US$). */
function bacaTabel(rows, mulai, selesai) {
  const hasil = [];
  let sudahHeader = false;
  for (let i = mulai + 1; i < selesai; i += 1) {
    const r = rows[i] || [];
    const label = String(r[0] ?? '').trim();
    if (!label) continue;
    // Header blok kedua ("ATAP ...", "Uraian", "Gol Barang...") menandai akhir
    // blok Ribu US$; blok US$ penuh tidak diambil.
    if (/^ATAP/i.test(label) || /^uraian$/i.test(label) || /^gol barang/i.test(label)
        || /^negara$/i.test(label) || /^pelabuhan$/i.test(label) || /^keterangan/i.test(label)) {
      if (sudahHeader) break;
      sudahHeader = true;
      continue;
    }
    const nilai = r[3];
    if (typeof nilai !== 'number' || !Number.isFinite(nilai)) continue;
    // Sel tahun (2024/2025/2026) ikut terbaca sebagai angka pada baris header;
    // nilainya persis tahun dan bukan nilai rupiah.
    if (nilai >= 1900 && nilai <= 2100 && Number.isInteger(nilai)) continue;
    sudahHeader = true;
    hasil.push({ label, nilai });
  }
  return hasil;
}

function parseBerkas(berkas) {
  const nama = path.basename(berkas);
  const kode = (/^(\d{2})\./.exec(nama) || [])[1];
  const prov = PROV[kode];
  if (!prov) return null;
  const arus = /impor/i.test(nama) ? 'impor' : 'ekspor';

  const wb = xlsx.read(fs.readFileSync(berkas), { type: 'buffer' });
  const baris = [];
  for (const sheet of wb.SheetNames) {
    const bulan = bulanDariSheet(sheet);
    if (!bulan) continue;
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, blankrows: false, defval: null });
    // Posisi judul tiap tabel.
    const judul = [];
    rows.forEach((r, i) => {
      if (/^Tabel\s+\d/i.test(String(r[0] ?? ''))) judul.push({ i, teks: String(r[0]) });
    });
    // Sheet memuat blok Ribu US$ lalu blok US$ penuh dengan label yang sama.
    // Ambil kemunculan pertama saja (blok Ribu US$).
    const terpakai = new Set();
    for (let k = 0; k < judul.length; k += 1) {
      const dimensi = dimensiDariJudul(judul[k].teks);
      if (!dimensi) continue;
      const selesai = k + 1 < judul.length ? judul[k + 1].i : rows.length;
      for (const { label, nilai } of bacaTabel(rows, judul[k].i, selesai)) {
        const kode = kodeDariLabel(label, dimensi);
        if (dimensi === 'hs2' && /^(non\s*migas|migas|jumlah)$/i.test(String(kode))) continue;
        const kunci = `${dimensi}|${kode}`;
        if (terpakai.has(kunci)) continue;
        terpakai.add(kunci);
        baris.push({ prov, arus, dimensi, kode, tahun: 2025, bulan, nilai });
      }
    }
  }
  return { prov, arus, baris };
}

async function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) {
    console.error('Pemakaian: node scripts/import-olahan.mjs "<folder hasil ekstrak ZIP>"');
    process.exit(2);
  }
  await ensureTable();
  const berkas = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xlsx'));
  let total = 0;

  for (const f of berkas) {
    const hasil = parseBerkas(path.join(dir, f));
    if (!hasil || !hasil.baris.length) {
      console.log(`\n${f}: tidak ada baris dikenali`);
      continue;
    }
    const { prov, arus, baris } = hasil;
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM perdagangan_olahan WHERE prov=$1 AND arus=$2 AND tahun=2025',
        [prov, arus]);
      const kolom = ['prov', 'arus', 'dimensi', 'kode', 'tahun', 'bulan', 'nilai'];
      for (let i = 0; i < baris.length; i += 400) {
        const potong = baris.slice(i, i + 400);
        const nilai = [];
        const params = [];
        potong.forEach((r, ri) => {
          nilai.push(`(${kolom.map((_, ci) => `$${ri * kolom.length + ci + 1}`).join(',')})`);
          kolom.forEach((c) => params.push(r[c]));
        });
        await pool.query(`INSERT INTO perdagangan_olahan (${kolom.join(',')}) VALUES ${nilai.join(',')}`, params);
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
    total += baris.length;
    const per = {};
    for (const r of baris) per[r.dimensi] = (per[r.dimensi] || 0) + 1;
    console.log(`\n${f}`);
    console.log(`  ${prov} / ${arus}: ${baris.length} baris  `
      + Object.entries(per).map(([d, n]) => `${d}=${n}`).join(' '));

    // Rekonsiliasi: jumlah tiap dimensi per bulan harus = Total (ringkasan).
    const cek = await pool.query(`
      SELECT bulan,
             SUM(CASE WHEN dimensi='ringkasan' AND kode='Total' THEN nilai END) AS total,
             SUM(CASE WHEN dimensi='hs2' THEN nilai END) AS hs2,
             SUM(CASE WHEN dimensi='negara' THEN nilai END) AS negara,
             SUM(CASE WHEN dimensi='pelabuhan' THEN nilai END) AS pelabuhan
        FROM perdagangan_olahan
       WHERE prov=$1 AND arus=$2 AND tahun=2025
       GROUP BY bulan ORDER BY bulan`, [prov, arus]);
    const beda = cek.rows.filter((r) => {
      const t = Number(r.total || 0);
      let galat = 0;
      for (const k of ['hs2', 'negara', 'pelabuhan']) {
        if (r[k] == null) continue;
        if (Math.abs(Number(r[k]) - t) > 0.05) galat += 1;
      }
      return galat > 0;
    });
    console.log(beda.length
      ? `  REKONSILIASI: ${beda.length} bulan tidak cocok -> ${JSON.stringify(beda.slice(0, 2))}`
      : '  rekonsiliasi: jumlah tiap dimensi = Total pada semua bulan');
  }

  console.log(`\nselesai: ${total} baris dari ${berkas.length} berkas`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('impor gagal:', err.message);
  try { await pool.end(); } catch { /* sudah tertutup */ }
  process.exit(1);
});
