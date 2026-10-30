import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE = path.join(HERE, 'export_bridge.py');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

// Optional sidecar (export_service.py). Preferred over spawning because some
// sandboxes block child-process creation outright (`spawn EPERM`).
const SERVICE_URL = (process.env.EXPORT_SERVICE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const SERVICE_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || 300_000);
const HEALTH_TIMEOUT_MS = 1500;

// Vercel has no Python runtime and no long-lived process, so document export
// cannot work there. Skip every spawn attempt and report it cleanly.
const EXPORTS_DISABLED = process.env.VERCEL === '1' || process.env.DISABLE_EXPORTS === '1';
const DISABLED_MESSAGE = 'Ekspor dokumen tidak tersedia pada deployment Vercel (butuh Python bridge). '
  + 'Jalankan aplikasi secara lokal atau gunakan sidecar export_service.py.';

export const EXPORT_MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'idml-transport': 'application/zip',
  'idml-pariwisata': 'application/zip',
  'idml-exim': 'application/zip',
};

export function exportFileName(kind, payload) {
  const period = `${payload.bln}_${payload.thn}`;
  if (kind === 'pptx') return `dashboard_transportasi_${period}.pptx`;
  const prov = String(payload.prov || 'Papua').replace(/\s+/g, '_');
  if (kind === 'xlsx-transport') return `Tabel_Transportasi_${prov}_${period}.xlsx`;
  if (kind === 'xlsx-pariwisata') return `Tabel_Pariwisata_${prov}_${period}.xlsx`;
  if (kind === 'docx') return `Master_Laporan_Transportasi_${prov}_${period}.docx`;
  if (kind === 'idml-exim') return `BRS_Exim_${prov}_${period}.zip`;
  if (kind === 'idml-transport') return `BRS_Transportasi_${prov}_${period}.zip`;
  return `BRS_Pariwisata_${prov}_${period}.zip`;
}

function explain(code) {
  switch (code) {
    case 'EPERM':
      return 'Proses anak (child process) tidak diizinkan dijalankan pada lingkungan ini. '
        + `Jalankan sidecar \`python export_service.py\` lalu set EXPORT_SERVICE_URL=${SERVICE_URL}, `
        + 'atau jalankan `node server.js` dari terminal biasa.';
    case 'ENOENT':
      return `Python tidak ditemukan ("${PYTHON}"). Pasang Python, atau set PYTHON_BIN ke path python.exe.`;
    case 'EACCES':
      return `Tidak punya izin mengeksekusi "${PYTHON}".`;
    default:
      return 'Terjadi kesalahan saat menjalankan Python.';
  }
}

function bridgeError(err, args) {
  const code = err.code || 'UNKNOWN';
  const e = new Error(
    `Ekspor dokumen tidak dapat dijalankan: Python bridge gagal dimulai (${code}). `
    + `${explain(code)} Perintah: ${PYTHON} ${args.join(' ')}`,
  );
  e.code = code;
  return e;
}

// ---------------------------------------------------------------- sidecar path
async function serviceHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    return await res.json().catch(() => ({}));   // detail: pid, stale, hint
  } catch {
    return false;
  }
}

async function runViaService(kind, payload) {
  let res;
  try {
    res = await fetch(`${SERVICE_URL}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, payload }),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(`Ekspor gagal: tidak dapat menghubungi export service di ${SERVICE_URL} (${err.code || err.message}).`);
    e.code = err.code || 'ESERVICE';
    throw e;
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) detail = body.error;
    } catch { /* non-JSON error body */ }
    throw new Error(`Ekspor gagal (${kind}): ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ----------------------------------------------------------------- bridge path
function runBridge(args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PYTHON, args, {
        cwd: ROOT,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      });
    } catch (err) {
      return reject(bridgeError(err, args));
    }
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => reject(bridgeError(err, args)));
    child.on('close', (code) => {
      if (code === 0) return resolve(stderr);
      reject(new Error(stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) || `ekspor gagal (kode ${code})`));
    });
  });
}

async function runViaBridge(kind, payload) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dist-export-'));
  const payloadPath = path.join(dir, 'payload.json');
  const outPath = path.join(dir, 'out.bin');
  try {
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');
    const out = await runBridge([BRIDGE, kind, payloadPath, outPath]);
    if (out.trim()) console.log(`[export] ${out.trim()}`);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- public
export async function runExport(kind, payload) {
  if (EXPORTS_DISABLED) { const err = new Error(DISABLED_MESSAGE); err.code = 'EXPORT_DISABLED'; throw err; }
  if (await serviceHealth()) return runViaService(kind, payload);
  return runViaBridge(kind, payload);
}

// Cached capability probe. Re-probes every 15s while unavailable so starting
// the sidecar later is picked up without a server restart.
const STARTED_AT = Date.now();
const BUILD = process.env.APP_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || 'dev';
let cached = null;
export async function checkExporter() {
  if (EXPORTS_DISABLED) return { ok: false, mode: 'disabled', message: DISABLED_MESSAGE };
  // Status used to be cached forever once it was ok (`cached.ok ||` short-circuited
  // the TTL), so a sidecar that died kept reporting "siap". Re-probe after a longer
  // TTL when healthy, quickly when broken.
  const ttl = cached && cached.ok
    ? Number(process.env.EXPORT_STATUS_TTL_MS || 300_000)
    : 15_000;
  // Hasil "stale" tidak boleh di-cache: begitu sidecar di-restart, status harus
  // langsung bersih tanpa menunggu TTL 5 menit.
  const basi = Boolean(cached && cached.stale && cached.stale.length);
  const fresh = cached && !basi && Date.now() - cached.checkedAt < ttl;
  if (fresh) return cached;

  const health = await serviceHealth();
  if (health) {
    cached = {
      ok: true, mode: 'service', service: SERVICE_URL, build: BUILD,
      svcBuild: health.pid, stale: health.stale || [], checkedAt: Date.now(),
    };
    if (cached.stale.length) {
      cached.warning = `Sidecar berjalan dengan kode lama (${cached.stale.join(', ')}). `
        + 'Jalankan `node scripts/export-supervisor.mjs` agar restart otomatis.';
      console.warn(`[export] ${cached.warning}`);
    }
    return cached;
  }
  try {
    await runBridge(['--version']);
    cached = { ok: true, mode: 'bridge', python: PYTHON, build: BUILD, checkedAt: Date.now() };
  } catch (err) {
    const gagal = {
      ok: false, mode: 'none', service: SERVICE_URL, python: PYTHON, bridge: BRIDGE,
      code: err.code || 'UNKNOWN', message: err.message, build: BUILD, checkedAt: Date.now(),
    };
    // Jangan cache kegagalan pada 30 detik pertama proses: sidecar butuh beberapa
    // detik untuk siap, dan tanpa ini banner sempat muncul di kunjungan pertama.
    cached = Date.now() - STARTED_AT < 30_000 ? null : gagal;
    return gagal;
  }
  return cached;
}
