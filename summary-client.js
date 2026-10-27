import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_URL = (process.env.EXPORT_SERVICE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const TIMEOUT_MS = Number(process.env.SUMMARY_TIMEOUT_MS || 180_000);

async function serviceUp() {
  try {
    const r = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function postService(pathname, payload) {
  const res = await fetch(`${SERVICE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

function runPython(script, payload, outPath) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PYTHON, outPath ? [path.join(HERE, script), outPath] : [path.join(HERE, script)], {
        cwd: path.resolve(HERE, '..'),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      });
    } catch (err) {
      return reject(err);
    }
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      reject(new Error(err.trim().split(/\r?\n/).filter(Boolean).at(-1) || `python gagal (${code})`));
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Ask the AI for a summary. Returns { summary, source } or throws. */
export async function generateSummary(payload) {
  if (await serviceUp()) {
    const res = await postService('/summary', payload);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || `service ${res.status}`);
    return body;
  }
  const out = await runPython('gen_summary.py', payload);
  const body = JSON.parse(out.trim() || '{}');
  if (body.error) throw new Error(body.error);
  return body;
}

/** Render the PDF. Returns a Buffer. */
export async function renderSummaryPdf(payload) {
  if (await serviceUp()) {
    const res = await postService('/summary-pdf', payload);
    if (!res.ok) {
      let detail = `service ${res.status}`;
      try { const j = await res.json(); if (j.error) detail = j.error; } catch { /* binary */ }
      throw new Error(detail);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dist-summary-'));
  const outPath = path.join(dir, 'summary.pdf');
  try {
    await runPython('summary_pdf.py', payload, outPath);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
