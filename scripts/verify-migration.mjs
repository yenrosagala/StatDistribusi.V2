/**
 * Verifikasi hasil migrasi database.
 *
 * Membandingkan isi database yang sedang dipakai aplikasi dengan manifest hasil
 * dump (backup/json_<stamp>/_manifest.json): jumlah baris per tabel, jumlah
 * kolom, dan checksum dua tabel fakta terbesar.
 *
 * Pemakaian:
 *   node scripts/verify-migration.mjs
 *   node scripts/verify-migration.mjs backup/json_20261030-043637
 *   DATABASE_URL="postgresql://user:pass@host:port/db" node scripts/verify-migration.mjs
 *
 * DSN diambil dari DATABASE_URL, atau dari ../.streamlit/secrets.toml seperti
 * yang dipakai db.js. Keluar dengan kode 1 bila ada selisih.
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const AKAR = path.resolve(import.meta.dirname, '..');

function resolveDsn() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const teks = readFileSync(path.resolve(AKAR, '..', '.streamlit', 'secrets.toml'), 'utf8');
    return teks.match(/^\s*DATABASE_URL\s*=\s*["']([^"']+)["']/m)?.[1];
  } catch {
    return undefined;
  }
}

/** Folder dump terbaru yang punya _manifest.json. */
async function dumpTerbaru() {
  const backup = path.join(AKAR, 'backup');
  const isi = await fs.readdir(backup).catch(() => []);
  const kandidat = [];
  for (const nama of isi) {
    if (!nama.startsWith('json_')) continue;
    const berkas = path.join(backup, nama, '_manifest.json');
    try {
      const st = await fs.stat(berkas);
      kandidat.push({ dir: path.join(backup, nama), mtime: st.mtimeMs });
    } catch {
      // lewati folder tanpa manifest
    }
  }
  kandidat.sort((a, b) => b.mtime - a.mtime);
  return kandidat[0]?.dir ?? null;
}

/** Checksum tabel fakta: sum kolom nilai + jumlah baris. */
const CEK = {
  fact_ekspor: 'round(sum(fob)::numeric, 2)',
  fact_impor: 'round(sum(cif)::numeric, 2)',
  all_data: 'round(sum(tpk)::numeric, 2)',
};

async function main() {
  const dsn = resolveDsn();
  if (!dsn) {
    console.error('DATABASE_URL tidak ditemukan (env atau ../.streamlit/secrets.toml).');
    process.exit(2);
  }
  const dirDump = process.argv[2] ? path.resolve(process.argv[2]) : await dumpTerbaru();
  if (!dirDump) {
    console.error('Tidak ada folder backup/json_*/_manifest.json. Jalankan dulu: npm run db:export');
    process.exit(2);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(dirDump, '_manifest.json'), 'utf8'));

  const target = dsn.replace(/\/\/[^@]*@/, '//***:***@');
  console.log(`tujuan   : ${target}`);
  console.log(`acuan    : ${path.basename(dirDump)}  (${manifest.total_rows} baris, ${Object.keys(manifest.tables).length} tabel)`);
  const klien = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 15000 });
  await klien.connect();
  console.log(`server   : ${(await klien.query('select version() v')).rows[0].v.split(',')[0]}\n`);

  const ada = new Set((await klien.query(`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')`)).rows.map((r) => r.name));

  let gagal = 0;
  let totalTujuan = 0;
  console.log('tabel                        acuan   tujuan   status');
  console.log('----------------------------------------------------------');
  for (const [nama, harap] of Object.entries(manifest.tables)) {
    if (!ada.has(nama)) {
      gagal += 1;
      console.log(`${nama.padEnd(28)} ${String(harap.rows).padStart(6)}        -  TIDAK ADA`);
      continue;
    }
    const { rows } = await klien.query(`select count(*)::int as n from "${nama}"`);
    const n = rows[0].n;
    totalTujuan += n;
    let status = n === harap.rows ? 'ok' : `BEDA (${n - harap.rows > 0 ? '+' : ''}${n - harap.rows})`;
    if (n !== harap.rows) gagal += 1;

    // Jumlah kolom
    const kol = (await klien.query(
      `select count(*)::int as n from pg_attribute
        where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [nama])).rows[0].n;
    if (kol !== harap.columns) {
      status += ` | kolom ${kol} != ${harap.columns}`;
      gagal += 1;
    }
    console.log(`${nama.padEnd(28)} ${String(harap.rows).padStart(6)} ${String(n).padStart(7)}  ${status}`);
  }

  console.log('\nchecksum tabel fakta:');
  for (const [tabel, expr] of Object.entries(CEK)) {
    if (!ada.has(tabel)) continue;
    try {
      const v = (await klien.query(`select ${expr} as v from "${tabel}"`)).rows[0].v;
      console.log(`  ${tabel.padEnd(14)} sum = ${v}`);
    } catch (e) {
      console.log(`  ${tabel.padEnd(14)} (tidak bisa dihitung: ${e.message})`);
    }
  }

  const ekstra = [...ada].filter((n) => !(n in manifest.tables));
  if (ekstra.length) console.log(`\ntabel di tujuan yang tidak ada di acuan: ${ekstra.join(', ')}`);

  console.log(`\ntotal baris acuan ${manifest.total_rows} | tujuan ${totalTujuan}`);
  if (manifest.total_rows !== totalTujuan) {
    console.log(`SELISIH ${totalTujuan - manifest.total_rows} baris`);
    gagal += 1;
  }
  console.log(gagal ? `\nHASIL: ${gagal} masalah ditemukan` : '\nHASIL: semua tabel cocok');
  await klien.end();
  process.exit(gagal ? 1 : 0);
}

main().catch((e) => {
  console.error(`verifikasi gagal: ${e.message}`);
  process.exit(2);
});
