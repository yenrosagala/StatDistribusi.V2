// Parser DBF (dBase III) dan ETL modul Perdagangan Luar Negeri.
//
// Sumber: berkas DBF Bea Cukai / BPS ATAP, diunggah bulanan sebagai ZIP.
// Tidak memakai dependensi native: DBF dibaca langsung dari Buffer mengikuti
// spesifikasi dBase III (header 32 byte, lalu 32 byte per field descriptor,
// 0x0D sebagai penutup, kemudian record berukuran tetap).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Provinsi yang tercakup. Kode sesuai BPS. */
export const PROVINSI_PERDAGANGAN = { 94: 'Papua', 95: 'Papua Selatan', 96: 'Papua Tengah', 97: 'Papua Pegunungan' };

/**
 * Baca satu berkas DBF menjadi array objek.
 * Field teks di-decode latin-1: berkas ini memakai halaman kode Windows-1252,
 * dan nilai yang dipakai (kode angka, nama tempat berbahasa Indonesia/Inggris)
 * semuanya ASCII, jadi tidak ada karakter yang hilang.
 */
export function readDbf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    throw new Error('Berkas DBF terlalu kecil atau bukan Buffer.');
  }
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);

  const fields = [];
  for (let pos = 32; pos < headerLength - 1 && buffer[pos] !== 0x0d; pos += 32) {
    const name = buffer.subarray(pos, pos + 11).toString('ascii').split('\u0000')[0].trim();
    const type = String.fromCharCode(buffer[pos + 11]);
    const length = buffer[pos + 16];
    fields.push({ name, type, length });
  }
  if (!fields.length) throw new Error('DBF tidak memuat field descriptor.');

  const rows = [];
  for (let i = 0; i < recordCount; i += 1) {
    const offset = headerLength + i * recordLength;
    if (offset + recordLength > buffer.length) break;
    if (buffer[offset] === 0x2a) continue; // '*' = record terhapus
    const row = {};
    let cursor = offset + 1;
    for (const f of fields) {
      const raw = buffer.subarray(cursor, cursor + f.length).toString('latin1').trim();
      row[f.name] = raw;
      cursor += f.length;
    }
    rows.push(row);
  }
  return { fields, rows };
}

/** Angka dari field N DBF. Sel kosong / tidak valid -> 0. */
export function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Kolom periode impor: B<MMYY> = netto (kg), N<MMYY> = nilai (US$). */
export function importPeriod(fieldNames) {
  const bCol = fieldNames.find((n) => /^B\d{4}$/.test(n));
  if (!bCol) throw new Error('Berkas impor tidak memuat kolom periode B<MMYY>.');
  const nCol = `N${bCol.slice(1)}`;
  if (!fieldNames.includes(nCol)) throw new Error(`Kolom nilai ${nCol} tidak ditemukan.`);
  return { bulan: Number(bCol.slice(1, 3)), tahun: 2000 + Number(bCol.slice(3, 5)), bCol, nCol };
}

/** Baris ekspor DBF -> baris fact_ekspor. */
export function toEkspor(row, prov, basis) {
  const hs8 = (row.KODE_HS || '').trim();
  return {
    prov,
    tahun: Number(row.YEAR),
    bulan: Number(row.MTH),
    basis,
    hs8,
    hs2: (row.HS2 || hs8.slice(0, 2)).trim(),
    kabkota_asal: row.PROVORIG || null,
    pel_muat: row.PEL_MUAT || null,
    pelabuhan: row.PELABUHAN || null,
    negara_kode: row.NEGARA || null,
    negara_iso2: row.NGRTUJUAN || null,
    migas: /^migas$/i.test(row.KETERANGAN || '') ? 'Migas' : 'NonMigas',
    netto: num(row.NETTO),
    fob: num(row.FOB),
  };
}

/**
 * Baris impor DBF -> baris fact_impor.
 * Perhatikan: kolom B<MMYY> berisi NETTO dan N<MMYY> berisi NILAI. Nama kolomnya
 * mudah tertukar; urutannya diverifikasi terhadap berkas *_total.DBF.
 */
export function toImpor(row, prov, basis, period) {
  const hs8 = (row.HS || '').trim();
  return {
    prov,
    tahun: period.tahun,
    bulan: period.bulan,
    basis,
    tipe: row.TIPE || null,
    jenis: row.JENIS || null,
    migas: row.JENIS === 'NM' ? 'NonMigas' : 'Migas',
    hs8,
    hs2: hs8.slice(0, 2),
    negara_kode: row.K_NEGARA || null,
    negara_iso2: row.NEG_ASAL || null,
    pelabuhan: row.K_PELB || null,
    pel_un: row.PEL_BONG || null,
    kppbc: row.KPPBC || null,
    nama_kppbc: row.NAMA_KPPBC || null,
    netto: num(row[period.bCol]),
    cif: num(row[period.nCol]),
  };
}
