import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  availablePeriods, cumulativeData, infographicRows, latestMetrics, narrative, pariwisataInfo,
  periodData, pool, reportDomain, reportNarratives, reportRef, reportRows,
  transportNarratives, transportReportRows,
} from './db.js';
import {
  errorPage, landingPage, loginPage, pariwisataPage, setExportAvailability, transportasiPage,
} from './views.js';
import {
  INV_MONTH_MAP, MONTH_ABBR, PROVINSI_ORDER, aggByProvinsi, computeStats, fallbackNarrative, formatIdNumber,
  MONTH_NAMES, growthRows, mean, monthIndexOf, monthNameEn, pctChange, periodLabel, periodsFromInfo, prevPeriod,
  reportTable, sortPeriods, uniqueSorted, yoySeries,
} from './lib.js';
import {
  fallbackTransportNarrative, normalizeNarrative, transportReport,
} from './lib-transport.js';
import {
  ADMIN_TABLES, buildSeriesQuery, deleteFiltered, deleteRows, distinctYears, entityOptions,
  kabupatenOptions, periodRows, replacePeriod, rowsToTsv, seriesData, tsvToRows,
} from './admin-transport.js';
import { PEMETAAN_WILAYAH, computeUploadStats, countExistingRows, detectFileMetadata, parseTransportFile, savePeriod } from './etl-transport.js';
import Busboy from 'busboy';
import { EXPORT_MIME, checkExporter, exportFileName, runExport } from './export.js';
import { deleteStaged, getStaged, pruneStaged, putStaged, stagingStore } from './upload-store.js';
import { cellKey, deleteNote, getNote, normaliseCell, noteKeysFor, saveNote } from './growth-notes.js';
import { collectNotes, getCached, hashNotes, monthName, notePeriods, saveSummary } from './growth-summary.js';
import { generateSummary, renderSummaryPdf } from './summary-client.js';
import { buildSeries, isKnownIndicator } from './growth-series.js';
import { buildPariwisataAdmin } from './pariwisata-admin.js';
import {
  PARIWISATA_SHEET, parsePariwisataFile, savePariwisata, countExistingPeriods,
  tsvToRows as pariwisataTsvToRows, replacePeriods as replacePariwisataPeriods,
  deleteFiltered as deletePariwisataFiltered, readSheet as readPariwisataSheet,
} from "./etl-pariwisata.js";

