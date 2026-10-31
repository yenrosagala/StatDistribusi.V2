/**
 * Audit lintas permukaan: bandingkan angka modul Perdagangan pada tiga keluaran.
 *
 *   web  : fungsi kueri yang dipakai halaman Laporan (perdagangan.js)
 *   excel: UNDUH XLSX lewat export.js (sheet "Ringkasan Ekspor/Impor")
 *   idml : UNDUH IDML lewat export.js (tabel u103b / u11ed / ud37)
 *
 * Tujuannya menangkap kelas bug yang selama ini hanya ketemu manual: struktur
 * tabel salah, basis angka tertukar, satuan berbeda, atau kolom tidak terisi.
 *
 * Pemakaian:
 *   node scripts/audit-surfaces.mjs                      # Papua 2026 Agustus
 *   node scripts/audit-surfaces.mjs "Papua Selatan" 2026 9
 *
 * Keluar dengan kode 1 bila ada selisih di luar toleransi pembulatan.
 */
import * as xlsx from 'xlsx';
import { perdaganganLaporan } from '../perdagangan.js';
import { runExport } from '../export.js';
import { readZip } from '../zip-reader.js';
import { pool } from '../db.js';

const MONTH_NAMES = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
  'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const prov = process.argv[2] || 'Papua';
const tahun = Number(process.argv[3] || 2026);
const bulan = Number(process.argv[4] || 8);
const namaBulan = MONTH_NAMES[bulan - 1];
const TOLERANSI = 0.011; // angka dibulatkan 2 desimal di semua permukaan

/** "6.961,79" / "1.234,5" -> 6961.79 */
function angkaId(teks) {
  if (teks == null) return null;
  const bersih = String(teks).trim().replace(/\./g, '').replace(',', '.');
  if (!bersih || bersih === '-') return null;
  const n = Number(bersih);
  return Number.isFinite(n) ? n : null;
}

