import pg from 'pg';
import fs from 'node:fs';

const s = fs.readFileSync('../.streamlit/secrets.toml','utf8').match(/^\s*DATABASE_URL\s*=\s*["']([^"']+)["']/m)?.[1];
const pool = new pg.Pool({connectionString:s, ssl:/supabase|sslmode=require/.test(s)?{rejectUnauthorized:false}:undefined});

const r = await pool.query(`
  SELECT prov, arah, COUNT(*) AS rows, MIN(tahun) AS thn1, MAX(tahun) AS thn2,
         MIN(bulan) AS bln1, MAX(bulan) AS bln2
  FROM wisnus_series
  GROUP BY prov, arah
  ORDER BY prov, arah`);
console.log(JSON.stringify(r.rows, null, 2));
await pool.end();
