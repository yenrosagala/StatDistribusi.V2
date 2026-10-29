// ETL modul Perdagangan: ZIP berisi DBF -> validasi -> Supabase.
//
// Aturan yang dipertahankan dari paket ETL asli:
//   * Ekspor resmi = basis PROVORIG; impor resmi = basis KPPBC. Tidak dijumlahkan.
//   * Setiap provinsi divalidasi terhadap berkas *_total.DBF. Bila jumlah detail
//     tidak cocok, provinsi itu DIBATALKAN (rollback), bukan disimpan diam-diam.
//   * Mengunggah ulang satu bulan MENGGANTI bulan itu (aman untuk revisi).
import { pool } from './db.js';
import { PROVINSI_PERDAGANGAN, importPeriod, num, readDbf, toEkspor, toImpor } from './dbf-perdagangan.js';

const EKSPOR_COLS = ['prov', 'tahun', 'bulan', 'basis', 'hs8', 'hs2', 'kabkota_asal',
  'pel_muat', 'pelabuhan', 'negara_kode', 'negara_iso2', 'migas', 'netto', 'fob'];
const IMPOR_COLS = ['prov', 'tahun', 'bulan', 'basis', 'tipe', 'jenis', 'migas', 'hs8', 'hs2',
  'negara_kode', 'negara_iso2', 'pelabuhan', 'pel_un', 'kppbc', 'nama_kppbc', 'netto', 'cif'];

