import pg from 'pg';
import fs from 'node:fs';

const s = fs.readFileSync('../.streamlit/secrets.toml','utf8').match(/^\s*DATABASE_URL\s*=\s*["']([^"']+)["']/m)?.[1];
const pool = new pg.Pool({connectionString:s, ssl:/supabase|sslmode=require/.test(s)?{rejectUnauthorized:false}:undefined});

const r = await pool.query(
  `SELECT province, year, month, jenis_akomodasi, indicator, LEFT(narrative, 200) AS preview
   FROM pariwisata_ai_narratives 
   WHERE jenis_akomodasi IN ('wisman','wisnus') 
   ORDER BY year DESC, month DESC`);
console.log(r.rows);
await pool.end();
