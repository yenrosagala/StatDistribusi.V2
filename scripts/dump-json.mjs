/**
 * Dump every table of the configured database to JSON for manual migration.
 *
 * Output layout (default `backup/json_<stamp>/`):
 *
 *   database.json        semua tabel dalam satu berkas -- paling mudah dipindah
 *   <tabel>.json         satu berkas per tabel
 *   _schema.sql          DDL bersih (sequence, tabel, constraint, index)
 *   _manifest.json       jumlah baris & kolom
 *   README.md            cara impor di server tujuan
 *
 * Tabel sementara (`upload_staging`) dilewati: isinya sesi unggah yang sudah
 * kedaluwarsa (termasuk berkas dalam base64), bukan data yang perlu dimigrasi.
 *
 * Skema dibuat dari katalog PostgreSQL, bukan `pg_dump`, supaya berkasnya bersih
 * dari objek internal Supabase (role, RLS, publication, grant).
 *
 * Run: node scripts/dump-json.mjs [outDir]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const outDir = process.argv[2] || path.join('backup', `json_${stamp}`);

/** Tabel yang isinya sementara, tidak ikut migrasi. */
const SEMENTARA = new Set(['upload_staging']);

/** pg may return Date / Buffer / BigInt - normalise to JSON-safe values. */
function normalise(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v);
    return out;
  }
  return value;
}

const query = async (sql, params = []) => (await pool.query(sql, params)).rows;

/** DDL untuk satu tabel: kolom, primary key, unique, check. */
async function ddlTabel(name) {
  const kolom = await query(`
    select a.attname as name,
           format_type(a.atttypid, a.atttypmod) as tipe,
           a.attnotnull as wajib,
           pg_get_expr(d.adbin, d.adrelid) as bawaan
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum`, [`public."${name}"`]);

  const batasan = await query(`
    select conname as name, contype as jenis, pg_get_constraintdef(oid) as definisi
    from pg_constraint
    where conrelid = $1::regclass and contype in ('p', 'u', 'c')
    order by (contype = 'p') desc, conname`, [`public."${name}"`]);

  const baris = kolom.map((k) => {
    let s = `    "${k.name}" ${k.tipe}`;
    if (k.bawaan !== null && k.bawaan !== undefined) s += ` DEFAULT ${k.bawaan}`;
    if (k.wajib) s += ' NOT NULL';
    return s;
  });
  for (const b of batasan) {
    const nama = b.jenis === 'p' ? 'PRIMARY KEY' : b.jenis === 'u' ? 'UNIQUE' : 'CHECK';
    baris.push(`    CONSTRAINT "${b.name}" ${b.definisi.replace(/^(PRIMARY KEY|UNIQUE|CHECK)/, nama)}`);
  }

  return {
    tabel: `CREATE TABLE IF NOT EXISTS "${name}" (\n${baris.join(',\n')}\n);\n`,
    namaBatasan: new Set(batasan.map((b) => b.name)),
  };
}