const PORT = Number(process.env.PORT || 8502);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'sid';
const SESSION_SECONDS = 8 * 3600;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
// Directory holding the Python bridge scripts (gen_narrative.py, gen_summary.py).
const NODE_ROOT = fileURLToPath(new URL('./', import.meta.url));
// Same interpreter resolution as export.js / summary-client.js so all three spawn
// sites agree; PYTHON_BIN overrides it where `python` is not on PATH.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
// Optional sidecar (export_service.py). Preferred over spawning because some
// sandboxes block child-process creation outright (`spawn EPERM`).
const NARRATIVE_SERVICE_URL = (process.env.EXPORT_SERVICE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const NARRATIVE_TIMEOUT_MS = Number(process.env.NARRATIVE_TIMEOUT_MS || 180_000);
// ROOT_DIR kept for reference: assets are served from public/ now.

const USERS = {
  admin: { password: process.env.LOGIN_ADMIN_PASSWORD || 'admin123', role: 'admin', name: 'Database Administrator' },
  user: { password: process.env.LOGIN_USER_PASSWORD || 'user123', role: 'user', name: 'General Analyst' },
  // Report-only analyst: tables, charts and the justification dialog. No
  // admin tab, no exports (enforced server-side, not just hidden in the UI).
  rekon: { password: process.env.LOGIN_REKON_PASSWORD || 'rekon123', role: 'rekon', name: 'Analis Rekon' },
};

// Single source of truth for which tabs a role may open.
const ROLE_TABS = {
  admin: ['dashboard', 'report', 'admin'],
  user: ['dashboard', 'report'],
  rekon: ['report'],
};
const ROLE_TABS_PARIWISATA = {
  admin: ['home', 'map', 'report', 'admin'],
  user: ['home', 'map', 'report'],
  rekon: ['report'],
};
const tabsFor = (map, role) => map[role] || map.user;

const MODA = [
  {
    title: 'Laut',
    table: 'transportasi_laut',
    satuan: 'ton',
    colsP: ['dn_penumpang_naik', 'dn_penumpang_turun'],
    colsB: ['dn_muat_barang_ton', 'dn_bongkar_barang_ton'],
    labelsP: ['PENUMPANG BERANGKAT', 'PENUMPANG DATANG'],
    labelsB: ['MUAT BARANG', 'BONGKAR BARANG'],
    colorsP: ['#047857', '#6EE7B7'],
    colorsB: ['#B45309', '#FCD34D'],
  },
  {
    title: 'Udara',
    table: 'transportasi_udara',
    satuan: 'kg',
    colsP: ['penumpang_berangkat', 'penumpang_datang'],
    colsB: ['barang_muat_kg', 'barang_bongkar_kg'],
    labelsP: ['PENUMPANG BERANGKAT', 'PENUMPANG DATANG'],
    labelsB: ['MUAT BARANG', 'BONGKAR BARANG'],
    colorsP: ['#0F766E', '#5EEAD4'],
    colorsB: ['#9A3412', '#FDBA74'],
  },
];

const TARGET_PROVINCES = ['Papua', 'Papua Tengah', 'Papua Pegunungan', 'Papua Selatan'];
const JENIS_LABELS = {
  'Hotel Bintang': 'Klasifikasi Bintang',
  'Hotel Non Bintang': 'Klasifikasi NonBintang',
};
// Report tables: 4 metrics per modality, in the order modules/report_page.py
// collects them (udara first, then laut), numbering 1..8 across both.
const TRANSPORT_TARGETS = [
  {
    moda: 'Transportasi Udara',
    icon: 'plane',
    table: 'transportasi_udara',
    rowCol: 'nama_bandara',
    cols: [
      ['penumpang_datang', 'Penumpang Datang'],
      ['penumpang_berangkat', 'Penumpang Berangkat'],
      ['barang_bongkar_kg', 'Barang Bongkar (Ton)'],
      ['barang_muat_kg', 'Barang Muat (Ton)'],
    ],
  },
  {
    moda: 'Transportasi Laut',
    icon: 'ship',
    table: 'transportasi_laut',
    rowCol: 'nama_pelabuhan',
    cols: [
      ['dn_penumpang_turun', 'Penumpang Turun'],
      ['dn_penumpang_naik', 'Penumpang Naik'],
      ['dn_bongkar_barang_ton', 'Barang Bongkar (Ton)'],
      ['dn_muat_barang_ton', 'Barang Muat (Ton)'],
    ],
  },
];

const INDICATOR_META = {
  tpk: { label: 'TPK (Occupancy Rate)', short: 'TPK', unit: '%' },
  rlmtgab: { label: 'RLMTGAB (Length of Stay)', short: 'RLMT', unit: ' malam' },
};

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const given = Buffer.from(mac || '');
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data.exp > Math.floor(Date.now() / 1000) ? data : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function json(res, body, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** Roles that may download generated documents. */
const EXPORT_ROLES = new Set(['admin', 'user']);
function denyExport(session) {
  return !EXPORT_ROLES.has(session.role);
}

/**
 * Runs the Python bridge (gen_narrative.py) for the narrative endpoints.
 * The script reads one JSON object on stdin and prints one JSON object on stdout.
 * Resolves with the parsed payload; rejects with an Error whose message is safe to
 * show to the user. Mirrors the spawn handling in summary-client.js / export.js.
 */
async function runNarrativeBridge(values) {
  // Prefer the sidecar: some sandboxes deny child-process creation outright.
  const viaService = await postNarrativeService(values);
  if (viaService) return viaService;
  return spawnNarrativeBridge(values);
}

/** POSTs to the sidecar. Returns null when no sidecar is listening. */
async function postNarrativeService(values) {
  try {
    const health = await fetch(`${NARRATIVE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) return null;
  } catch {
    return null;
  }
  const res = await fetch(`${NARRATIVE_SERVICE_URL}/narrative`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
    signal: AbortSignal.timeout(NARRATIVE_TIMEOUT_MS),
  });
  return res.json();
}

function spawnNarrativeBridge(values) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PYTHON_BIN, ['gen_narrative.py'], {
        cwd: NODE_ROOT,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      });
    } catch (err) {
      return reject(new Error(`Python bridge gagal dimulai (${err.code || err.message}).`));
    }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    // `error` fires for spawn failures that happen asynchronously (EPERM/EACCES/ENOENT).
    child.on('error', (e) => {
      reject(new Error(`Python bridge gagal dimulai (${e.code || e.message}).`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = (err || out).split('\n').filter(Boolean).slice(-3).join(' ');
        return reject(new Error(detail || `gen_narrative.py keluar dengan kode ${code}.`));
      }
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        reject(new Error('Python bridge mengembalikan JSON yang tidak valid.'));
      }
    });
    child.stdin.write(JSON.stringify(values));
    child.stdin.end();
  });
}
function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function sendFile(res, body, contentType, filename) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  // Assets live in public/ so the Vercel bundle can serve them.
  const root = PUBLIC_DIR;
  const file = path.join(root, path.basename(pathname));
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    sendHtml(res, errorPage('Berkas tidak ditemukan.'), 404);
  }
}

function growthTable(rows, labels) {
  return {
    columns: ['PROVINSI', ...labels.map((label) => `${label} (%)`)],
    rows: rows.map((r) => [
      r.provinsi,
      ...r.values.map((v) => (v == null || !Number.isFinite(v) ? '' : formatIdNumber(v, 2))),
    ]),
  };
}

function pickPeriod(periods, raw) {  const fallback = periods.at(-1);
  const match = /^(\d{4})-(.+)$/.exec(raw || '');
  if (!match) return fallback;
  return periods.find((p) => String(p.thn) === match[1] && p.bln === match[2]) || fallback;
}

async function buildSection(moda, selected, prev) {
  const [rowsCurr, rowsPrev, cumCurr, cumPrev] = await Promise.all([
    periodData(moda.table, selected.thn, selected.bln),
    periodData(moda.table, prev.thn, prev.bln),
    cumulativeData(moda.table, selected.thn, selected.bln),
    cumulativeData(moda.table, prev.thn, prev.bln),
  ]);

  const allCols = [...moda.colsP, ...moda.colsB];
  const aggCurr = aggByProvinsi(rowsCurr, allCols);
  const aggPrev = aggByProvinsi(rowsPrev, allCols);
  const aggCumCurr = aggByProvinsi(cumCurr, allCols);
  const aggCumPrev = aggByProvinsi(cumPrev, allCols);

  const periode = periodLabel(selected.thn, selected.bln);
  const periodeLabel = `${MONTH_ABBR[prev.bln]}-${MONTH_ABBR[selected.bln]} ${selected.thn}`;
  const key = moda.title.toLowerCase();

  if (rowsCurr.length === 0) {
    return { moda: moda.title, periode, empty: true, charts: [] };
  }

  const penumpang = computeStats(aggCurr, aggPrev, aggCumCurr, aggCumPrev, moda.colsP);
  const barang = computeStats(aggCurr, aggPrev, aggCumCurr, aggCumPrev, moda.colsB);

  const cached = await narrative(`dashboard_${moda.table}`, `${selected.bln}|${selected.thn}`);
  const paras = cached
    ? cached.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    : fallbackNarrative(moda.title, selected.bln, selected.thn, prev.bln, prev.thn, penumpang, barang, moda.satuan);

  const charts = [
    {
      id: `ch-${key}-p`,
      labels: PROVINSI_ORDER,
      title: `Penumpang ${moda.title} — ${selected.bln} ${selected.thn}`,
      datasets: moda.colsP.map((col, i) => ({
        label: moda.labelsP[i],
        color: moda.colorsP[i],
        data: PROVINSI_ORDER.map((p) => aggCurr[p][col]),
      })),
    },
    {
      id: `ch-${key}-b`,
      labels: PROVINSI_ORDER,
      title: `Barang (${moda.satuan}) ${moda.title} — ${selected.bln} ${selected.thn}`,
      datasets: moda.colsB.map((col, i) => ({
        label: moda.labelsB[i],
        color: moda.colorsB[i],
        data: PROVINSI_ORDER.map((p) => aggCurr[p][col]),
      })),
    },
  ];

  return {
    moda: moda.title,
    periode,
    periodeLabel,
    labelsP: moda.labelsP,
    labelsB: moda.labelsB,
    charts,
    growthP: growthRows(aggCurr, aggPrev, moda.colsP, moda.labelsP),
    growthB: growthRows(aggCurr, aggPrev, moda.colsB, moda.labelsB),
    narrative: { paras, source: cached ? 'Database (Cached)' : 'Template otomatis (tanpa AI)' },
    raw: rowsCurr,
    empty: false,
  };
}

async function loadTransportReport(url, periods, selected, session = { role: 'admin' }) {
  const years = uniqueSorted(periods.map((p) => p.thn));
  const provinces = ['Papua', 'Papua Selatan', 'Papua Tengah', 'Papua Pegunungan'];
  const wantProv = url.searchParams.get('provinsi');
  const province = provinces.includes(wantProv) ? wantProv : provinces[0];
  const wantYear = Number(url.searchParams.get('tahun'));
  const year = years.includes(wantYear) ? wantYear : selected.thn;
  const wantMonth = url.searchParams.get('bulan');
  const monthName = MONTH_NAMES.includes(wantMonth) ? wantMonth : selected.bln;
  const prev = prevPeriod(year, monthName);

  const [udara, laut] = await Promise.all([
    transportReportRows('transportasi_udara', province, year),
    transportReportRows('transportasi_laut', province, year),
  ]);
  const rowsBy = { transportasi_udara: udara, transportasi_laut: laut };

  const types = TRANSPORT_TARGETS.flatMap((t) => t.cols.map(([, label]) => `report_${t.moda}_${label}`));
  // The rekon role is a report-only viewer: skip the narrative lookup entirely.
  const wantsNarrative = session.role !== 'rekon';
  const cached = new Map();
  if (wantsNarrative) {
    try {
      for (const r of await transportNarratives(types, `${province}|${monthName}|${year}`)) {
        cached.set(r.report_type, r.narrative_text);
      }
    } catch (err) {
      console.warn(`[report] cache narasi transportasi tidak terbaca: ${err.message}`);
    }
  }

  let tableNo = 0;
  const groups = [];
  for (const target of TRANSPORT_TARGETS) {
    const rows = rowsBy[target.table];
    const hasCurrent = rows.some((r) => Number(r.tahun) === year && r.bulan === monthName);
    if (!hasCurrent) continue;
    const rowCol = target.moda === 'Transportasi Laut' && province === 'Papua Tengah'
      ? 'nama_kabkota'
      : target.rowCol;
    const items = target.cols.map(([col, label]) => {
      tableNo += 1;
      const table = transportReport(rows, {
        col, label, rowCol, moda: target.moda, prov: province,
        year, monthName, prevYear: prev.thn, prevMonthName: prev.bln,
      });
      const cachedText = cached.get(`report_${target.moda}_${label}`);
      const paras = cachedText
        ? normalizeNarrative(cachedText, col).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
        : normalizeNarrative(fallbackTransportNarrative({
          total: table.total, meta: table.meta, moda: target.moda, prov: province,
          bln: monthName, thn: year, prevBln: prev.bln, prevThn: prev.thn,
        }).join('\n\n'), col).split(/\n{2,}/);
      const angkutan = target.moda === 'Transportasi Udara' ? 'Angkutan Udara' : 'Angkutan Laut';
      return {
        tableNo,
        label,
        // The Regenerasi form submits these four back to the narrative bridge,
        // which needs a province, year, month and moda to rebuild the prompt.
        // Without them the inputs rendered empty and Python raised
        // "int() argument must be ... not 'NoneType'".
        prov: province,
        tahun: year,
        // The narrative bridge does int(payload["bulan"]), so the form must post
        // the month *number*; the name is kept for display-only fields.
        bulan: monthName,
        bulanNo: MONTH_NAMES.indexOf(monthName) + 1,
        moda: target.moda,
        title: `Tabel ${tableNo} Perkembangan ${label} ${angkutan} Dalam Negeri Provinsi ${province}, ${monthName} ${year}`,
        rowLabel: target.moda === 'Transportasi Udara' ? 'Bandara' : 'Pelabuhan/Kabupaten',
        col: table.col,
        columns: table.columns,
        rows: table.rows,
        narrative: { source: cachedText ? 'Database (Cached)' : 'Sistem Fallback', paras },
      };
    });
    groups.push({ moda: target.moda, icon: target.icon, items });
  }

  return {
    provinces, province, years, months: MONTH_NAMES, year, monthName,
    groups,
    warning: groups.length
      ? null
      : `No data found matching parameters for Province: ${province}, ${monthName} ${year}.`,
  };
}

async function buildTransportasi(session, url) {
  const periods = sortPeriods(await availablePeriods());
  const allowed = tabsFor(ROLE_TABS, session.role);
  const requested = url.searchParams.get('tab');
  const tab = allowed.includes(requested) ? requested : allowed[0];
  if (periods.length === 0) {
    return transportasiPage({ user: session, periods: [], sections: [], tab });
  }
  const selected = pickPeriod(periods, url.searchParams.get('periode'));
  const prev = prevPeriod(selected.thn, selected.bln);
  const sections = tab === 'dashboard'
    ? await Promise.all(MODA.map((moda) => buildSection(moda, selected, prev)))
    : [];
  const report = tab === 'report' ? await loadTransportReport(url, periods, selected, session) : null;
  const admin = tab === 'admin' && session.role === 'admin' ? await buildTransportAdmin(session, url) : null;
  return transportasiPage({ user: session, periods, selected, sections, tab, report, admin });
}

async function loadMap(url, info) {
  const indicator = url.searchParams.get('indikator') === 'rlmtgab' ? 'rlmtgab' : 'tpk';
  const years = uniqueSorted(info.map((r) => r.year));
  const months = uniqueSorted(info.map((r) => r.month));
  const wantYear = Number(url.searchParams.get('tahun'));
  // The map <select> submits the English month name ("June"); accept that, the
  // Indonesian name and the number alike (see monthIndexOf in lib.js).
  const wantMonth = monthIndexOf(url.searchParams.get('bulan'));
  // month_list is global in Streamlit (months 9-12 only exist for 2025), so the
  // default must come from the latest (year, month) pair, not the column maxima.
  const pairs = [...new Set(info.map((r) => `${Number(r.year)}|${Number(r.month)}`))]
    .map((s) => s.split('|').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const latest = pairs.at(-1) || [];
  const year = years.includes(wantYear) ? wantYear : latest[0];
  const month = months.includes(wantMonth) ? wantMonth : latest[1];
  const meta = INDICATOR_META[indicator];
  const data = {
    indicator,
    indicatorLabel: meta.label,
    unit: meta.unit,
    years,
    months,
    year,
    month,
    monthName: monthNameEn(month),
    values: {},
    labels: {},
    cards: [],
    rows: [],
    lo: null,
    hi: null,
    empty: true,
  };
  if (!year || !month) return data;

  const prevMonth = month > 1 ? month - 1 : 12;
  const prevYear = month > 1 ? year : year - 1;
  const rows = await infographicRows(indicator, year, month, prevYear, prevMonth);
  const cur = rows.filter((r) => Number(r.year) === year && Number(r.month) === month);
  const prev = rows.filter((r) => Number(r.year) === prevYear && Number(r.month) === prevMonth);
  if (cur.length === 0) return data;

  const find = (list, prov, jenis) => list.find(
    (r) => String(r.province) === prov && r.jenis_akomodasi === jenis,
  );

  for (const prov of TARGET_PROVINCES) {
    const avg = mean(cur.filter((r) => String(r.province) === prov).map((r) => r.val));
    if (avg != null) {
      data.values[prov] = avg;
      data.labels[prov] = `${formatIdNumber(avg, 2)}${meta.unit}`;
    }
  }

  data.cards = TARGET_PROVINCES.map((prov) => ({
    province: prov,
    rows: Object.entries(JENIS_LABELS).map(([jenis, label]) => {
      const c = find(cur, prov, jenis);
      const p = find(prev, prov, jenis);
      const value = c?.val == null ? null : Number(c.val);
      const before = p?.val == null ? null : Number(p.val);
      return { label, value, delta: pctChange(value, before) };
    }),
  }));

  const nums = Object.values(data.values);
  data.lo = nums.length ? Math.min(...nums) : null;
  data.hi = nums.length ? Math.max(...nums) : null;
  data.rows = cur;
  data.empty = nums.length === 0;
  return data;
}

async function loadReport(url, info, session = { role: 'admin' }) {
  const provinces = info.length ? TARGET_PROVINCES.slice().sort() : [];
  const years = uniqueSorted(info.map((r) => r.year));
  const months = uniqueSorted(info.map((r) => r.month));
  const pairs = [...new Set(info.map((r) => `${Number(r.year)}|${Number(r.month)}`))]
    .map((s) => s.split('|').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const latest = pairs.at(-1) || [];

  const wantProv = url.searchParams.get('provinsi');
  const wantYear = Number(url.searchParams.get('tahun'));
  // The report <select> submits a month *name* ("Juni"), while deep links and
  // exports use the number. Number('Juni') is NaN, which used to fall through to
  // the latest period and silently show the wrong month. Accept both forms.
  const wantMonth = monthIndexOf(url.searchParams.get('bulan'));
  const province = provinces.includes(wantProv) ? wantProv : provinces[0];
  const year = years.includes(wantYear) ? wantYear : latest[0];
  const month = months.includes(wantMonth) ? wantMonth : latest[1];
  const report = { provinces, province, years, months, year, month, indicators: [], warning: null };
  if (!province || !year || !month) return report;

  const prevMonth = month > 1 ? month - 1 : 12;
  const prevYear = month > 1 ? year : year - 1;
  const hasPrev = info.some((r) => String(r.kd_prov) === province
    && Number(r.year) === prevYear && Number(r.month) === prevMonth);
  if (!hasPrev) {
    report.warning = `Data untuk bulan sebelumnya (${periodLabel(prevYear, INV_MONTH_MAP[prevMonth])}) belum tersedia di `
      + `${province}. Perbandingan bulan-ke-bulan tidak dapat dihitung untuk `
      + `${periodLabel(year, INV_MONTH_MAP[month])} — pilih periode yang lebih akhir.`;
  }

  const [rows, domainRows, refRows, narratives] = await Promise.all([
    reportRows(province, year),
    reportDomain(),
    reportRef(province),
    session.role === 'rekon' ? Promise.resolve([]) : reportNarratives(province, year, month),
  ]);

  const domain = {};
  for (const r of domainRows) {
    (domain[r.jenis_akomodasi] ||= []).push(Number(r.kelas_akomodasi));
  }
  const ref = new Map(refRows.map((r) => [`${r.jenis_akomodasi}|${Number(r.year)}|${Number(r.month)}`, r]));
  const narrativeBy = new Map(narratives.map((r) => [`${r.jenis_akomodasi}|${r.indicator}`, r.narrative]));
  const current = rows.filter((r) => Number(r.year) === year && Number(r.month) === month);
  if (!current.length) return report;

  report.indicators = Object.entries(INDICATOR_META).map(([key, meta]) => ({
    key,
    short: meta.short,
    unit: meta.unit,
    jenis: Object.keys(JENIS_LABELS).map((jenis) => ({
      jenis,
      table: reportTable(rows, {
        jenis,
        indicator: key,
        year,
        month,
        prevYear,
        prevMonth,
        lastYear: year - 1,
        domain: domain[jenis] || [],
        ref,
      }),
      series: yoySeries(rows, { jenis, indicator: key, year, month, ref }),
      narrative: narrativeBy.get(`${jenis}|${key}`) || null,
    })),
  }));
  return report;
}

/** Aggregate the headline numbers shown on the landing screen. */
async function buildLanding(session) {
  let pari = { periods: 0, provinces: 0, rows: 0, last: null };
  let trans = { periods: 0, last: null };
  try {
    const rows = await pariwisataInfo();
    const periods = periodsFromInfo(rows);
    pari = {
      periods: periods.length,
      provinces: new Set(rows.map((r) => String(r.kd_prov))).size,
      rows: rows.length,
      last: periods.at(-1) || null,
    };
  } catch (err) {
    console.warn('[landing] pariwisata tidak terbaca:', err.message);
  }
  try {
    const periods = sortPeriods(await availablePeriods());
    trans = { periods: periods.length, last: periods.at(-1) || null };
  } catch (err) {
    console.warn('[landing] transportasi tidak terbaca:', err.message);
  }
  return landingPage({ user: session, pari, trans });
}

async function buildPariwisata(session, url) {  const rows = await pariwisataInfo();
  const periods = periodsFromInfo(rows);
  const latest = periods.at(-1);
  const metrics = latest ? await latestMetrics(latest.thn, latest.bln) : null;
  const provCount = new Set(rows.map((r) => String(r.kd_prov))).size;
  const allowed = tabsFor(ROLE_TABS_PARIWISATA, session.role);
  const requested = url.searchParams.get('tab');
  const tab = allowed.includes(requested) ? requested : allowed[0];
  const map = tab === 'map' && rows.length ? await loadMap(url, rows) : null;
  const report = tab === 'report' && rows.length ? await loadReport(url, rows, session) : null;
  const admin = tab === 'admin' && session.role === 'admin'
    ? await buildPariwisataAdmin(session, url, { uploads: stagingStore, readFlash })
    : null;
  return pariwisataPage({ user: session, info: { rows, provCount, metrics }, periods, tab, map, report, admin });
}



function stageKey() {
  return crypto.randomBytes(12).toString('hex');
}

async function pruneUploads() {
  await pruneStaged();
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
    const files = [];
    const fields = {};
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => files.push({ field: name, name: info.filename, buffer: Buffer.concat(chunks) }));
    });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('close', () => resolve({ files, fields }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

/** application/x-www-form-urlencoded body -> { values, params }. */
async function parseForm(req) {
  const raw = await readBody(req, 1_000_000);
  return { values: Object.fromEntries(new URLSearchParams(raw)) };
}

function brsAssets(files) {
  const find = (field) => files.find((f) => f.field === field && f.buffer.length);
  return { qr: find('qr'), infografis: find('infografis') };
}

function flash(url, text, ok) {
  return `${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(text)}&ok=${ok ? 1 : 0}`;
}

function readFlash(url) {
  const text = url.searchParams.get('msg');
  return text ? { text, ok: url.searchParams.get('ok') === '1' } : null;
}

function adminTable(raw) {
  return Object.values(ADMIN_TABLES).some((m) => m.table === raw) ? raw : 'transportasi_udara';
}

async function buildTransportAdmin(session, url) {
  // All four sections are built in one pass so the admin page needs no sub-tabs.
  const requested = url.searchParams.get('sub');
  const focus = ['upload', 'edit', 'delete', 'series'].includes(requested) ? requested : 'series';
  const message = readFlash(url);
  const admin = { focus };

  // ---- upload -----------------------------------------------------------
  const stage = url.searchParams.get('stage');
  const record = stage ? await getStaged(stage) : null;
  admin.upload = {
    stage: record ? stage : null,
    files: record
      ? record.files.map((f) => ({
        nama_file: f.nama_file,
        table_type: f.meta.tableType,
        tahun: f.meta.tahun || 2026,
        bulan: f.meta.bulan || 'Januari',
      }))
      : [],
    preview: record && url.searchParams.get('preview') === '1' ? record.preview : null,
    message,
  };

  // ---- manual correction ------------------------------------------------
  const table = adminTable(url.searchParams.get('moda'));
  const tahun = url.searchParams.get('tahun') || String(new Date().getFullYear());
  const bulan = MONTH_NAMES.includes(url.searchParams.get('bulan')) ? url.searchParams.get('bulan') : 'Januari';
  admin.edit = {
    table, tahun, bulan, months: MONTH_NAMES,
    tsv: url.searchParams.get('load') === '1'
      ? rowsToTsv(table, await periodRows(table, tahun, bulan))
      : null,
    message,
  };

  // ---- delete by filter -------------------------------------------------
  const modaLabel = ADMIN_TABLES[url.searchParams.get('moda')] ? url.searchParams.get('moda') : 'Transportasi Udara';
  const moda = ADMIN_TABLES[modaLabel].table;
  const province = url.searchParams.get('province') || 'SEMUA';
  const delYear = url.searchParams.get('year') || 'SEMUA';
  const delMonth = url.searchParams.get('month') || 'SEMUA';
  const years = await distinctYears(modaLabel);
  const preview = url.searchParams.get('count') === '1'
    ? await deleteFiltered(moda, { province, year: delYear, month: delMonth })
    : null;
  admin.del = {
    moda: modaLabel, province, tahun: delYear, bulan: delMonth, years,
    provinces: provinceList(), months: MONTH_NAMES,
    count: preview ? preview.count : null, message,
  };

  // ---- series -----------------------------------------------------------
  const kabupaten = url.searchParams.get('kabupaten') || 'SEMUA';
  const entities = url.searchParams.getAll('entity');
  const variabel = url.searchParams.getAll('variabel');
  const meta = ADMIN_TABLES[modaLabel];
  admin.seriesForm = {
    moda: modaLabel,
    kabupaten,
    kabupatenList: kabupatenOptions(),
    entityLabel: meta.entityLabel,
    entities: {
      options: await entityOptions(modaLabel, kabupaten),
      selected: entities,
    },
    variabel: {
      options: meta.vars,
      selected: variabel.length ? variabel : [meta.vars[0]],
    },
    series: await seriesData(modaLabel, {
      kabupaten, entities,
      variabel: variabel.length ? variabel : [meta.vars[0]],
    }),
  };

  return admin;
}

function provinceList() {
  return Object.keys(PEMETAAN_WILAYAH);
}

const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && /^\/(style\.css|app\.css|glass\.css|logo\.png|papua_provinces\.json)$/.test(url.pathname)) {
      return await serveStatic(res, url.pathname);
    }

    if (req.method === 'GET' && url.pathname === '/login') {
      return sendHtml(res, loginPage());
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const form = new URLSearchParams(await readBody(req));
      const username = form.get('username') || '';
      const account = USERS[username];
      if (!account || account.password !== form.get('password')) {
        return sendHtml(res, loginPage({ error: 'Username atau password salah. Silakan coba lagi.' }), 401);
      }
      const token = sign({
        name: account.name,
        role: account.role,
        exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      });
      const landing = account.role === 'rekon' ? '/pariwisata?tab=report' : '/';
      return redirect(res, landing, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
      });
    }

    const session = verify(readCookie(req, COOKIE));
    if (!session) return redirect(res, '/login');

    if (req.method === 'POST' && url.pathname === '/logout') {
      return redirect(res, '/login', {
        'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
    }

    // Keep the export banner honest: re-probe (cached ~15s) before rendering pages.
    if (url.pathname === '/' || url.pathname === '/pariwisata' || url.pathname === '/transportasi') {
      try {
        setExportAvailability(await checkExporter());
      } catch { /* probe failure must never break rendering */ }
    }

    if (url.pathname === '/') {
      return sendHtml(res, await buildLanding(session));
    }
    if (url.pathname === '/pariwisata') return sendHtml(res, await buildPariwisata(session, url));
    if (url.pathname === '/transportasi') return sendHtml(res, await buildTransportasi(session, url));

    if (url.pathname.startsWith('/transportasi/admin/')) {
      if (session.role !== 'admin') return sendHtml(res, errorPage('Akses admin diperlukan.'), 403);
      await pruneUploads();

      if (req.method === 'POST' && url.pathname === '/transportasi/admin/upload') {
        const { files } = await parseMultipart(req);
        if (!files.length) return redirect(res, flash('/transportasi?tab=admin&sub=upload', 'Tidak ada berkas yang diunggah.', false));
        const token = stageKey();
        await putStaged(token, {
          at: Date.now(),
          files: files.map((f) => ({
            nama_file: f.name,
            buffer: f.buffer,
            meta: detectFileMetadata(f.buffer),
          })),
          preview: null,
        });
        return redirect(res, `/transportasi?tab=admin&sub=upload&stage=${token}`);
      }

      if (req.method === 'POST' && url.pathname === '/transportasi/admin/preview') {
        const form = new URLSearchParams(await readBody(req));
        const record = await getStaged(form.get('stage'));
        if (!record) return redirect(res, flash('/transportasi?tab=admin&sub=upload', 'Sesi unggahan kedaluwarsa. Unggah ulang berkas.', false));
        const preview = [];
        for (const [index, file] of record.files.entries()) {
          const tahun = Number(form.get(`tahun_${index}`)) || record.files[index].meta.tahun || 2026;
          const bulan = MONTH_NAMES.includes(form.get(`bulan_${index}`)) ? form.get(`bulan_${index}`) : (file.meta.bulan || 'Januari');
          try {
            const parsed = parseTransportFile(file.buffer, tahun, bulan);
            preview.push({
              nama_file: file.nama_file,
              table_type: parsed.tableType,
              tahun,
              bulan,
              stats: computeUploadStats(parsed.tableType, parsed.rows),
              existing_rows: await countExistingRows(parsed.tableType, tahun, bulan),
              error: null,
              parsed,
            });
          } catch (err) {
            preview.push({ nama_file: file.nama_file, table_type: null, tahun, bulan, stats: null, existing_rows: 0, error: err.message, parsed: null });
          }
        }
        record.preview = preview;
        record.metaInputs = preview.map((p) => ({ tahun: p.tahun, bulan: p.bulan }));
        await putStaged(form.get('stage'), record);
        return redirect(res, `/transportasi?tab=admin&sub=upload&stage=${form.get('stage')}&preview=1`);
      }

      if (req.method === 'POST' && url.pathname === '/transportasi/admin/save') {
        const form = new URLSearchParams(await readBody(req));
        const token = form.get('stage');
        const record = await getStaged(token);
        if (!record || !record.preview) return redirect(res, flash('/transportasi?tab=admin&sub=upload', 'Sesi unggahan kedaluwarsa. Unggah ulang berkas.', false));
        if (form.get('confirm') !== '1') return redirect(res, flash(`/transportasi?tab=admin&sub=upload&stage=${token}&preview=1`, 'Centang konfirmasi sebelum menyimpan.', false));
        const overwrite = form.get('overwrite') === '1';
        let saved = 0;
        const failures = [];
        for (const p of record.preview) {
          if (p.error) continue;
          try {
            await savePeriod(p.table_type, p.tahun, p.bulan, p.parsed.rows, overwrite);
            saved += 1;
          } catch (err) {
            failures.push(`${p.nama_file}: ${err.message}`);
          }
        }
        await deleteStaged(token);
        const text = failures.length
          ? `${saved} berkas tersimpan, ${failures.length} gagal — ${failures.join('; ')}`
          : `${saved} berkas berhasil disimpan ke database.`;
        return redirect(res, flash('/transportasi?tab=admin&sub=upload', text, failures.length === 0));
      }

      if (req.method === 'POST' && url.pathname === '/transportasi/admin/edit') {
        const form = new URLSearchParams(await readBody(req, 4_000_000));
        const table = adminTable(form.get('moda'));
        const tahun = form.get('tahun') || '';
        const bulan = form.get('bulan') || '';
        const back = `/transportasi?tab=admin&sub=edit&moda=${table}&tahun=${encodeURIComponent(tahun)}&bulan=${encodeURIComponent(bulan)}&load=1`;
        if (!MONTH_NAMES.includes(bulan) || !/^\d{4}$/.test(tahun)) {
          return redirect(res, flash(back, 'Tahun/bulan periode tidak valid.', false));
        }
        try {
          const rows = tsvToRows(table, form.get('tsv') || '');
          if (!rows.length) throw new Error('Tidak ada baris untuk disimpan.');
          await replacePeriod(table, tahun, bulan, rows);
          return redirect(res, flash(back, `${rows.length} baris ${table} ${bulan} ${tahun} berhasil disimpan.`, true));
        } catch (err) {
          return redirect(res, flash(back, `Gagal menyimpan data: ${err.message}`, false));
        }
      }

      if (req.method === 'POST' && url.pathname === '/transportasi/admin/delete') {
        const form = new URLSearchParams(await readBody(req));
        const modaLabel = ADMIN_TABLES[form.get('moda')] ? form.get('moda') : null;
        const back = `/transportasi?tab=admin&sub=delete&moda=${encodeURIComponent(modaLabel || '')}&province=${encodeURIComponent(form.get('province') || 'SEMUA')}&year=${encodeURIComponent(form.get('year') || 'SEMUA')}&month=${encodeURIComponent(form.get('month') || 'SEMUA')}&count=1`;
        if (!modaLabel) return redirect(res, flash(back, 'Moda transportasi tidak dikenal.', false));
        if (form.get('confirm') !== '1') return redirect(res, flash(back, 'Centang konfirmasi sebelum menghapus.', false));
        try {
          const filters = { province: form.get('province') || 'SEMUA', year: form.get('year') || 'SEMUA', month: form.get('month') || 'SEMUA' };
          const { clause, params, count } = await deleteFiltered(ADMIN_TABLES[modaLabel].table, filters);
          if (!count) return redirect(res, flash(back, 'Tidak ada baris yang cocok dengan filter.', false));
          const removed = await deleteRows(ADMIN_TABLES[modaLabel].table, clause, params);
          return redirect(res, flash('/transportasi?tab=admin&sub=delete', `${removed} baris dihapus dari ${ADMIN_TABLES[modaLabel].table}.`, true));
        } catch (err) {
          return redirect(res, flash(back, `Gagal menghapus data: ${err.message}`, false));
        }
      }
    }

    if (url.pathname.startsWith('/pariwisata/admin/')) {
      if (session.role !== 'admin') return sendHtml(res, errorPage('Akses admin diperlukan.'), 403);
      await pruneUploads();

      if (req.method === 'POST' && url.pathname === '/pariwisata/admin/upload') {
        const { files } = await parseMultipart(req);
        if (!files.length) return redirect(res, flash('/pariwisata?tab=admin&sub=upload', 'Tidak ada berkas yang diunggah.', false));
        const token = stageKey();
        await putStaged(token, {
          at: Date.now(),
          files: files.map((f) => {
            let tahun = null; let bulan = null;
            try {
              const probe = readPariwisataSheet(f.buffer, PARIWISATA_SHEET);
              if (probe && probe.length) {
                const y = Number(probe.find((r) => r.year != null)?.year);
                const m = Number(probe.find((r) => r.month != null)?.month);
                if (Number.isFinite(y)) tahun = y;
                if (Number.isFinite(m)) bulan = MONTH_NAMES[m - 1] || null;
              }
            } catch { /* metadata is optional; the form can supply it */ }
            return { nama_file: f.name, buffer: f.buffer, tahun, bulan };
          }),
          preview: null,
        });
        return redirect(res, `/pariwisata?tab=admin&sub=upload&stage=${token}`);
      }

      if (req.method === 'POST' && url.pathname === '/pariwisata/admin/preview') {
        const form = new URLSearchParams(await readBody(req));
        const token = form.get('stage');
        const record = await getStaged(token);
        if (!record) return redirect(res, flash('/pariwisata?tab=admin&sub=upload', 'Sesi unggahan kedaluwarsa. Unggah ulang berkas.', false));
        const preview = [];
        for (const [i, file] of record.files.entries()) {
          const tahun = Number(form.get(`tahun_${i}`)) || file.tahun || new Date().getFullYear();
          const bulanName = MONTH_NAMES.includes(form.get(`bulan_${i}`)) ? form.get(`bulan_${i}`) : (file.bulan || 'Januari');
          const bulan = MONTH_NAMES.indexOf(bulanName) + 1;
          try {
            const parsed = parsePariwisataFile(file.buffer, { year: tahun, month: bulan });
            preview.push({
              nama_file: file.nama_file, error: null,
              stats: parsed.stats,
              existing_rows: await countExistingPeriods(parsed.periods),
              parsed,
            });
          } catch (err) {
            preview.push({ nama_file: file.nama_file, error: err.message, stats: null, existing_rows: 0, parsed: null });
          }
        }
        record.preview = preview;
        await putStaged(token, record);
        return redirect(res, `/pariwisata?tab=admin&sub=upload&stage=${token}&preview=1`);
      }

      if (req.method === 'POST' && url.pathname === '/pariwisata/admin/save') {
        const form = new URLSearchParams(await readBody(req));
        const token = form.get('stage');
        const record = await getStaged(token);
        if (!record || !record.preview) return redirect(res, flash('/pariwisata?tab=admin&sub=upload', 'Sesi unggahan kedaluwarsa. Unggah ulang berkas.', false));
        if (form.get('confirm') !== '1') return redirect(res, flash(`/pariwisata?tab=admin&sub=upload&stage=${token}&preview=1`, 'Centang konfirmasi sebelum menyimpan.', false));
        let saved = 0; let rowCount = 0; const failures = [];
        for (const p of record.preview) {
          if (p.error) continue;
          try {
            const r = await savePariwisata(p.parsed.rows, p.parsed.refRows);
            saved += 1; rowCount += r.inserted;
          } catch (err) {
            failures.push(`${p.nama_file}: ${err.message}`);
          }
        }
        await deleteStaged(token);
        const text = failures.length
          ? `${saved} berkas tersimpan (${rowCount} baris), ${failures.length} gagal - ${failures.join('; ')}`
          : `${saved} berkas berhasil disimpan (${rowCount} baris) ke database.`;
        return redirect(res, flash('/pariwisata?tab=admin&sub=upload', text, failures.length === 0));
      }

      if (req.method === 'POST' && url.pathname === '/pariwisata/admin/edit') {
        const form = new URLSearchParams(await readBody(req));
        const back = `/pariwisata?tab=admin&sub=edit&tahun=${encodeURIComponent(form.get('tahun') || '')}&bulan=${encodeURIComponent(form.get('bulan') || '')}&load=1`;
        try {
          const rows = pariwisataTsvToRows(form.get('tsv') || '');
          if (!rows.length) return redirect(res, flash(back, 'Tidak ada baris untuk disimpan.', false));
          const n = await replacePariwisataPeriods(rows);
          return redirect(res, flash('/pariwisata?tab=admin&sub=edit', `${n} baris disimpan.`, true));
        } catch (err) {
          return redirect(res, flash(back, `Gagal menyimpan: ${err.message}`, false));
        }
      }

      if (req.method === 'POST' && url.pathname === '/pariwisata/admin/delete') {
        const form = new URLSearchParams(await readBody(req));
        const back = `/pariwisata?tab=admin&sub=delete&province=${encodeURIComponent(form.get('province') || 'SEMUA')}&year=${encodeURIComponent(form.get('year') || 'SEMUA')}&month=${encodeURIComponent(form.get('month') || 'SEMUA')}&count=1`;
        if (form.get('confirm') !== '1') return redirect(res, flash(back, 'Centang konfirmasi sebelum menghapus.', false));
        try {
          const n = await deletePariwisataFiltered({
            provinsi: form.get('province') || 'SEMUA',
            tahun: form.get('year') || 'SEMUA',
            bulan: form.get('month') === 'SEMUA' ? 'SEMUA' : (MONTH_NAMES.indexOf(form.get('month')) + 1),
          });
          return redirect(res, flash('/pariwisata?tab=admin&sub=delete', n ? `${n} baris dihapus dari all_data.` : 'Tidak ada baris yang cocok dengan filter.', n > 0));
        } catch (err) {
          return redirect(res, flash(back, `Gagal menghapus: ${err.message}`, false));
        }
      }
    }

    if (url.pathname === '/api/narrative/generate' && req.method === 'POST') {
      if (!session) return json(res, { error: 'Silakan login terlebih dahulu.' }, 401);
      if (session.role !== 'admin') return json(res, { error: 'Hanya admin' }, 403);
      const form = await parseForm(req);
      const values = form.values || {};
      if (!values.kind) return json(res, { error: 'kind required' }, 400);
      try {
        const payload = await runNarrativeBridge({ ...values, action: 'generate' });
        return json(res, payload, payload.error ? 500 : 200);
      } catch (err) {
        return json(res, { error: `Narasi tidak dapat dibuat: ${err.message}` }, 500);
      }
    }

    if (url.pathname === '/api/narrative/regenerate' && req.method === 'POST') {
      if (!session) return json(res, { error: 'Silakan login terlebih dahulu.' }, 401);
      if (session.role !== 'admin') return json(res, { error: 'Hanya admin' }, 403);
      const form = await parseForm(req);
      const values = form.values || {};
      if (!values.kind) return json(res, { error: 'kind required' }, 400);
      try {
        const payload = await runNarrativeBridge({ ...values, action: 'regenerate' });
        return json(res, payload, payload.error ? 500 : 200);
      } catch (err) {
        return json(res, { error: `Narasi tidak dapat dibuat: ${err.message}` }, 500);
      }
    }

    const summaryParams = () => ({
      module: String(url.searchParams.get('module') || ''),
      year: Number(url.searchParams.get('year')),
      month: Number(url.searchParams.get('month')),
    });

    if (url.pathname === '/api/summary/periods' && req.method === 'GET') {
      const module = String(url.searchParams.get('module') || '');
      if (!['pariwisata', 'transportasi'].includes(module)) {
        return json(res, { error: 'Modul tidak dikenal.' }, 400);
      }
      try {
        return json(res, { periods: await notePeriods(module) });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }
    if (url.pathname === '/api/summary' && req.method === 'GET') {
      const p = summaryParams();
      if (!['pariwisata', 'transportasi'].includes(p.module) || !Number.isInteger(p.year) || !Number.isInteger(p.month)) {
        return json(res, { error: 'Parameter tidak lengkap.' }, 400);
      }
      try {
        const { notes, coverage } = await collectNotes(p.module, p.year, p.month);
        const hash = hashNotes(notes);
        const cached = await getCached(p.module, p.year, p.month, hash);
        return json(res, {
          module: p.module, year: p.year, month: p.month,
          periodLabel: `${monthName(p.month)} ${p.year}`,
          notes, coverage,
          summary: cached ? cached.summary : null,
          model: cached ? cached.model : null,
          generatedAt: cached ? cached.created_at : null,
        });
      } catch (err) {
        console.warn(`[summary] ${err.message}`);
        return json(res, { error: err.message }, 500);
      }
    }

    if (url.pathname === '/api/summary' && req.method === 'POST') {
      if (session.role !== 'admin') return json(res, { error: 'Hanya admin' }, 403);
      const p = summaryParams();
      if (!['pariwisata', 'transportasi'].includes(p.module) || !Number.isInteger(p.year) || !Number.isInteger(p.month)) {
        return json(res, { error: 'Parameter tidak lengkap.' }, 400);
      }
      try {
        const { notes, coverage } = await collectNotes(p.module, p.year, p.month);
        if (!notes.length) return json(res, { error: 'Belum ada justifikasi pada periode ini.' }, 400);
        const hash = hashNotes(notes);
        const body = await generateSummary({
          module: p.module, year: p.year, month: p.month,
          coverage, notes,
        });
        const saved = await saveSummary({
          module: p.module, year: p.year, month: p.month, inputHash: hash,
          model: body.source, summary: body.summary,
          noteCount: coverage.notes, cellCount: coverage.cells,
        });
        return json(res, { ok: true, summary: saved.summary, model: saved.model, coverage, generatedAt: saved.created_at });
      } catch (err) {
        console.warn(`[summary] gagal: ${err.message}`);
        return json(res, { error: err.message }, 502);
      }
    }

    if (url.pathname === '/export/summary.pdf' && req.method === 'GET') {
      if (denyExport(session)) return sendHtml(res, errorPage('Akses ekspor ditolak untuk peran ini.'), 403);
      if (session.role !== 'admin') return sendHtml(res, errorPage('Akses admin diperlukan.'), 403);
      const p = summaryParams();
      if (!['pariwisata', 'transportasi'].includes(p.module) || !Number.isInteger(p.year) || !Number.isInteger(p.month)) {
        return sendHtml(res, errorPage('Parameter tidak lengkap.'), 400);
      }
      try {
        const { notes, coverage } = await collectNotes(p.module, p.year, p.month);
        if (!notes.length) return sendHtml(res, errorPage('Belum ada justifikasi pada periode ini.'), 404);
        const hash = hashNotes(notes);
        const cached = await getCached(p.module, p.year, p.month, hash);
        if (!cached) {
          return sendHtml(res, errorPage('Ringkasan belum dibuat. Klik "Buat Ringkasan" terlebih dahulu.'), 409);
        }
        const pdf = await renderSummaryPdf({
          module: p.module, year: p.year, month: p.month,
          summary: cached.summary, source: cached.model || 'AI',
          notes, coverage,
        });
        return sendFile(res, pdf, 'application/pdf',
          `Ringkasan_Justifikasi_${p.module}_${monthName(p.month)}_${p.year}.pdf`);
      } catch (err) {
        console.warn(`[summary] pdf gagal: ${err.message}`);
        return sendHtml(res, errorPage(err.message), 500);
      }
    }
    if (url.pathname === '/api/growth' && req.method === 'GET') {
      const cell = normaliseCell(Object.fromEntries(url.searchParams));
      if (!cell) return json(res, { error: 'Parameter sel tidak lengkap.' }, 400);
      if (!isKnownIndicator(cell.dataset, cell.indicator)) {
        return json(res, { error: 'Indikator tidak dikenal.' }, 400);
      }
      try {
        const [series, note] = await Promise.all([buildSeries(cell), getNote(cell)]);
        return json(res, { cell: { ...cell, key: cellKey(cell) }, series, note });
      } catch (err) {
        console.warn(`[growth] ${err.message}`);
        return json(res, { error: err.message }, 500);
      }
    }

    if (url.pathname === '/api/growth/note/delete' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req, 100_000));
      } catch {
        return json(res, { error: 'Body tidak valid.' }, 400);
      }
      const cell = normaliseCell(body.cell || {});
      if (!cell) return json(res, { error: 'Sel tidak lengkap.' }, 400);
      try {
        const removed = await deleteNote(cell);
        return json(res, { ok: true, removed });
      } catch (err) {
        console.warn(`[growth] hapus gagal: ${err.message}`);
        return json(res, { error: 'Gagal menghapus justifikasi.' }, 500);
      }
    }
    if (url.pathname === '/api/growth/notes' && req.method === 'GET') {
      const dataset = String(url.searchParams.get('dataset') || '');
      const year = Number(url.searchParams.get('year'));
      const month = Number(url.searchParams.get('month'));
      if (!dataset || !Number.isInteger(year) || !Number.isInteger(month)) {
        return json(res, { error: 'Parameter tidak lengkap.' }, 400);
      }
      try {
        const keys = await noteKeysFor(dataset, year, month);
        return json(res, { keys: [...keys] });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }
    if (url.pathname === '/api/growth/note' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req, 100_000));
      } catch {
        return json(res, { error: 'Body tidak valid.' }, 400);
      }
      const cell = normaliseCell(body.cell || {});
      if (!cell) return json(res, { error: 'Sel tidak lengkap.' }, 400);
      const reason = String(body.reason || '').trim();
      if (reason.length < 5) return json(res, { error: 'Justifikasi minimal 5 karakter.' }, 400);
      if (reason.length > 2000) return json(res, { error: 'Justifikasi maksimal 2000 karakter.' }, 400);
      try {
        // Author always comes from the signed session, never the request body.
        const note = await saveNote(cell, reason, session.name);
        return json(res, { ok: true, note });
      } catch (err) {
        console.warn(`[growth] simpan gagal: ${err.message}`);
        return json(res, { error: 'Gagal menyimpan justifikasi.' }, 500);
      }
    }
    if (url.pathname === '/api/export-status') {
      if (session.role !== 'admin') return json(res, { error: 'Hanya admin' }, 403);
      return json(res, await checkExporter());
    }

    if (url.pathname === '/export/transportasi/pptx') {
      if (denyExport(session)) return sendHtml(res, errorPage('Akses ekspor ditolak untuk peran ini.'), 403);
      const periods = sortPeriods(await availablePeriods());
      const selected = pickPeriod(periods, url.searchParams.get('periode'));
      const prev = prevPeriod(selected.thn, selected.bln);
      const sections = (await Promise.all(MODA.map((moda) => buildSection(moda, selected, prev))))
        .filter((s) => !s.empty);
      if (!sections.length) return sendHtml(res, errorPage('Belum ada data untuk periode ini.'), 404);
      const payload = {
        sections: sections.map((s) => ({
          moda: s.moda,
          bln: selected.bln,
          thn: selected.thn,
          charts: s.charts,
          tables: [growthTable(s.growthP, s.labelsP), growthTable(s.growthB, s.labelsB)],
          narration: s.narrative.paras,
        })),
      };
      const data = await runExport('pptx', payload);
      return sendFile(res, data, EXPORT_MIME.pptx, exportFileName('pptx', { bln: selected.bln, thn: selected.thn }));
    }

    if (req.url.startsWith('/export/transportasi/') && denyExport(session)) {
      return sendHtml(res, errorPage('Akses ekspor ditolak untuk peran ini.'), 403);
    }
    const reportExport = url.pathname.startsWith('/export/transportasi/')
      ? url.pathname.slice('/export/transportasi/'.length)
      : null;
    if (reportExport === 'docx' || reportExport === 'idml' || reportExport === 'xlsx') {
      const form = req.method === 'POST' ? await parseMultipart(req) : { files: [], fields: {} };
      const values = { ...Object.fromEntries(url.searchParams), ...form.fields };
      const prov = values.provinsi || 'Papua';
      const tahun = Number(values.tahun);
      const bulan = values.bulan || '';
      if (!MONTH_NAMES.includes(bulan) || !Number.isInteger(tahun)) {
        return sendHtml(res, errorPage('Provinsi, tahun, atau bulan tidak valid.'), 400);
      }
      if (reportExport === 'xlsx') {
        const payload = { prov, thn: tahun, bln: bulan };
        const data = await runExport('xlsx-transport', payload);
        return sendFile(res, data, EXPORT_MIME.xlsx, exportFileName('xlsx-transport', payload));
      }
      const kind = reportExport === 'docx' ? 'docx' : 'idml-transport';
      const payload = {
        prov,
        thn: tahun,
        bln: bulan,
        nomor: values.nomor || '',
        tanggal: values.tanggal || '',
      };
      if (kind === 'idml-transport') {
        const assets = brsAssets(form.files);
        if (assets.qr) payload.qr_b64 = assets.qr.buffer.toString('base64');
        if (assets.qr) payload.qr_name = assets.qr.name;
        if (assets.infografis) payload.infografis_b64 = assets.infografis.buffer.toString('base64');
        if (assets.infografis) payload.infografis_name = assets.infografis.name;
      }
      const data = await runExport(kind, payload);
      return sendFile(res, data, EXPORT_MIME[kind], exportFileName(kind, payload));
    }

    if (url.pathname === '/export/pariwisata/xlsx') {
      if (denyExport(session)) return sendHtml(res, errorPage('Akses ekspor ditolak untuk peran ini.'), 403);
      const values = Object.fromEntries(url.searchParams);
      const prov = values.provinsi || 'Papua Selatan';
      const tahun = Number(values.tahun);
      const bulan = values.bulan || '';
      if (!MONTH_NAMES.includes(bulan) || !Number.isInteger(tahun)) {
        return sendHtml(res, errorPage('Provinsi, tahun, atau bulan tidak valid.'), 400);
      }
      const payload = { prov, thn: tahun, bln: bulan };
      const data = await runExport('xlsx-pariwisata', payload);
      return sendFile(res, data, EXPORT_MIME.xlsx, exportFileName('xlsx-pariwisata', payload));
    }

    if (url.pathname === '/export/pariwisata/idml') {
      if (denyExport(session)) return sendHtml(res, errorPage('Akses ekspor ditolak untuk peran ini.'), 403);
      const form = req.method === 'POST' ? await parseMultipart(req) : { files: [], fields: {} };
      const values = { ...Object.fromEntries(url.searchParams), ...form.fields };
      const prov = values.provinsi || 'Papua Selatan';
      const tahun = Number(values.tahun);
      const bulan = values.bulan || '';
      if (!MONTH_NAMES.includes(bulan) || !Number.isInteger(tahun)) {
        return sendHtml(res, errorPage('Provinsi, tahun, atau bulan tidak valid.'), 400);
      }
      const assets = brsAssets(form.files);
      const payload = {
        prov,
        thn: tahun,
        bln: bulan,
        nomor: values.nomor || '',
        tanggal: values.tanggal || '',
      };
      if (assets.qr) payload.qr_b64 = assets.qr.buffer.toString('base64');
      if (assets.qr) payload.qr_name = assets.qr.name;
      if (assets.infografis) payload.infografis_b64 = assets.infografis.buffer.toString('base64');
      if (assets.infografis) payload.infografis_name = assets.infografis.name;
      const data = await runExport('idml-pariwisata', payload);
      return sendFile(res, data, EXPORT_MIME['idml-pariwisata'], exportFileName('idml-pariwisata', payload));
    }

    if (url.pathname === '/export/pariwisata-map.csv') {
      if (denyExport(session)) return sendHtml(res, errorPage('Akses ekspor ditolak untuk peran ini.'), 403);
      const info = await pariwisataInfo();
      const map = await loadMap(url, info);
      const lines = ['province,jenis_akomodasi,month,year,val', ...map.rows.map(
        (r) => [r.province, r.jenis_akomodasi, r.month, r.year, r.val].join(','),
      )];
      return sendFile(
        res,
        `${lines.join('\n')}\n`,
        'text/csv; charset=utf-8',
        `infographic_${map.indicator}_${map.year}_${map.month}.csv`,
      );
    }

    return sendHtml(res, errorPage('Halaman tidak ditemukan.'), 404);
  } catch (err) {
    console.error(`[server] ${req.method} ${url.pathname}: ${err.message}`);
    return sendHtml(res, errorPage(err.message), 500);
  }
};

const server = http.createServer(requestHandler);

// On Vercel this module is imported as a serverless function: never bind a port.
const ON_VERCEL = Boolean(process.env.VERCEL);

if (!ON_VERCEL) {
  server.listen(PORT, () => {
    console.log(`Dashboard Node berjalan di http://localhost:${PORT}`);
  });

  // Surface a broken export path at startup instead of on first click.
  checkExporter().then((status) => {
    setExportAvailability(status.ok);
    if (status.ok) console.log(`[export] Python bridge siap (${status.python}).`);
    else console.warn(`[export] Ekspor dokumen NONAKTIF: ${status.message}`);
  });

  process.on('SIGINT', async () => {
    await pool.end();
    server.close(() => process.exit(0));
  });
} else {
  // Document export needs a Python bridge, which does not exist on Vercel.
  setExportAvailability(false);
  console.log('[export] Dijalankan di Vercel - ekspor dokumen dinonaktifkan.');
}

export default requestHandler;
export { requestHandler, server };

