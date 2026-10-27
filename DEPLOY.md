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
