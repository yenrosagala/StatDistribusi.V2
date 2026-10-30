/**
 * Impor hasil dump JSON ke database tujuan (migrasi manual).
 *
 * Pemakaian:
 *   node scripts/import-json.mjs <database.json> --url "postgresql://user:pass@host:5432/db"
 *   node scripts/import-json.mjs <database.json> --url "..." --schema _schema.sql --truncate
 *
 * Opsi:
 *   --url       DSN tujuan (wajib)
 *   --schema    berkas DDL yang dijalankan lebih dulu (opsional)
 *   --truncate  kosongkan tabel tujuan sebelum mengisi (default: gagal bila sudah ada isi)
 *   --only      batasi ke tabel tertentu, pisahkan dengan koma
 *
 * Skrip ini tidak memakai pg_restore, jadi bisa dipakai bila hanya ada Node di
 * server tujuan. Urutan penyisipan mengikuti kunci objek pada berkas JSON.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const sumber = args[0];
const url = value('--url');
if (!sumber || !url) {
  console.error('Pemakaian: node scripts/import-json.mjs <database.json> --url "<dsn tujuan>" [--schema _schema.sql] [--truncate]');
  process.exit(2);
}

const hanya = value('--only') ? new Set(value('--only').split(',').map((s) => s.trim())) : null;

/** Baca berkas JSON (gabungan) atau direktori berisi <tabel>.json. */
async function bacaSumber(p) {
  const st = await fs.stat(p);
  if (st.isFile()) {
    const j = JSON.parse(await fs.readFile(p, 'utf8'));
    if (!j.tables) throw new Error('Berkas JSON tidak memuat kunci "tables".');
    const tabel = {};
    for (const [nama, isi] of Object.entries(j.tables)) tabel[nama] = isi.data ?? [];
    return { tabel, total: j.total_rows ?? null };
  }
  // Hanya _manifest.json dan database.json yang dilewati; nama tabel boleh
  // berawalan garis bawah.
  const files = (await fs.readdir(p)).filter((f) => f.endsWith('.json')
    && f !== '_manifest.json' && f !== 'database.json');
  const tabel = {};
  for (const f of files) {
    const nama = path.basename(f, '.json');
    tabel[nama] = JSON.parse(await fs.readFile(path.join(p, f), 'utf8'));
  }
  return { tabel, total: null };
}

const kutip = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function main() {
  const { tabel } = await bacaSumber(sumber);
  const namaTabel = Object.keys(tabel).filter((t) => !hanya || hanya.has(t));
  if (!namaTabel.length) throw new Error('Tidak ada tabel untuk diimpor.');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  console.log('tujuan:', url.replace(/\/\/[^@]*@/, '//***:***@'));

  const skema = value('--schema');
  if (skema) {
    console.log(`\n[1/3] terapkan skema ${skema} ...`);
    await client.query(await fs.readFile(skema, 'utf8'));
    console.log('      ok');
  } else {
    console.log('\n[1/3] skema dilewati (tabel harus sudah ada)');
  }

  if (flag('--truncate')) {
    console.log('\n[2/3] kosongkan tabel tujuan ...');
    for (const t of namaTabel) {
      await client.query(`TRUNCATE TABLE ${kutip(t)} RESTART IDENTITY CASCADE`);
    }
    console.log('      ok');
  } else {
    console.log('\n[2/3] truncate dilewati');
  }

  console.log('\n[3/3] sisipkan baris ...');
  let total = 0;
  for (const t of namaTabel) {
    const rows = tabel[t] || [];
    if (!rows.length) {
      console.log(`      ${t.padEnd(26)} 0 baris (dilewati)`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    const perBatch = Math.max(1, Math.floor(1000 / cols.length));
    let masuk = 0;
    for (let i = 0; i < rows.length; i += perBatch) {
      const batch = rows.slice(i, i + perBatch);
      const values = [];
      const params = [];
      batch.forEach((r, ri) => {
        values.push(`(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`);
        cols.forEach((c) => params.push(r[c]));
      });
      await client.query(
        `INSERT INTO ${kutip(t)} (${cols.map(kutip).join(',')}) VALUES ${values.join(',')}`, params);
      masuk += batch.length;
    }
    total += masuk;
    console.log(`      ${t.padEnd(26)} ${masuk} baris`);
  }

  // Selaraskan sequence agar INSERT berikutnya tidak bentrok.
  const seq = await client.query(`
    SELECT c.relname AS tabel, a.attname AS kolom,
           pg_get_serial_sequence(c.oid::regclass::text, a.attname) AS seq
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0
      AND pg_get_serial_sequence(c.oid::regclass::text, a.attname) IS NOT NULL`);
  for (const r of seq.rows) {
    if (hanya && !hanya.has(r.tabel)) continue;
    await client.query(
      `SELECT setval('${r.seq}', GREATEST(COALESCE((SELECT MAX(${kutip(r.kolom)}) FROM ${kutip(r.tabel)}), 0), 1))`);
  }
  console.log(`\nselesai: ${total} baris masuk ke ${namaTabel.length} tabel.`);

  console.log('\nverifikasi jumlah baris:');
  for (const t of namaTabel) {
    const r = await client.query(`SELECT count(*)::int AS n FROM ${kutip(t)}`);
    console.log(`  ${t.padEnd(26)} ${r.rows[0].n}`);
  }
  await client.end();
}

main().catch((err) => {
  console.error('\nGAGAL:', err.message);
  process.exit(1);
});
