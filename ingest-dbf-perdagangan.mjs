// Ingest DBF files from a folder into fact_ekspor / fact_impor.
//
// Usage:
//   node ingest-dbf-perdagangan.mjs <DBF_ROOT> [--dry-run]
//
// This script is intentionally independent from etl-perdagangan.js: it handles
// the raw DBF exports that BPS sends (monthly and multi-period) and replaces
// rows per (province, year, month, basis) instead of wiping whole periods.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
import { readDbf, num, PROVINSI_PERDAGANGAN } from './dbf-perdagangan.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ROOTS = args.length ? args : ['C:\\Users\\yenro\\Downloads\\DBF-20261102T012951Z-1-001\\DBF'];
const DRY_RUN = process.argv.includes('--dry-run');

const PROV_BY_CODE = new Map(
  Object.entries(PROVINSI_PERDAGANGAN).map(([k, v]) => [String(k), v]),
);

const eksporMap = new Map(); // key -> { priority, rows, source }
const imporMap = new Map();
const processedAllPapua = new Set();
const warnings = [];

function provFromFolder(folderName) {
  const m = /^(9[4-7])\s+(.+)$/.exec(folderName);
  if (!m) return null;
  return PROV_BY_CODE.get(m[1]) || null;
}

function provFromCode(code) {
  return PROV_BY_CODE.get(String(code)) || null;
}

function keyOf(prov, tahun, bulan, basis) {
  return `${prov}|${tahun}|${bulan}|${basis}`;
}

function setRows(map, prov, tahun, bulan, basis, priority, source, rows) {
  if (!prov || !Number.isInteger(Number(tahun)) || !Number.isInteger(Number(bulan))) return;
  const key = keyOf(prov, Number(tahun), Number(bulan), basis);
  const cur = map.get(key);
  if (cur) {
    if (cur.priority < priority) return; // existing source wins
    if (cur.priority === priority) {
      if (cur.source === source) {
        cur.rows.push(...rows);
      }
      return; // same priority, different source: keep first
    }
    // new priority is better -> replace
  }
  map.set(key, { priority, source, rows: [...rows] });
}

function hs2Of(row, hs8) {
  const raw = (row.HS2 || '').trim();
  if (raw) return raw;
  return String(hs8 || '').slice(0, 2);
}

function migasFromKeterangan(keterangan) {
  const v = String(keterangan || '').trim().toLowerCase();
  return v.includes('migas') && !v.includes('nonmigas') ? 'Migas' : 'NonMigas';
}

/**
 * Extract (tahun, bulan) from a row or fall back to the filename.
 * Some BPS DBF files have swapped/abbreviated THN_PROSES/BLN_PROSES columns
 * (e.g. 94_06_2025 carries BLN_PROSES=20, THN_PROSES=06), so the filename is
 * the safer source when the fields do not look like a real period.
 */
function periodFromRow(r, base) {
  const thn = String(r.THN_PROSES || r.YEAR || '').trim();
  const bln = String(r.BLN_PROSES || r.MTH || '').trim();
  let tahun = null;
  let bulan = null;

  if (/^\d{4}$/.test(thn) && Number(thn) >= 2000) tahun = Number(thn);
  else if (/^\d{4}$/.test(bln) && Number(bln) >= 2000) tahun = Number(bln);

  if (/^\d{1,2}$/.test(bln) && Number(bln) >= 1 && Number(bln) <= 12) bulan = Number(bln);
  else if (/^\d{1,2}$/.test(thn) && Number(thn) >= 1 && Number(thn) <= 12) bulan = Number(thn);

  if (!tahun || !bulan) {
    // _94_06_2025, _94_001_2025, _94_04_025_rev
    const m = /_(\d{1,3})_(\d{2,4})(?:_rev)?\.dbf$/i.exec(base);
    if (m) {
      const mm = Number(m[1]);
      const yy = m[2];
      if (mm >= 1 && mm <= 12 && yy.length >= 2) {
        bulan = mm;
        tahun = yy.length === 4 ? Number(yy) : 2000 + Number(yy);
      }
    }
  }

  if (!tahun) {
    const m = /(\d{4})/.exec(base);
    if (m) tahun = Number(m[1]);
  }

  return { tahun, bulan };
}

