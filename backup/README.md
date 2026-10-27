# Database backup

Local snapshot of the Supabase PostgreSQL database used by this dashboard.

## Contents

| File | What it is |
|---|---|
| `distribusi_<stamp>.sql` | Full `pg_dump` of schema `public` — `CREATE TABLE` + `COPY` data. This is the restore source. |
| `schema_<stamp>.sql` | Schema only (no rows), handy for a quick structural diff. |
| `json_<stamp>/` | Every table as a JSON array of rows, plus `_manifest.json` with row counts. Portable, easy to inspect. |

## Tables captured

| Table | Rows |
|---|---|
| `all_data` | 556 |
| `pariwisata_ref_avg` | 160 |
| `transportasi_udara` | 588 |
| `transportasi_laut` | 282 |
| `ai_narratives` | 94 |
| `ai_narratives_cache` | 68 |
| `pariwisata_ai_narratives` | 20 |
| `wilayah` | 0 |

Supabase's own `auth` / `storage` schemas are **not** included — only the
application schema `public`.

## Restoring

The dump is created with `--clean --if-exists`, so it drops and recreates each
table. Restore into an **empty** database (or accept that app tables get
replaced):

```powershell
$env:PGPASSWORD = "<db-password>"
psql "postgresql://postgres.<project-ref>@<host>:5432/postgres?sslmode=require" `
     -v ON_ERROR_STOP=1 -f backup/distribusi_<stamp>.sql
```

Verify afterwards:

```sql
select 'all_data' t, count(*) from all_data
union all select 'pariwisata_ref_avg', count(*) from pariwisata_ref_avg
union all select 'transportasi_udara', count(*) from transportasi_udara
union all select 'transportasi_laut', count(*) from transportasi_laut;
```

## Re-running the backup

```powershell
cd node-app
pg_dump "$env:DATABASE_URL" --schema=public --no-owner --no-privileges `
        --clean --if-exists -f backup/distribusi_$(Get-Date -Format yyyyMMdd-HHmmss).sql

node _dumpjson.mjs      # JSON copy
```

> **Note:** `DATABASE_URL` currently points at the Supabase **pooler** on port
> `6543` (transaction mode). `pg_dump` worked through it, but if you ever see
> `prepared statement ... already exists`, retry on port `5432` (session mode)
> or the direct database host.

## What is committed vs local

| Path | In git? | Why |
|---|---|---|
| `schema_<date>.sql` | **yes** | lets a fresh clone bootstrap an empty database |
| `README.md` | **yes** | this file |
| `distribusi_<stamp>.sql` | no | full dump, real production data |
| `json_<stamp>/` | no | per-table JSON, real production data |

Regenerate the schema (includes `growth_notes`, `growth_summaries` and
`upload_staging`):

```powershell
cd node-app
pg_dump "$env:DATABASE_URL" --schema=public --schema-only --no-owner --no-privileges --clean --if-exists -f "backup/schema_$(Get-Date -Format yyyyMMdd).sql"
```

Bootstrapping a new database from it:

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f backup/schema_<date>.sql
```
