// Regenerasi pelabuhan-nama.js dari berkas master pelabuhan Bea Cukai.
//
//   node scripts/gen-pelabuhan.mjs "<path Master Pelabuhan Dalam Negeri ....xls>"
//
// Berkas master berada di luar repo aplikasi, jadi isinya disalin ke
// pelabuhan-nama.js agar runtime tidak bergantung pada Excel.
import * as xlsx from 'xlsx';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('Pemakaian: node scripts/gen-pelabuhan.mjs "<path Master Pelabuhan ....xls>"');
  process.exit(2);
}

const wb = xlsx.read(readFileSync(src), { type: 'buffer' });
const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: true });
const map = {};
for (const r of rows) {
  const kode = r['Kode Pelabuhan Numerik'];
  const nama = r['Nama Pelabuhan'];
  if (kode == null || !nama) continue;
  const k = String(kode).trim();
  if (!k) continue;
  map[k] = { n: String(nama).trim(), j: r['Jenis'] ? String(r['Jenis']).trim() : null };
}
const keys = Object.keys(map).sort();
if (!keys.length) {
  console.error('Tidak ada pelabuhan yang terbaca. Periksa nama kolom di berkas.');
  process.exit(1);
}

const sorted = {};
for (const k of keys) sorted[k] = map[k];

const out = path.resolve(import.meta.dirname, '..', 'pelabuhan-nama.js');
const isi = `// Nama pelabuhan menurut kode numerik Bea Cukai.
//
// Sumber: "Master Pelabuhan Dalam Negeri 03-06-2024.xls" (${keys.length} kode). Berkas itu
// berada di luar repo aplikasi, jadi isinya disalin ke sini agar halaman dan
// ekspor tidak bergantung pada berkas Excel saat runtime.
//
// Regenerasi: node scripts/gen-pelabuhan.mjs "<path Master Pelabuhan ... .xls>"
//
// Struktur: { "<kode numerik>": { n: "<nama>", j: "<jenis>" } }
export const PELABUHAN = ${JSON.stringify(sorted)};

/** Nama pelabuhan untuk satu kode; kode asli bila tidak dikenal. */
export function namaPelabuhan(kode) {
  if (kode == null) return '-';
  const k = String(kode).trim();
  if (!k) return '-';
  return PELABUHAN[k]?.n || k;
}
`;
writeFileSync(out, isi, 'utf8');
console.log(`Ditulis ${out} dengan ${keys.length} pelabuhan.`);