async function ensureTables() {
  // Skema sudah ada (dijalankan sekali lewat sql). Ini hanya jaring aman bila
  // database baru dipulihkan dari nol.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fact_ekspor (
      id bigserial PRIMARY KEY, prov text NOT NULL, tahun integer NOT NULL,
      bulan integer NOT NULL, basis text NOT NULL, hs8 text NOT NULL, hs2 text NOT NULL,
      kabkota_asal text, pel_muat text, pelabuhan text, negara_kode text, negara_iso2 text,
      migas text NOT NULL, netto double precision NOT NULL, fob double precision NOT NULL);
    CREATE TABLE IF NOT EXISTS fact_impor (
      id bigserial PRIMARY KEY, prov text NOT NULL, tahun integer NOT NULL,
      bulan integer NOT NULL, basis text NOT NULL, tipe text, jenis text, migas text NOT NULL,
      hs8 text NOT NULL, hs2 text NOT NULL, negara_kode text, negara_iso2 text,
      pelabuhan text, pel_un text, kppbc text, nama_kppbc text,
      netto double precision NOT NULL, cif double precision NOT NULL);
    CREATE TABLE IF NOT EXISTS etl_log_perdagangan (
      id bigserial PRIMARY KEY, tahun integer NOT NULL, bulan integer NOT NULL,
      arus text NOT NULL, prov text NOT NULL, basis text NOT NULL, sumber text,
      baris integer NOT NULL DEFAULT 0, netto_total double precision, nilai_total double precision,
      dicocokkan boolean NOT NULL DEFAULT false, loaded_at timestamptz NOT NULL DEFAULT now());`);
}

/** Nama berkas yang dikenali. Toleran terhadap huruf besar/kecil dan spasi. */
function classify(name) {
  const base = name.split('/').pop().toLowerCase();
  // Arsip ini juga memuat salinan .DBF.xlsx; hanya berkas .dbf yang diproses.
  if (!base.endsWith('.dbf')) return null;
  const prov = base.match(/^(9[4-7])[_\s-]/)?.[1];
  if (!prov) return null;
  if (base.includes('ekspor') && base.includes('provorig')) return { prov, arus: 'ekspor', basis: 'PROVORIG' };
  if (base.includes('ekspor') && base.includes('pod')) return { prov, arus: 'ekspor', basis: 'POD' };
  if (base.includes('ekspor') && base.includes('total')) return { prov, arus: 'ekspor', basis: 'TOTAL' };
  if (base.includes('impor') && base.includes('kppbc')) return { prov, arus: 'impor', basis: 'KPPBC' };
  if (base.includes('impor') && base.includes('kdprov')) return { prov, arus: 'impor', basis: 'KDPROV' };
  if (base.includes('impor') && base.includes('total')) return { prov, arus: 'impor', basis: 'TOTAL' };
  return null;
}

/**
 * Parse seluruh berkas dalam satu ZIP.
 * `entries` = [{ name, buffer }]
 */
export function parsePerdaganganZip(entries) {
  const files = new Map();
  for (const e of entries) {
    const kind = classify(e.name);
    if (kind) files.set(`${kind.prov}|${kind.arus}|${kind.basis}`, { ...kind, name: e.name, buffer: e.buffer });
  }
  if (!files.size) throw new Error('ZIP tidak memuat berkas DBF perdagangan yang dikenali (pola: <kode prov>_...ekspor/impor...).');

  const provinsi = [];
  for (const kode of Object.keys(PROVINSI_PERDAGANGAN)) {
    const nama = PROVINSI_PERDAGANGAN[kode];
    const paket = { prov: nama, kode, ekspor: [], impor: [], log: [], warnings: [] };

    for (const basis of ['PROVORIG', 'POD']) {
      const f = files.get(`${kode}|ekspor|${basis}`);
      if (!f) continue;
      const { rows } = readDbf(f.buffer);
      paket.ekspor.push(...rows.map((r) => toEkspor(r, nama, basis)));
    }

    for (const basis of ['KPPBC', 'KDPROV']) {
      const f = files.get(`${kode}|impor|${basis}`);
      if (!f) continue;
      const { fields, rows } = readDbf(f.buffer);
      if (!rows.length) continue;
      const period = importPeriod(fields.map((x) => x.name));
      paket.impor.push(...rows.map((r) => toImpor(r, nama, basis, period)));
    }

    // ---- validasi terhadap berkas kontrol ----
    const totalEkspor = files.get(`${kode}|ekspor|TOTAL`);
    if (totalEkspor) {
      const { rows } = readDbf(totalEkspor.buffer);
      if (rows.length) {
        const ctrlFob = num(rows[0].FOB_ORIG2);
        const detailFob = paket.ekspor.filter((r) => r.basis === 'PROVORIG').reduce((a, r) => a + r.fob, 0);
        const ok = Math.abs(ctrlFob - detailFob) < 0.01;
        paket.log.push({ arus: 'ekspor', basis: 'PROVORIG', netto: null, nilai: detailFob, dicocokkan: ok });
        if (!ok) {
          paket.warnings.push(`Ekspor ${nama}: FOB detail ${detailFob.toFixed(2)} tidak cocok dengan kontrol ${ctrlFob.toFixed(2)}`);
          paket.ekspor = paket.ekspor.filter((r) => r.basis !== 'PROVORIG');
        }
      }
    }

    const totalImpor = files.get(`${kode}|impor|TOTAL`);
    if (totalImpor) {
      const { rows } = readDbf(totalImpor.buffer);
      if (rows.length) {
        const t = rows[0];
        for (const [basis, wKey, vKey] of [['KPPBC', 'W_KPPBC', 'V_KPPBC'], ['KDPROV', 'W_KDPROV', 'V_KDPROV']]) {
          const detail = paket.impor.filter((r) => r.basis === basis);
          if (!detail.length) continue;
          const dNilai = detail.reduce((a, r) => a + r.cif, 0);
          const dNetto = detail.reduce((a, r) => a + r.netto, 0);
          const ok = Math.abs(num(t[vKey]) - dNilai) < 0.01 && Math.abs(num(t[wKey]) - dNetto) < 0.01;
          paket.log.push({ arus: 'impor', basis, netto: dNetto, nilai: dNilai, dicocokkan: ok });
          if (!ok) {
            paket.warnings.push(`Impor ${nama} ${basis}: tidak cocok dengan kontrol (nilai ${dNilai.toFixed(2)} vs ${num(t[vKey]).toFixed(2)})`);
            paket.impor = paket.impor.filter((r) => r.basis !== basis);
          }
        }
      }
    }

    provinsi.push(paket);
  }
  return provinsi;
}

const insertChunk = async (client, table, cols, rows) => {
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
};

/** Simpan hasil parse ke database. Satu transaksi; periode yang sama diganti. */
export async function savePerdagangan(provinsi, sumber = 'upload.zip') {
  await ensureTables();
  const periods = new Set();
  for (const p of provinsi) {
    for (const r of [...p.ekspor, ...p.impor]) periods.add(`${r.tahun}|${r.bulan}`);
  }
  if (!periods.size) throw new Error('Tidak ada baris data untuk disimpan.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of periods) {
      const [tahun, bulan] = key.split('|').map(Number);
      await client.query('DELETE FROM fact_ekspor WHERE tahun=$1 AND bulan=$2', [tahun, bulan]);
      await client.query('DELETE FROM fact_impor WHERE tahun=$1 AND bulan=$2', [tahun, bulan]);
      await client.query('DELETE FROM etl_log_perdagangan WHERE tahun=$1 AND bulan=$2', [tahun, bulan]);
    }
    let nEkspor = 0;
    let nImpor = 0;
    for (const p of provinsi) {
      await insertChunk(client, 'fact_ekspor', EKSPOR_COLS, p.ekspor);
      await insertChunk(client, 'fact_impor', IMPOR_COLS, p.impor);
      nEkspor += p.ekspor.length;
      nImpor += p.impor.length;
      for (const l of p.log) {
        const sample = p.ekspor[0] || p.impor[0];
        await client.query(
          `INSERT INTO etl_log_perdagangan (tahun,bulan,arus,prov,basis,sumber,baris,netto_total,nilai_total,dicocokkan)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sample?.tahun ?? null, sample?.bulan ?? null, l.arus, p.prov, l.basis, sumber,
            l.arus === 'ekspor' ? p.ekspor.filter((r) => r.basis === l.basis).length : p.impor.filter((r) => r.basis === l.basis).length,
            l.netto, l.nilai, l.dicocokkan]);
      }
    }
    await client.query('COMMIT');
    return { ekspor: nEkspor, impor: nImpor, periode: [...periods], warnings: provinsi.flatMap((p) => p.warnings) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* sudah batal */ }
    throw err;
  } finally {
    client.release();
  }
}