async function tulisSkema(tables) {
  const seq = await query(`
    select sequencename as name from pg_sequences
    where schemaname = 'public' order by 1`);

  const bagian = [
    '-- Skema hasil dump untuk migrasi manual.',
    '-- Jalankan lebih dulu di server tujuan:',
    '--   node scripts/import-json.mjs database.json --url "<dsn>" --schema _schema.sql --truncate',
    '',
    '-- Sequence',
  ];
  for (const s of seq) bagian.push(`CREATE SEQUENCE IF NOT EXISTS "${s.name}";`);
  bagian.push('', '-- Tabel');

  const semuaBatasan = [];
  const tabelDdl = [];
  for (const { name } of tables) {
    const { tabel, namaBatasan } = await ddlTabel(name);
    tabelDdl.push(tabel);
    semuaBatasan.push({ name, namaBatasan });
  }
  bagian.push(...tabelDdl);

  // Index non-primary-key. Index milik constraint sudah dibuat oleh DDL tabel.
  const daftarIndex = [];
  for (const { name, namaBatasan } of semuaBatasan) {
    const idx = await query(`
      select indexname as name, indexdef as definisi from pg_indexes
      where schemaname = 'public' and tablename = $1
      order by 1`, [name]);
    for (const i of idx) {
      if (namaBatasan.has(i.name)) continue;
      daftarIndex.push(i.definisi.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ') + ';');
    }
  }
  if (daftarIndex.length) {
    bagian.push('', '-- Index');
    bagian.push(...daftarIndex);
  }

  // Foreign key dipasang setelah semua tabel ada.
  const fk = [];
  for (const { name } of tables) {
    const rows = await query(`
      select conname as name, pg_get_constraintdef(oid) as definisi
      from pg_constraint where conrelid = $1::regclass and contype = 'f'
      order by conname`, [`public."${name}"`]);
    for (const r of rows) {
      fk.push(`ALTER TABLE "${name}" ADD CONSTRAINT "${r.name}" ${r.definisi};`);
    }
  }
  if (fk.length) {
    bagian.push('', '-- Foreign key');
    bagian.push(...fk);
  }

  // Sequence diselaraskan oleh scripts/import-json.mjs setelah data masuk,
  // jadi tidak perlu setval di sini.

  return bagian.join('\n') + '\n';
}

function tulisReadme(manifest, tables) {
  const barisTabel = tables
    .map(({ name }) => `| \`${name}\` | ${manifest.tables[name].rows} |`)
    .join('\n');

  return `# Paket migrasi database

Dibuat ${manifest.generated_at} dari \`${manifest.database}\` (${manifest.server_version}).

**${manifest.tables && Object.keys(manifest.tables).length} tabel · ${manifest.total_rows} baris**

| Berkas | Isi |
|---|---|
| \`database.json\` | Semua tabel dalam satu berkas — paling mudah dipindah |
| \`<tabel>.json\` | Satu berkas per tabel |
| \`_schema.sql\` | DDL: sequence, tabel, constraint, index |
| \`_manifest.json\` | Jumlah baris & kolom |

## Isi per tabel

| Tabel | Baris |
|---|---|
${barisTabel}

## Cara impor di server tujuan

Cukup Node + \`pg\` (tanpa \`pg_restore\`):

\`\`\`bash
node scripts/import-json.mjs database.json \\
  --url "postgresql://user:pass@host:5432/db" \\
  --schema _schema.sql --truncate
\`\`\`

Tanpa \`--schema\` bila tabelnya sudah dibuat lebih dulu. Tanpa \`--truncate\` bila
tabel tujuan masih kosong.

## Catatan

- \`upload_staging\` **tidak** disertakan: isinya sesi unggah sementara (berkas
  dalam base64), bukan data yang perlu dimigrasi.
- Nilai \`numeric\`/\`double precision\` disimpan sebagai angka JSON; \`timestamp\`
  sebagai ISO-8601; \`bytea\` sebagai base64.
- Setelah impor, periksa jumlah baris terhadap tabel di atas.
`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  // Pooler (pgbouncer) bisa mewarisi search_path dari sesi lain; tanpa ini
  // 'select * from "tabel"' bisa membaca skema yang salah dan menghasilkan dump kosong.
  await query('set search_path to public');

  const semua = await query(`
    select c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by 1`);
  const tables = semua.filter((t) => !SEMENTARA.has(t.name));
  const dilewati = semua.filter((t) => SEMENTARA.has(t.name)).map((t) => t.name);

  const manifest = {
    generated_at: new Date().toISOString(),
    database: (await query('select current_database() as d'))[0].d,
    server_version: (await query('select version() as v'))[0].v.split(',')[0],
    schema: 'public',
    tables: {},
    total_rows: 0,
    dilewati,
  };

  // Bentuk berkas gabungan mengikuti kontrak scripts/import-json.mjs:
  //   { tables: { <nama>: { rows, columns, data: [...] } }, total_rows }
  const bundle = { generated_at: manifest.generated_at, database: manifest.database,
    schema: manifest.schema, total_rows: 0, tables: {} };

  for (const { name } of tables) {
    // stable order when the table has a primary key
    const pk = await query(`
      select a.attname
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary
      order by a.attnum`, [`public."${name}"`]);
    const orderBy = pk.length ? ` order by ${pk.map((r) => `"${r.attname}"`).join(', ')}` : '';
    const rows = (await query(`select * from "${name}"${orderBy}`)).map(normalise);

    const kolom = await query(`
      select count(*)::int as n from pg_attribute
      where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [`public."${name}"`]);

    const file = path.join(outDir, `${name}.json`);
    await fs.writeFile(file, JSON.stringify(rows, null, 2) + '\n', 'utf8');
    manifest.tables[name] = { rows: rows.length, columns: kolom[0].n };
    manifest.total_rows += rows.length;
    bundle.tables[name] = { rows: rows.length, columns: kolom[0].n, data: rows };
    console.log(`${name.padEnd(28)} ${String(rows.length).padStart(6)} rows -> ${file}`);
  }

  // Satu berkas gabungan: lebih mudah dipindah ke server lain.
  bundle.total_rows = manifest.total_rows;
  const gabungan = path.join(outDir, 'database.json');
  await fs.writeFile(gabungan, JSON.stringify(bundle, null, 2) + '\n', 'utf8');

  const skema = await tulisSkema(tables);
  await fs.writeFile(path.join(outDir, '_schema.sql'), skema, 'utf8');
  await fs.writeFile(path.join(outDir, 'README.md'), tulisReadme(manifest, tables), 'utf8');
  await fs.writeFile(path.join(outDir, '_manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const ukuran = async (n) => (await fs.stat(path.join(outDir, n))).size;
  console.log('');
  console.log(`database.json   ${(await ukuran('database.json') / 1048576).toFixed(1)} MB`);
  console.log(`_schema.sql     ${(await ukuran('_schema.sql') / 1024).toFixed(1)} KB`);
  console.log(`\ntotal rows: ${manifest.total_rows} across ${tables.length} tables`);
  if (dilewati.length) console.log(`dilewati (sementara): ${dilewati.join(', ')}`);
  console.log(`written to: ${outDir}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('dump failed:', err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
