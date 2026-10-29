// Supervise the Python export sidecar (export_service.py).
//
// The sidecar caches its modules in memory. After any edit to export_bridge.py,
// the vendored modules or the prompt files, a running sidecar keeps serving the
// OLD code and only says so via /health {"stale": [...]} -- which used to mean a
// human had to notice the warning and restart it by hand. Twice during
// development that produced exports built from stale logic.
//
// This launcher owns the whole lifecycle instead:
//   * starts export_service.py with the same interpreter resolution as export.js
//   * polls /health and auto-restarts when the sidecar reports stale modules
//   * restarts if the process dies, with a capped backoff
//   * prints one clear, actionable line when Python itself is unavailable
//
//   node scripts/export-supervisor.mjs            (foreground; Ctrl+C stops it)
//   node scripts/export-supervisor.mjs --once     (start + verify, then exit)
//
// Env:
//   PYTHON_BIN        interpreter (default python on Windows, python3 elsewhere)
//   EXPORT_SERVICE_PORT  default 8765
//   EXPORT_SUPERVISOR_INTERVAL_MS  health poll interval (default 5000)
import { spawn } from 'node:child_process';
import path from 'node:path';

const HERE = import.meta.dirname.replace(/[\\/]scripts$/, '');
const SERVICE = path.join(HERE, 'export_service.py');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const PORT = Number(process.env.EXPORT_SERVICE_PORT || 8765);
const BASE = (process.env.EXPORT_SERVICE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const POLL_MS = Number(process.env.EXPORT_SUPERVISOR_INTERVAL_MS || 5000);
const ONCE = process.argv.includes('--once');

const log = (msg) => console.log(`[supervisor] ${msg}`);
const warn = (msg) => console.warn(`[supervisor] ${msg}`);

let child = null;
let stopping = false;
let restartTimer = null;
let backoffMs = 500;
let consecutiveFailures = 0;

function health(timeoutMs = 2000) {
  return fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

/** True when the interpreter can at least be executed at all. */
function pythonProbe() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    let p;
    try {
      p = spawn(PYTHON, ['--version'], { windowsHide: true });
    } catch (err) {
      return finish({ ok: false, code: err.code || 'UNKNOWN', message: String(err.message || err) });
    }
    let stderr = '';
    p.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    p.on('error', (err) => finish({ ok: false, code: err.code || 'UNKNOWN', message: String(err.message || err) }));
    p.on('close', (code) => finish(
      code === 0
        ? { ok: true }
        : { ok: false, code: `EXIT_${code}`, message: stderr.trim() || `exit ${code}` },
    ));
    setTimeout(() => finish({ ok: false, code: 'TIMEOUT', message: 'python --version tidak merespons' }), 15000);
  });
}

function explainProbe(probe) {
  switch (probe.code) {
    case 'ENOENT':
      return `Python tidak ditemukan ("${PYTHON}"). Pasang Python 3, aktifkan venv, `
        + 'lalu set PYTHON_BIN ke path python.exe. Lihat requirements.txt.';
    case 'EPERM':
      return 'Proses anak (child process) diblokir di lingkungan ini (EPERM). '
        + 'Jalankan supervisor ini dari terminal biasa, bukan dari sandbox/IDE yang membatasi spawn.';
    case 'EACCES':
      return `Tidak punya izin mengeksekusi "${PYTHON}".`;
    default:
      return `Python gagal dijalankan (${probe.code}): ${probe.message}`;
  }
}

function startChild() {
  if (stopping) return;
  log(`menjalankan ${PYTHON} export_service.py ${PORT}`);
  try {
    child = spawn(PYTHON, [SERVICE, String(PORT)], {
      cwd: HERE,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (err) {
    warn(`gagal menjalankan sidecar: ${err.message}`);
    return scheduleRestart();
  }
  child.on('error', (err) => {
    warn(`sidecar error: ${err.code || err.message}`);
    if (err.code === 'ENOENT' || err.code === 'EPERM') {
      warn(explainProbe({ code: err.code, message: err.message }));
      stopping = true;
      process.exitCode = 1;
    }
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    warn(`sidecar berhenti (kode ${code ?? '-'}${signal ? `, ${signal}` : ''})`);
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (stopping || ONCE) return;
  clearTimeout(restartTimer);
  const wait = Math.min(backoffMs, 15000);
  backoffMs = Math.min(backoffMs * 2, 15000);
  log(`restart dalam ${Math.round(wait / 1000)}s`);
  restartTimer = setTimeout(startChild, wait);
}

/** Stop the current sidecar and start a fresh one (picks up new code on disk). */
function restart(reason) {
  log(`restart: ${reason}`);
  clearTimeout(restartTimer);
  const target = child;
  if (!target) return startChild();
  target.once('exit', () => { if (!stopping) startChild(); });
  try {
    target.kill();
  } catch {
    startChild();
  }
}

async function poll() {
  const h = await health();
  if (!h) { consecutiveFailures += 1; return; }
  if (consecutiveFailures > 0) {
    consecutiveFailures = 0;
    backoffMs = 500;
  }
  if (Array.isArray(h.stale) && h.stale.length) {
    restart(`kode berubah di disk (${h.stale.join(', ')})`);
  }
}

async function main() {
  if (ONCE) {
    const probe = await pythonProbe();
    if (!probe.ok) {
      warn(explainProbe(probe));
      process.exitCode = 1;
      return;
    }
    log(`python siap (${PYTHON})`);
    const existing = await health();
    if (existing) {
      log(`sidecar sudah berjalan (pid ${existing.pid}); stale: ${(existing.stale || []).join(', ') || 'tidak'}`);
      return;
    }
    startChild();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const h = await health();
      if (h) { log(`sidecar siap (pid ${h.pid})`); return; }
    }
    warn('sidecar tidak merespons /health setelah 10 detik');
    process.exitCode = 1;
    return;
  }

  const probe = await pythonProbe();
  if (!probe.ok) {
    warn(explainProbe(probe));
    process.exitCode = 1;
    return;
  }
  const existing = await health();
  if (existing) {
    // Adopt the running sidecar rather than fighting it for the port: the port
    // refuses a second bind on purpose (see SingleBind in export_service.py).
    log(`mengawasi sidecar yang sudah berjalan (pid ${existing.pid})`);
    child = null;
  } else {
    startChild();
  }

  const timer = setInterval(poll, POLL_MS);
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearTimeout(restartTimer);
    log(`${signal} diterima, menghentikan sidecar`);
    if (child) { try { child.kill(); } catch { /* already gone */ } }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  warn(`supervisor gagal: ${err.message}`);
  process.exitCode = 1;
});