/**
 * Dump every table of the configured database to JSON, one file per table plus a
 * manifest, following the layout in backup/README.md:
 *
 *   backup/json_<stamp>/<table>.json   JSON array of rows
 *   backup/json_<stamp>/_manifest.json metadata + row counts
 *
 * Run: node scripts/dump-json.mjs [outDir]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const outDir = process.argv[2] || path.join('backup', `json_${stamp}`);

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

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const tables = await query(`
    select c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by 1`);

  const manifest = {
    generated_at: new Date().toISOString(),
    database: (await query('select current_database() as d'))[0].d,
    server_version: (await query('select version() as v'))[0].v.split(',')[0],
    schema: 'public',
    tables: {},
    total_rows: 0,
  };

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

    const file = path.join(outDir, `${name}.json`);
    await fs.writeFile(file, JSON.stringify(rows, null, 2) + '\n', 'utf8');
    manifest.tables[name] = { rows: rows.length, columns: rows[0] ? Object.keys(rows[0]).length : 0 };
    manifest.total_rows += rows.length;
    console.log(`${name.padEnd(28)} ${String(rows.length).padStart(6)} rows -> ${file}`);
  }

  await fs.writeFile(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`\ntotal rows: ${manifest.total_rows} across ${tables.length} tables`);
  console.log(`written to: ${outDir}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('dump failed:', err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
