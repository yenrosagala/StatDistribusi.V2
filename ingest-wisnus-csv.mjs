import pg from 'pg';
import fs from 'node:fs';

const s = fs.readFileSync('../.streamlit/secrets.toml','utf8').match(/^\s*DATABASE_URL\s*=\s*["']([^"']+)["']/m)?.[1];
const pool = new pg.Pool({connectionString:s, ssl:/supabase|sslmode=require/.test(s)?{rejectUnauthorized:false}:undefined});

const BULAN = {
  jan:1,feb:2,mar:3,apr:4,mei:5,may:5,jun:6,jul:7,
  ags:8,agt:8,aug:8,sep:9,okt:10,oct:10,nov:11,des:12,dec:12,
};

function bacaKolomBulan(label) {
  const m = /^([A-Za-z]{3})\.?'?\s*'?(\d{2})$/.exec(String(label || '').trim());
  if (!m) return null;
  const bulan = BULAN[m[1].toLowerCase()];
  if (!bulan) return null;
  return { bulan, tahun: 2000 + Number(m[2]) };
}

const csv = fs.readFileSync(
  'D:\\New Project\\Distribusi-main (1)\\Distribusi-main\\pariwisata\\Wisnus\\2026-10-16 Prov 96 Wisnus 2026-M09(Series Home KabKota).csv',
  'utf8');
const lines = csv.split(/\r?\n/).filter(l => l.trim());
const header = lines[0].split(',');

const kolom = [];
header.forEach((label, i) => {
  const b = bacaKolomBulan(label);
  if (b) kolom.push({ ...b, i });
});
console.log('month columns found:', kolom.length);

const vals = [];
for (let li = 1; li < lines.length; li++) {
  const cells = lines[li].split(',');
  const kode = cells[0]?.trim();
  const nama = cells[1]?.trim() || '';
  if (!/^\d+$/.test(kode)) continue;
  for (const { i, tahun, bulan } of kolom) {
    const n = Number(cells[i]) || 0;
    if (!n) continue;
    vals.push(['Papua Tengah', 'tujuan', kode, nama.replace(/^PAPUA--/, ''), tahun, bulan, Math.trunc(n)]);
  }
}

await pool.query(`CREATE TABLE IF NOT EXISTS wisnus_series (
  id bigserial PRIMARY KEY,
  prov text NOT NULL, arah text NOT NULL, kode_kab text NOT NULL, nama_kab text NOT NULL,
  tahun integer NOT NULL, bulan integer NOT NULL, jumlah integer NOT NULL,
  UNIQUE (prov, arah, kode_kab, tahun, bulan))`);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  // Delete existing Papua Tengah asal rows for the period covered
  await client.query(`DELETE FROM wisnus_series WHERE prov='Papua Tengah' AND arah='tujuan'`);
  for (let i = 0; i < vals.length; i += 500) {
    const chunk = vals.slice(i, i + 500);
    const ph = chunk.map((_, ri) => `($${ri*7+1},$${ri*7+2},$${ri*7+3},$${ri*7+4},$${ri*7+5},$${ri*7+6},$${ri*7+7})`).join(',');
    const params = chunk.flat();
    await client.query(`INSERT INTO wisnus_series (prov,arah,kode_kab,nama_kab,tahun,bulan,jumlah) VALUES ${ph}`, params);
  }
  await client.query('COMMIT');
  console.log('Inserted:', vals.length, 'rows for Papua Tengah tujuan');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
await pool.end();
