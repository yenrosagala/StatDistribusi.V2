// Apply updated country, port, and HS2 labels from BPS master files.
//
//   node scripts/apply-master-names.mjs <MASTER_DIR>
//
// Generates:
//   - negara-nama.js   (NEGARA_NAMA from master_negara_SI.xlsx)
//   - pelabuhan-nama.js (PELABUHAN from Pelabuhan_dn_*.xlsx)
// Updates:
//   - dim_perdagangan_hs2 table (from Kompile-Deskripsi BTKI202-pmk50.xlsx, sheet HS-2 Digit)

import fs from 'node:fs';
import path from 'node:path';
import * as xlsx from 'xlsx';
import { pool } from '../db.js';

const masterDir = process.argv[2];
if (!masterDir) {
  console.error('Pemakaian: node scripts/apply-master-names.mjs "<MASTER_DIR>"');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');

function readSheet(file, sheetName = null) {
  const wb = xlsx.read(fs.readFileSync(path.join(masterDir, file)), { type: 'buffer' });
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  return xlsx.utils.sheet_to_json(wb.Sheets[name], { defval: null, raw: true });
}

// ---- countries ----
const negaraRows = readSheet('master_negara_SI.xlsx');
const negaraMap = {};
for (const r of negaraRows) {
  const kode = String(r.NGRTUJUAN ?? '').trim().toUpperCase();
  if (!kode) continue;
  const nama = String(r.ngr_indo ?? r.negrtujuan ?? r.NEGARA ?? '').trim();
  if (!nama) continue;
  negaraMap[kode] = nama;
}
const negaraSorted = {};
for (const k of Object.keys(negaraMap).sort()) negaraSorted[k] = negaraMap[k];
fs.writeFileSync(
  path.join(root, 'negara-nama.js'),
  `// Nama negara menurut kode ISO2 (NGRTUJUAN / NEG_ASAL).\n`
  + `// Sumber: master_negara_SI.xlsx (kolom ngr_indo).\n`
  + `export const NEGARA_NAMA = ${JSON.stringify(negaraSorted)};\n`,
  'utf8',
);
console.log(`negara-nama.js: ${Object.keys(negaraSorted).length} negara`);

// ---- ports ----
const pelabuhanRows = readSheet('Pelabuhan_dn_15092026.xlsx');
const pelabuhanMap = {};
for (const r of pelabuhanRows) {
  const num = String(r.pod_num ?? '').trim();
  const iso = String(r.pod ?? '').trim().toUpperCase();
  const nama = String(r.nama_pod ?? '').trim();
  if (!nama) continue;
  const jenis = r.moda_trans ? String(r.moda_trans).trim() : null;
  if (num) pelabuhanMap[num] = { n: nama, j: jenis };
  if (iso) pelabuhanMap[iso] = { n: nama, j: jenis };
}
const pelabuhanSorted = {};
for (const k of Object.keys(pelabuhanMap).sort()) pelabuhanSorted[k] = pelabuhanMap[k];
fs.writeFileSync(
  path.join(root, 'pelabuhan-nama.js'),
  `// Nama pelabuhan menurut kode numerik Bea Cukai.\n`
  + `// Sumber: Pelabuhan_dn_15092026.xlsx (pod_num -> nama_pod).\n`
  + `// Regenerasi: node scripts/apply-master-names.mjs "<MASTER_DIR>"\n`
  + `// Struktur: { "<kode numerik>": { n: "<nama>", j: "<jenis>" } }\n`
  + `export const PELABUHAN = ${JSON.stringify(pelabuhanSorted)};\n\n`
  + `/** Samakan gaya penulisan dengan template BRS: "TANJUNG PERAK" -> "Tanjung Perak". */\n`
  + `export function gayaBrs(teks) {\n`
  + `  return String(teks).replace(/[A-Za-z]+/g, (kata) => (\n`
  + `    kata.length <= 3 ? kata : kata[0].toUpperCase() + kata.slice(1).toLowerCase()\n`
  + `  ));\n`
  + `}\n\n`
  + `/** Nama pelabuhan untuk satu kode; kode asli bila tidak dikenal. */\n`
  + `export function namaPelabuhan(kode) {\n`
  + `  if (kode == null) return '-';\n`
  + `  const k = String(kode).trim();\n`
  + `  if (!k) return '-';\n`
  + `  return gayaBrs(PELABUHAN[k]?.n || PELABUHAN[k.toUpperCase()]?.n || k);\n`
  + `}\n`,
  'utf8',
);
console.log(`pelabuhan-nama.js: ${Object.keys(pelabuhanSorted).length} pelabuhan`);

// ---- HS2 labels ----
const hsRows = readSheet('Kompile-Deskripsi BTKI202-pmk50.xlsx', 'HS-2 Digit');
const hsMap = new Map();
for (const r of hsRows) {
  const kode = String(r['Kode HS'] ?? '').trim().padStart(2, '0');
  const deskripsi = String(r.Deskripsi ?? '').trim();
  if (!kode || !deskripsi) continue;
  hsMap.set(kode, `${deskripsi} (HS${kode})`);
}
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('DELETE FROM dim_perdagangan_hs2');
  for (const [kode, label] of hsMap) {
    await client.query('INSERT INTO dim_perdagangan_hs2 (kode, label) VALUES ($1, $2)', [kode, label]);
  }
  await client.query('COMMIT');
  console.log(`dim_perdagangan_hs2: ${hsMap.size} labels`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}