function fmt(v) {
  if (v == null) return '-';
  return v.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Nilai satu sel tabel IDML: <Cell Name="x:y"> ... <Content>teks</Content> ... */
function selIdml(xml, x, y) {
  const re = new RegExp(`<Cell\\b[^>]*Name="${x}:${y}"[^>]*>([\\s\\S]*?)</Cell>`);
  const m = re.exec(xml);
  if (!m) return null;
  return [...m[1].matchAll(/<Content[^>]*>([^<]*)<\/Content>/g)]
    .map((c) => c[1]).join('').trim();
}

/** Baris total dari sheet Ringkasan Excel: kolom 3 = bulan ini, 5 = YTD. */
function totalSheet(wb, namaSheet) {
  const ws = wb.Sheets[namaSheet];
  if (!ws) return null;
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
  const total = rows.find((r) => String(r[0] || '').toLowerCase().startsWith('total'));
  if (!total) return null;
  return { now: total[3], kum: total[5] };
}

async function dariWeb() {
  const laporan = await perdaganganLaporan(prov, tahun, bulan);
  const n = (rows) => ({ now: rows?.nilai?.[2] ?? null, kum: rows?.nilai?.[4] ?? null });
  const neracaRow = (laporan.neraca.ringkasan || []).find((r) => /^neraca/i.test(r.label));
  return {
    ekspor: n(laporan.ekspor.ringkasan[0]),
    impor: n(laporan.impor.ringkasan[0]),
    neraca: n(neracaRow),
  };
}

async function dariExcel() {
  const data = await runExport('xlsx-perdagangan', { prov, thn: tahun, bln: namaBulan });
  const wb = xlsx.read(data, { type: 'buffer' });
  const e = totalSheet(wb, 'Ringkasan Ekspor');
  const i = totalSheet(wb, 'Ringkasan Impor');
  const neracaSheet = wb.Sheets.Neraca
    ? xlsx.utils.sheet_to_json(wb.Sheets.Neraca, { header: 1, blankrows: false, defval: null })
    : [];
  const barisNeraca = neracaSheet.find((r) => /^neraca/i.test(String(r[0] || '')));
  return {
    ekspor: e ? { now: e.now, kum: e.kum } : null,
    impor: i ? { now: i.now, kum: i.kum } : null,
    neraca: barisNeraca ? { now: barisNeraca[3], kum: barisNeraca[5] } : null,
  };
}

async function dariIdml() {
  const zip = await runExport('idml-exim', { prov, thn: tahun, bln: namaBulan });
  const entri = new Map(readZip(zip).map((e) => [e.name, e.buffer]));
  const idmlNama = [...entri.keys()].find((n) => n.endsWith('.idml'));
  if (!idmlNama) throw new Error('Paket tidak memuat berkas .idml.');
  const dalam = new Map(readZip(entri.get(idmlNama)).map((e) => [e.name, e.buffer]));
  const baca = (sid) => (dalam.get(`Stories/Story_${sid}.xml`) || Buffer.alloc(0)).toString('utf8');

  const u103b = baca('u103b'); // Ringkasan Ekspor: baris 3 = Total Ekspor
  const u11ed = baca('u11ed'); // Ringkasan Impor: baris 3 = Total Impor
  const ud37 = baca('ud37');   // Neraca: baris 5 = Neraca Perdagangan
  return {
    ekspor: { now: angkaId(selIdml(u103b, 3, 3)), kum: angkaId(selIdml(u103b, 5, 3)) },
    impor: { now: angkaId(selIdml(u11ed, 3, 3)), kum: angkaId(selIdml(u11ed, 5, 3)) },
    neraca: { now: angkaId(selIdml(ud37, 3, 5)), kum: angkaId(selIdml(ud37, 5, 5)) },
  };
}

async function main() {
  console.log(`Audit permukaan Perdagangan — ${prov}, ${namaBulan} ${tahun}\n`);
  // Berurutan, bukan paralel: dua ekspor dokumen yang berjalan bersamaan memakai
  // matplotlib dan bisa saling mengganggu (pernah menghasilkan Excel 0 semua).
  const web = await dariWeb();
  const excel = await dariExcel();
  const idml = await dariIdml();

  const baris = [
    ['Ekspor bulan ini', web.ekspor?.now, excel.ekspor?.now, idml.ekspor?.now],
    ['Ekspor YTD', web.ekspor?.kum, excel.ekspor?.kum, idml.ekspor?.kum],
    ['Impor bulan ini', web.impor?.now, excel.impor?.now, idml.impor?.now],
    ['Impor YTD', web.impor?.kum, excel.impor?.kum, idml.impor?.kum],
    ['Neraca bulan ini', web.neraca?.now, excel.neraca?.now, idml.neraca?.now],
    ['Neraca YTD', web.neraca?.kum, excel.neraca?.kum, idml.neraca?.kum],
  ];

  console.log('metrik              web          excel        idml         status');
  console.log('-------------------------------------------------------------------------');
  let gagal = 0;
  for (const [label, w, e, i] of baris) {
    const nilai = [w, e, i].map((v) => (v == null ? null : Number(v)));
    const ada = nilai.filter((v) => v != null);
    let status = 'ok';
    if (nilai.some((v) => v == null)) status = 'ADA YANG KOSONG';
    else {
      const maks = Math.max(...ada);
      const min = Math.min(...ada);
      if (maks - min > TOLERANSI) status = `BEDA ${fmt(maks - min)}`;
    }
    if (status !== 'ok') gagal += 1;
    console.log(
      `${label.padEnd(19)} ${fmt(w).padStart(11)} ${fmt(e).padStart(12)} ${fmt(i).padStart(12)}  ${status}`,
    );
  }

  if (gagal) {
    console.log(`\nHASIL: ${gagal} metrik tidak konsisten antar permukaan`);
  } else {
    console.log('\nHASIL: web, Excel, dan IDML konsisten');
  }
  await pool.end();
  process.exit(gagal ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`audit gagal: ${err.message}`);
  try { await pool.end(); } catch { /* sudah tertutup */ }
  process.exit(2);
});
