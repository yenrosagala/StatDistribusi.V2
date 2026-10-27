# Deploying to Vercel

The app runs as a single serverless function: `api/index.js` re-exports the
request handler from `server.js`. When `VERCEL` is set, `server.js` does **not**
call `listen()`, and document export is disabled.

## Environment variables

Set these in Vercel → Project → Settings → Environment Variables:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | Supabase pooler string, port `6543` (transaction mode). Keep `?sslmode=require`. |
| `SESSION_SECRET` | strongly recommended | HMAC key for the `sid` cookie. If unset, a random secret is generated **per cold start**, which logs everyone out on every invocation. |
| `LOGIN_ADMIN_PASSWORD` | recommended | Defaults to `admin123`. |
| `LOGIN_USER_PASSWORD` | recommended | Defaults to `user123`. |

Because each serverless invocation is a fresh process, a **fixed
`SESSION_SECRET` is not optional** in practice.

## Deploy

```powershell
npm install --global vercel@latest
vercel login
cd node-app
vercel --prod
```

First deploy will ask to link/create the project. `vercel.json` already wires
the catch-all rewrite to `api/index.js` with 1024 MB / 60 s.

## What works on Vercel

- All pages, tabs, charts (Chart.js loads from CDN)
- Pariwisata and Transportasi dashboards and reports
- Admin ETL upload → preview → save (staged in the `upload_staging` table)
- Admin manual correction, delete-by-filter, series graphs
- Map PNG export (browser-side)

## What does **not** work on Vercel

**Document export** (PPTX / DOCX / IDML / XLSX). Those need `export_bridge.py`,
and Vercel's Node runtime has no Python and no long-lived process. The code path
is hard-disabled when `VERCEL` is set:

```js
const EXPORTS_DISABLED = process.env.VERCEL === '1' || process.env.DISABLE_EXPORTS === '1';
```

The UI already shows a banner explaining this instead of letting the button
fail. To restore exports, either run the app locally, or host
`export_service.py` separately and point the app at it:

```text
EXPORT_SERVICE_URL = https://your-export-service.example.com
DISABLE_EXPORTS    = (leave unset)
```

## Database objects added for serverless

`upload_staging` — replaces the old in-memory upload map. Created lazily by
`upload-store.js` on first use:

```sql
create table if not exists upload_staging (
  token      text primary key,
  kind       text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
```

Rows expire after 30 minutes (`UPLOAD_TTL_MS`). Expired rows are pruned on each
admin request.

## Assets

`style.css`, `logo.png`, and `papua_provinces.json` were moved from the repo root
into `public/` so they ship with the deployment. Nothing outside `node-app/` is
uploaded.


---

# Running standalone

`node-app` no longer needs the sibling Streamlit project. The Python modules it
uses are vendored into `vendor/py/`, and a small `streamlit.py` shim replaces
the Streamlit dependency.

```
node-app/
  vendor/py/
    streamlit.py          <- shim: secrets, cache decorators, no-op widgets
    modules/              <- ai_backup, config, database, report_page,
                             etl_engine, indesign_export, indesign_pariwisata
  public/fonts/           <- Lato TTFs used by the summary PDF
  templates/              <- IDML templates (57.7 MB, committed)
```

## Setup

```powershell
cd node-app
npm install
npm run templates        # optional, only needed for IDML export
npm run export-service   # terminal 1 (AI summary + document exports)
npm start                # terminal 2
```

The InDesign templates ship with the repository (`templates/`, 57.7 MB of Adobe
assets, 42 files), so a fresh clone is ready to export IDML immediately.
`npm run templates` remains available to refresh them from a sibling checkout
or from `$TEMPLATES_SRC`.

## Configuration

AI keys and the database URL are read in this order:

1. environment variables (`GEMINI_API_KEYS`, `OPENROUTER_API_KEY`, `DATABASE_URL`, ...)
2. `node-app/.streamlit/secrets.toml`
3. `<parent>/.streamlit/secrets.toml` (the original Streamlit project, if present)

So a standalone clone works with plain environment variables alone.

## What works standalone

| Feature | Needs |
|---|---|
| Dashboards, reports, map, admin | Node + PostgreSQL |
| Growth justifications | PostgreSQL |
| **AI summary** | vendored `ai_backup` + API key |
| **Summary PDF** | vendored fonts |
| PPTX / DOCX / XLSX export | vendored modules |
| **IDML export** | vendored modules (templates are included) |

If `templates/` is missing, IDML export fails with an explicit
"Template InDesign ... tidak ditemukan" message; everything else is unaffected.