function numOrZero(v) {
  return num(v);
}

async function* walkDbf(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkDbf(full);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.dbf')) {
      yield full;
    }
  }
}

async function processFile(filePath, folderProv) {
  const base = path.basename(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);
  if (buf.length < 32) return;
  let parsed;
  try {
    parsed = readDbf(buf);
  } catch {
    return;
  }
  const { fields, rows } = parsed;
  if (!rows.length) return;
  const fieldNames = fields.map((f) => f.name);

  // ---- all-province files: only process once, carry province per row ----
  const isAllPapua = /all_papua/i.test(base);
  if (isAllPapua && processedAllPapua.has(path.basename(base))) return;
  if (isAllPapua) processedAllPapua.add(path.basename(base));

  const source = path.basename(filePath);

  // ================= EXPORTS =================

  // Revisi ekspor 2025 (PROVORIG / POD based, multi-month)
  if (/revisi_ekspor_\d{4}_(provorig|pod)_based/i.test(base)) {
    const basis = /provorig_based/i.test(base) ? 'PROVORIG' : 'POD';
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    for (const r of rows) {
      const { tahun, bulan } = periodFromRow(r, base);
      if (!tahun || !bulan) continue;
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, tahun, bulan, basis, 1, source, [{
        prov, tahun, bulan, basis,
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: (r.PEL_MUAT || '').trim() || null,
        pelabuhan: basis === 'POD' ? ((r.PEL_MUAT || '').trim() || null) : ((r.PELABUHAN || '').trim() || null),
        negara_kode: (r.NEGARA || '').trim() || null,
        negara_iso2: (r.NGRTUJUAN || '').trim() || null,
        migas: migasFromKeterangan(r.KETERANGAN),
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // Revisi Jan-Des2023-2024 Ekspor HS Prop (full 2024, revised)
  if (/^revisi_jan-des2023-2024_ekspor_hs_prop_9[4-7]\.dbf$/i.test(base)) {
    for (const r of rows) {
      if (String(r.YEAR) !== '2024') continue;
      const prov = folderProv;
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, 2024, Number(r.MTH), 'PROVORIG', 1, source, [{
        prov, tahun: 2024, bulan: Number(r.MTH), basis: 'PROVORIG',
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: (r.PEL_MUAT || '').trim() || null,
        pelabuhan: (r.PODAL5 || '').trim() || null,
        negara_kode: (r.NEWCTRYCOD || '').trim() || null,
        negara_iso2: (r.NGRTUJUAN || '').trim() || null,
        migas: migasFromKeterangan(r.KETERANGAN),
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // ASEM MIGAS-NONMIGAS PROVORIG (monthly 2024-2025)
  if (/asem_migas-nonmigas_provorig_/i.test(base)) {
    for (const r of rows) {
      const { tahun, bulan } = periodFromRow(r, base);
      if (!tahun || !bulan) continue;
      const prov = folderProv;
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, tahun, bulan, 'PROVORIG', 2, source, [{
        prov, tahun, bulan, basis: 'PROVORIG',
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: (r.PEL_MUAT || '').trim() || null,
        pelabuhan: (r.PELABUHAN || '').trim() || null,
        negara_kode: (r.NEGARA || '').trim() || null,
        negara_iso2: (r.NGRTUJUAN || '').trim() || null,
        migas: migasFromKeterangan(r.KETERANGAN),
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // ASEM EXP MIGAS-NONMIGAS (fallback provorigin)
  if (/asem_exp_migas-nonmigas_/i.test(base)) {
    for (const r of rows) {
      const { tahun, bulan } = periodFromRow(r, base);
      if (!tahun || !bulan) continue;
      const prov = folderProv;
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, tahun, bulan, 'PROVORIG', 10, source, [{
        prov, tahun, bulan, basis: 'PROVORIG',
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: (r.PEL_MUAT || '').trim() || null,
        pelabuhan: (r.PELABUHAN || '').trim() || null,
        negara_kode: (r.NEGARA || '').trim() || null,
        negara_iso2: (r.NGRTUJUAN || '').trim() || null,
        migas: migasFromKeterangan(r.KETERANGAN),
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // Indag Ekspor HS Prop / PropAsal (fallback, migas unknown)
  if (/indagekspor_hs_prop_/i.test(base) || /indagekspor_propasal_/i.test(base)) {
    warnings.push(`${source}: KETERANGAN missing, migas defaulted to NonMigas`);
    for (const r of rows) {
      const { tahun, bulan } = periodFromRow(r, base);
      if (!tahun || !bulan) continue;
      const prov = folderProv;
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, tahun, bulan, 'PROVORIG', 10, source, [{
        prov, tahun, bulan, basis: 'PROVORIG',
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: null,
        pelabuhan: (r.PELABUHAN || '').trim() || null,
        negara_kode: (r.NEGARA || '').trim() || null,
        negara_iso2: null,
        migas: 'NonMigas',
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // pelmuat_all_papua (POD basis, all provinces, Jan 2024 - Mar 2025)
  if (/pelmuat_all_papua_/i.test(base)) {
    warnings.push(`${source}: KETERANGAN missing, migas defaulted to NonMigas (POD basis)`);
    for (const r of rows) {
      const prov = provFromCode(r.ORIG2) || provFromCode(String(r.PROVORIG || '').slice(0, 2));
      const tahun = Number(r.YEAR);
      const bulan = Number(r.MTH);
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, tahun, bulan, 'POD', 3, source, [{
        prov, tahun, bulan, basis: 'POD',
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: (r.PEL_MUAT || '').trim() || null,
        pelabuhan: (r.PEL_MUAT || '').trim() || null,
        negara_kode: (r.NEWCTRYCOD || '').trim() || null,
        negara_iso2: (r.NGRTUJUAN || '').trim() || null,
        migas: 'NonMigas',
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // provorig_all_papua (fallback provorigin)
  if (/provorig_all_papua_/i.test(base)) {
    for (const r of rows) {
      const prov = provFromCode(r.ORIG2) || provFromCode(String(r.PROVORIG || '').slice(0, 2));
      const tahun = Number(r.YEAR);
      const bulan = Number(r.MTH);
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, tahun, bulan, 'PROVORIG', 10, source, [{
        prov, tahun, bulan, basis: 'PROVORIG',
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: (r.PEL_MUAT || '').trim() || null,
        pelabuhan: null,
        negara_kode: (r.NEWCTRYCOD || '').trim() || null,
        negara_iso2: (r.NGRTUJUAN || '').trim() || null,
        migas: 'NonMigas',
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // Ekspor_Series (fallback provorigin, 2024)
  if (/ekspor_series_/i.test(base)) {
    for (const r of rows) {
      const tahun = Number(r.YEAR);
      const bulan = Number(r.MTH);
      const prov = provFromCode(r.ORIG2) || folderProv;
      const hs8 = (r.KODE_HS || '').trim();
      setRows(eksporMap, prov, tahun, bulan, 'PROVORIG', 10, source, [{
        prov, tahun, bulan, basis: 'PROVORIG',
        hs8, hs2: hs2Of(r, hs8),
        kabkota_asal: (r.PROVORIG || '').trim() || null,
        pel_muat: (r.PEL_MUAT || '').trim() || null,
        pelabuhan: (r.PODAL5 || '').trim() || null,
        negara_kode: (r.NEWCTRYCOD || '').trim() || null,
        negara_iso2: (r.NGRTUJUAN || '').trim() || null,
        migas: 'NonMigas',
        netto: numOrZero(r.NETTO), fob: numOrZero(r.FOB),
      }]);
    }
    return;
  }

  // ================= IMPORTS =================

  // Revisi impor 2025 KPPBC (multi-month, PERIODE/BERAT/NILAI)
  if (/impor_rev\d{4}_kppbc_/i.test(base)) {
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    for (const r of rows) {
      const periode = String(r.PERIODE || '').trim();
      if (!/^\d{4}$/.test(periode)) continue;
      const bulan = Number(periode.slice(0, 2));
      const tahun = 2000 + Number(periode.slice(2, 4));
      const hs8 = (r.HS || '').trim();
      setRows(imporMap, prov, tahun, bulan, 'KPPBC', 1, source, [{
        prov, tahun, bulan, basis: 'KPPBC',
        tipe: (r.TIPE || '').trim() || null,
        jenis: (r.JENIS || '').trim() || null,
        migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
        hs8, hs2: hs2Of(r, hs8),
        negara_kode: (r.K_NEGARA || '').trim() || null,
        negara_iso2: (r.NEG_ASAL || '').trim() || null,
        pelabuhan: (r.K_PELB || '').trim() || null,
        pel_un: (r.PEL_BONG || '').trim() || null,
        kppbc: (r.KPPBC || '').trim() || null,
        nama_kppbc: null,
        netto: numOrZero(r.BERAT),
        cif: numOrZero(r.NILAI),
      }]);
    }
    return;
  }

  // Revisi impor 2025 KDPROV (multi-month, PERIODE/BERAT/NILAI)
  if (/impor_rev\d{4}_kdprov_/i.test(base)) {
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    for (const r of rows) {
      const periode = String(r.PERIODE || '').trim();
      if (!/^\d{4}$/.test(periode)) continue;
      const bulan = Number(periode.slice(0, 2));
      const tahun = 2000 + Number(periode.slice(2, 4));
      const hs8 = (r.HS || '').trim();
      setRows(imporMap, prov, tahun, bulan, 'KDPROV', 1, source, [{
        prov, tahun, bulan, basis: 'KDPROV',
        tipe: (r.TIPE || '').trim() || null,
        jenis: (r.JENIS || '').trim() || null,
        migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
        hs8, hs2: hs2Of(r, hs8),
        negara_kode: (r.K_NEGARA || '').trim() || null,
        negara_iso2: (r.NEG_ASAL || '').trim() || null,
        pelabuhan: (r.K_PELB || '').trim() || null,
        pel_un: (r.PEL_BONG || '').trim() || null,
        kppbc: null,
        nama_kppbc: null,
        netto: numOrZero(r.BERAT),
        cif: numOrZero(r.NILAI),
      }]);
    }
    return;
  }

  // atap<year>.DBF (multi-period, KPPBC basis)
  const atapMatch = /^(9[4-7])atap(20\d{2})\.dbf$/i.exec(base);
  if (atapMatch) {
    const fileProv = PROV_BY_CODE.get(atapMatch[1]);
    const fileYear = Number(atapMatch[2]);
    for (const r of rows) {
      const rowProv = provFromCode(r.KD_PROV) || fileProv;
      for (let m = 1; m <= 12; m += 1) {
        const mm = String(m).padStart(2, '0');
        const yy = String(fileYear).slice(-2);
        const bCol = `B${mm}${yy}`;
        const nCol = `N${mm}${yy}`;
        if (!fieldNames.includes(bCol) || !fieldNames.includes(nCol)) continue;
        const netto = numOrZero(r[bCol]);
        const cif = numOrZero(r[nCol]);
        if (netto === 0 && cif === 0) continue;
        const hs8 = (r.HS || '').trim();
        setRows(imporMap, rowProv, fileYear, m, 'KPPBC', 4, source, [{
          prov: rowProv, tahun: fileYear, bulan: m, basis: 'KPPBC',
          tipe: (r.TIPE || '').trim() || null,
          jenis: (r.JENIS || '').trim() || null,
          migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
          hs8, hs2: hs2Of(r, hs8),
          negara_kode: (r.K_NEGARA || '').trim() || null,
          negara_iso2: (r.NEG_ASAL || '').trim() || null,
          pelabuhan: (r.K_PELB || '').trim() || null,
          pel_un: (r.PEL_BONG || '').trim() || null,
          kppbc: (r.KPPBC || '').trim() || null,
          nama_kppbc: null,
          netto, cif,
        }]);
      }
    }
    return;
  }

  // kppbc_imp_papua_<MMYY>.DBF (monthly KPPBC)
  if (/kppbc_imp_papua_/i.test(base)) {
    const m = /^(.+?)_imp_papua_(\d{2})(\d{2})/i.exec(base);
    if (!m) return;
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    // period from B<MMYY> columns
    const bCol = fieldNames.find((n) => /^B\d{4}$/.test(n));
    if (!bCol) return;
    const periodBulan = Number(bCol.slice(1, 3));
    const periodTahun = 2000 + Number(bCol.slice(3, 5));
    const nCol = `N${bCol.slice(1)}`;
    if (!fieldNames.includes(nCol)) return;
    for (const r of rows) {
      const hs8 = (r.HS || '').trim();
      setRows(imporMap, prov, periodTahun, periodBulan, 'KPPBC', 5, source, [{
        prov, tahun: periodTahun, bulan: periodBulan, basis: 'KPPBC',
        tipe: (r.TIPE || '').trim() || null,
        jenis: (r.JENIS || '').trim() || null,
        migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
        hs8, hs2: hs2Of(r, hs8),
        negara_kode: (r.K_NEGARA || '').trim() || null,
        negara_iso2: (r.NEG_ASAL || '').trim() || null,
        pelabuhan: (r.K_PELB || '').trim() || null,
        pel_un: (r.PEL_BONG || '').trim() || null,
        kppbc: (r.KPPBC || '').trim() || null,
        nama_kppbc: (r.NAMA_KPPBC || '').trim() || null,
        netto: numOrZero(r[bCol]),
        cif: numOrZero(r[nCol]),
      }]);
    }
    return;
  }

  // asem_imp_papua_<MMYY>S.DBF (monthly KPPBC variant)
  if (/asem_imp_papua_/i.test(base)) {
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    const bCol = fieldNames.find((n) => /^B\d{4}S$/.test(n));
    if (!bCol) return;
    const periodBulan = Number(bCol.slice(1, 3));
    const periodTahun = 2000 + Number(bCol.slice(3, 5));
    const nCol = `N${bCol.slice(1)}`;
    if (!fieldNames.includes(nCol)) return;
    for (const r of rows) {
      const hs8 = (r.HS || '').trim();
      setRows(imporMap, prov, periodTahun, periodBulan, 'KPPBC', 6, source, [{
        prov, tahun: periodTahun, bulan: periodBulan, basis: 'KPPBC',
        tipe: (r.TIPE || '').trim() || null,
        jenis: (r.JENIS || '').trim() || null,
        migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
        hs8, hs2: hs2Of(r, hs8),
        negara_kode: (r.K_NEGARA || '').trim() || null,
        negara_iso2: (r.NEG_ASAL || '').trim() || null,
        pelabuhan: (r.K_PELB || '').trim() || null,
        pel_un: (r.PEL_BONG || '').trim() || null,
        kppbc: (r.KD_KANTOR || '').trim() || null,
        nama_kppbc: (r.NAMA_KPPBC || '').trim() || null,
        netto: numOrZero(r[bCol]),
        cif: numOrZero(r[nCol]),
      }]);
    }
    return;
  }

  // kppbc_revisi_tahunan_imp_papua... (2024 KPPBC revision, multi-period)
  if (/kppbc_revisi_tahunan_imp_papua/.test(base)) {
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    for (const r of rows) {
      for (let m = 1; m <= 12; m += 1) {
        const mm = String(m).padStart(2, '0');
        const bCol = `B${mm}24`;
        const nCol = `N${mm}24`;
        if (!fieldNames.includes(bCol) || !fieldNames.includes(nCol)) continue;
        const netto = numOrZero(r[bCol]);
        const cif = numOrZero(r[nCol]);
        if (netto === 0 && cif === 0) continue;
        const hs8 = (r.HS || '').trim();
        setRows(imporMap, prov, 2024, m, 'KPPBC', 4, source, [{
          prov, tahun: 2024, bulan: m, basis: 'KPPBC',
          tipe: (r.TIPE || '').trim() || null,
          jenis: (r.JENIS || '').trim() || null,
          migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
          hs8, hs2: hs2Of(r, hs8),
          negara_kode: (r.K_NEGARA || '').trim() || null,
          negara_iso2: (r.NEG_ASAL || '').trim() || null,
          pelabuhan: (r.K_PELB || '').trim() || null,
          pel_un: (r.PEL_BONG || '').trim() || null,
          kppbc: (r.KPPBC || '').trim() || null,
          nama_kppbc: (r.NAMA_KPPBC || '').trim() || null,
          netto, cif,
        }]);
      }
    }
    return;
  }

  // revisi_tahunan_imp_papua... (2024 KDPROV revision, multi-period)
  if (/revisi_tahunan_imp_papua/.test(base)) {
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    for (const r of rows) {
      for (let m = 1; m <= 12; m += 1) {
        const mm = String(m).padStart(2, '0');
        const bCol = `B${mm}24`;
        const nCol = `N${mm}24`;
        if (!fieldNames.includes(bCol) || !fieldNames.includes(nCol)) continue;
        const netto = numOrZero(r[bCol]);
        const cif = numOrZero(r[nCol]);
        if (netto === 0 && cif === 0) continue;
        const hs8 = (r.HS || '').trim();
        setRows(imporMap, prov, 2024, m, 'KDPROV', 6, source, [{
          prov, tahun: 2024, bulan: m, basis: 'KDPROV',
          tipe: (r.TIPE || '').trim() || null,
          jenis: (r.JENIS || '').trim() || null,
          migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
          hs8, hs2: hs2Of(r, hs8),
          negara_kode: (r.K_NEGARA || '').trim() || null,
          negara_iso2: (r.NEG_ASAL || '').trim() || null,
          pelabuhan: (r.K_PELB || '').trim() || null,
          pel_un: (r.PEL_BONG || '').trim() || null,
          kppbc: null,
          nama_kppbc: (r.NAMA_KPPBC || '').trim() || null,
          netto, cif,
        }]);
      }
    }
    return;
  }

  // atap_imp_papua_<MMYY>.DBF (monthly KDPROV)
  if (/atap_imp_papua_/i.test(base)) {
    const code = /^(9[4-7])/.exec(base)?.[1];
    const prov = PROV_BY_CODE.get(code) || folderProv;
    if (!prov) return;
    const bCol = fieldNames.find((n) => /^B\d{4}$/.test(n));
    if (!bCol) return;
    const periodBulan = Number(bCol.slice(1, 3));
    const periodTahun = 2000 + Number(bCol.slice(3, 5));
    const nCol = `N${bCol.slice(1)}`;
    if (!fieldNames.includes(nCol)) return;
    for (const r of rows) {
      const hs8 = (r.HS || '').trim();
      setRows(imporMap, prov, periodTahun, periodBulan, 'KDPROV', 6, source, [{
        prov, tahun: periodTahun, bulan: periodBulan, basis: 'KDPROV',
        tipe: (r.TIPE || '').trim() || null,
        jenis: (r.JENIS || '').trim() || null,
        migas: (r.JENIS || '').trim() === 'NM' ? 'NonMigas' : 'Migas',
        hs8, hs2: hs2Of(r, hs8),
        negara_kode: (r.K_NEGARA || '').trim() || null,
        negara_iso2: (r.NEG_ASAL || '').trim() || null,
        pelabuhan: (r.K_PELB || '').trim() || null,
        pel_un: (r.PEL_BONG || '').trim() || null,
        kppbc: null,
        nama_kppbc: null,
        netto: numOrZero(r[bCol]),
        cif: numOrZero(r[nCol]),
      }]);
    }
    return;
  }
}

function missingKeys() {
  const ekspor = [];
  const impor = [];
  for (const code of Object.keys(PROVINSI_PERDAGANGAN)) {
    const prov = PROVINSI_PERDAGANGAN[code];
    for (const tahun of [2024, 2025]) {
      for (let bulan = 1; bulan <= 12; bulan += 1) {
        if (!eksporMap.has(keyOf(prov, tahun, bulan, 'PROVORIG'))) ekspor.push(`${prov} ${tahun}-${String(bulan).padStart(2, '0')} PROVORIG`);
        if (!imporMap.has(keyOf(prov, tahun, bulan, 'KPPBC'))) impor.push(`${prov} ${tahun}-${String(bulan).padStart(2, '0')} KPPBC`);
      }
    }
  }
  return { ekspor, impor };
}

async function insertChunk(client, table, cols, rows) {
  if (!rows.length) return;
  const perChunk = 500;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const values = [];
    const params = [];
    chunk.forEach((r, ri) => {
      values.push(`(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`);
      cols.forEach((c) => params.push(r[c]));
    });
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`, params);
  }
}

const EKSPOR_COLS = ['prov', 'tahun', 'bulan', 'basis', 'hs8', 'hs2', 'kabkota_asal',
  'pel_muat', 'pelabuhan', 'negara_kode', 'negara_iso2', 'migas', 'netto', 'fob'];
const IMPOR_COLS = ['prov', 'tahun', 'bulan', 'basis', 'tipe', 'jenis', 'migas', 'hs8', 'hs2',
  'negara_kode', 'negara_iso2', 'pelabuhan', 'pel_un', 'kppbc', 'nama_kppbc', 'netto', 'cif'];

async function run() {
  console.log(`Scanning ${ROOTS.join(' | ')} ...`);
  let count = 0;
  for (const root of ROOTS) {
    for await (const file of walkDbf(root)) {
      const rel = path.relative(root, file);
      const parts = rel.split(path.sep);
      const folder = parts.length > 1 ? parts[0] : '';
      const folderProv = provFromFolder(folder);
      await processFile(file, folderProv);
      count += 1;
    }
  }
  console.log(`Processed ${count} DBF files.`);

  const missing = missingKeys();
  console.log(`Missing ekspor PROVORIG periods: ${missing.ekspor.length}`);
  for (const m of missing.ekspor.slice(0, 20)) console.log('  -', m);
  if (missing.ekspor.length > 20) console.log('  ...');
  console.log(`Missing impor KPPBC periods: ${missing.impor.length}`);
  for (const m of missing.impor.slice(0, 20)) console.log('  -', m);
  if (missing.impor.length > 20) console.log('  ...');

  if (warnings.length) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 40)) console.log('  -', w);
    if (warnings.length > 40) console.log('  ...');
  }

  console.log(`Ekspor keys: ${eksporMap.size}, Impor keys: ${imporMap.size}`);

  if (DRY_RUN) {
    let eRows = 0;
    for (const entry of eksporMap.values()) eRows += entry.rows.length;
    let iRows = 0;
    for (const entry of imporMap.values()) iRows += entry.rows.length;
    console.log(`DRY RUN: ekspor rows=${eRows}, impor rows=${iRows}. No database changes.`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ekspor
    for (const [key, entry] of eksporMap) {
      const [prov, tahun, bulan, basis] = key.split('|');
      await client.query('DELETE FROM fact_ekspor WHERE prov=$1 AND tahun=$2 AND bulan=$3 AND basis=$4',
        [prov, Number(tahun), Number(bulan), basis]);
      await insertChunk(client, 'fact_ekspor', EKSPOR_COLS, entry.rows);
    }

    // Impor
    for (const [key, entry] of imporMap) {
      const [prov, tahun, bulan, basis] = key.split('|');
      await client.query('DELETE FROM fact_impor WHERE prov=$1 AND tahun=$2 AND bulan=$3 AND basis=$4',
        [prov, Number(tahun), Number(bulan), basis]);
      await insertChunk(client, 'fact_impor', IMPOR_COLS, entry.rows);
    }

    // Logs (one per key, aggregate totals)
    for (const [key, entry] of eksporMap) {
      const [prov, tahun, bulan, basis] = key.split('|');
      const netto = entry.rows.reduce((a, r) => a + r.netto, 0);
      const nilai = entry.rows.reduce((a, r) => a + r.fob, 0);
      await client.query(
        `INSERT INTO etl_log_perdagangan (tahun,bulan,arus,prov,basis,sumber,baris,netto_total,nilai_total,dicocokkan,catatan)
         VALUES ($1,$2,'ekspor',$3,$4,$5,$6,$7,$8,false,$9)`,
        [Number(tahun), Number(bulan), prov, basis, entry.source, entry.rows.length, netto, nilai,
          'DBF import tanpa berkas kontrol'],
      );
    }
    for (const [key, entry] of imporMap) {
      const [prov, tahun, bulan, basis] = key.split('|');
      const netto = entry.rows.reduce((a, r) => a + r.netto, 0);
      const nilai = entry.rows.reduce((a, r) => a + r.cif, 0);
      await client.query(
        `INSERT INTO etl_log_perdagangan (tahun,bulan,arus,prov,basis,sumber,baris,netto_total,nilai_total,dicocokkan,catatan)
         VALUES ($1,$2,'impor',$3,$4,$5,$6,$7,$8,false,$9)`,
        [Number(tahun), Number(bulan), prov, basis, entry.source, entry.rows.length, netto, nilai,
          'DBF import tanpa berkas kontrol'],
      );
    }

    await client.query('COMMIT');
    console.log('Committed.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
