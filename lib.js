export const MONTH_NAMES = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
export const MONTH_MAP = Object.fromEntries(MONTH_NAMES.map((n, i) => [n, i + 1]));
export const INV_MONTH_MAP = Object.fromEntries(MONTH_NAMES.map((n, i) => [i + 1, n]));
export const MONTH_ABBR = {
  Januari: 'Jan', Februari: 'Feb', Maret: 'Mar', April: 'Apr', Mei: 'Mei', Juni: 'Jun',
  Juli: 'Jul', Agustus: 'Ags', September: 'Sep', Oktober: 'Okt', November: 'Nov', Desember: 'Des',
};
export const MONTH_NAMES_EN = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const PROVINSI_ORDER = ['Papua', 'Papua Selatan', 'Papua Tengah', 'Papua Pegunungan'];

export function titleCase(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function prevPeriod(thn, bln) {
  const n = MONTH_MAP[bln] || 1;
  return n > 1 ? { thn, bln: INV_MONTH_MAP[n - 1] } : { thn: thn - 1, bln: 'Desember' };
}

export function pctChange(curr, prev) {
  if (curr == null || prev == null) return null;
  const c = Number(curr);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

const NF = new Map();
export function formatIdNumber(value, decimals = 2) {
  const v = Number(value);
  if (value == null || !Number.isFinite(v)) return 'Undefined';
  if (!NF.has(decimals)) {
    NF.set(decimals, new Intl.NumberFormat('id-ID', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }));
  }
  return NF.get(decimals).format(v);
}

export function arahDinamis(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'tercatat';
  if (pct >= 10) return 'mengalami lonjakan';
  if (pct > 0) return 'meningkat';
  if (pct <= -10) return 'mengalami penurunan tajam';
  if (pct < 0) return 'menurun';
  return 'stabil';
}

export function sortPeriods(rows) {
  const seen = new Map();
  for (const r of rows) {
    const thn = Number(r.tahun);
    const bln = r.bulan;
    if (!thn || !MONTH_MAP[bln]) continue;
    seen.set(`${thn}|${bln}`, { thn, bln });
  }
  return [...seen.values()].sort((a, b) => a.thn - b.thn || MONTH_MAP[a.bln] - MONTH_MAP[b.bln]);
}

export function periodsFromInfo(rows) {
  const seen = new Map();
  for (const r of rows) {
    const thn = Number(r.year);
    const m = Number(r.month);
    if (!thn || !INV_MONTH_MAP[m]) continue;
    seen.set(`${thn}|${m}`, { thn, bln: INV_MONTH_MAP[m] });
  }
  return [...seen.values()].sort((a, b) => a.thn - b.thn || MONTH_MAP[a.bln] - MONTH_MAP[b.bln]);
}

export function periodLabel(thn, bln) {
  return `${bln} ${thn}`;
}

export function emptyAgg(cols) {
  return Object.fromEntries(PROVINSI_ORDER.map((p) => [p, Object.fromEntries(cols.map((c) => [c, 0]))]));
}

export function aggByProvinsi(rows, cols, nameCol = 'nama_provinsi') {
  const agg = emptyAgg(cols);
  for (const row of rows) {
    const prov = titleCase(row[nameCol]);
    if (!agg[prov]) continue;
    for (const col of cols) {
      const v = Number(row[col]);
      if (Number.isFinite(v)) agg[prov][col] += v;
    }
  }
  return agg;
}

export function totalCols(agg, cols) {
  return PROVINSI_ORDER.reduce(
    (sum, p) => sum + cols.reduce((s, c) => s + agg[p][c], 0), 0);
}

export function computeStats(aggCurr, aggPrev, aggCumCurr, aggCumPrev, cols) {
  const curr = totalCols(aggCurr, cols);
  const prev = totalCols(aggPrev, cols);
  const cumCurr = totalCols(aggCumCurr, cols);
  const cumPrev = totalCols(aggCumPrev, cols);
  return { curr, prev, mtm: pctChange(curr, prev), cumCurr, cumPrev, yoy: pctChange(cumCurr, cumPrev) };
}

export function growthRows(aggCurr, aggPrev, cols, labels) {
  return PROVINSI_ORDER.map((prov) => ({
    provinsi: prov,
    values: cols.map((col) => pctChange(aggCurr[prov][col], aggPrev[prov][col])),
    labels,
  }));
}

export function monthNameEn(month) {
  return MONTH_NAMES_EN[Number(month) - 1] || '';
}

// Normalise a month coming from a query string to 1-12. Accepts the number form
// used by exports and deep links ("6"), the Indonesian name the report <select>
// submits ("Juni"), and the English name the map <select> submits ("June").
// Returns null when the value is none of these, so callers fall back explicitly
// instead of silently treating a name as NaN and jumping to another period.
export function monthIndexOf(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 12) return asNumber;
  const id = MONTH_NAMES.findIndex((n) => n.toLowerCase() === raw.toLowerCase());
  if (id !== -1) return id + 1;
  const en = MONTH_NAMES_EN.findIndex((n) => n.toLowerCase() === raw.toLowerCase());
  if (en !== -1) return en + 1;
  return null;
}

export function mean(values) {
  const xs = values.filter((v) => v != null && v !== '').map(Number).filter(Number.isFinite);
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

export function uniqueSorted(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

export function kelasLabel(jenis, kelas) {
  const k = Number(kelas);
  if (!Number.isFinite(k)) return 'Undefined Class';
  if (jenis === 'Hotel Bintang') return `Bintang ${k}`;
  if (jenis === 'Hotel Non Bintang') return `Kelas ${k}`;
  return String(k);
}

const round2 = (v) => Math.round(v * 100) / 100;
const fmt2 = (v) => (v == null ? '-' : v.toFixed(2));
const fmtDelta = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)} pts`);

// A current-month figure is marked (*) for EITHER of two independent reasons:
//
//   1. its relative standard error exceeds 25 percent, or
//   2. the workbook's release-status column says it may not be released
//      ("Tidak dapat rilis").
//
// The two signals do not overlap in practice -- every row flagged in the VHTS
// workbook has RSE 0 -- so this is a disjunction, not a refinement. A single
// helper keeps the web table, the Excel export, the IDML and the narrative
// prompt from drifting apart.
export const NOT_RELEASABLE = 'Tidak dapat rilis';
export const RSE_LIMIT = 0.25;

/** Text of `<indicator>_ket`, lowercased and trimmed, or null. */
export function ketValue(row, indicator) {
  if (!row) return null;
  const raw = row[`${indicator}_ket`];
  if (raw == null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

/** True when `row` must carry the (*) marker for this indicator. */
export function isFlagged(row, indicator, value) {
  if (value == null || value === '') return false;
  const rse = row ? Number(row[`${indicator}_rse`]) : NaN;
  if (Number.isFinite(rse) && rse > RSE_LIMIT) return true;
  const ket = ketValue(row, indicator);
  // Exact match keeps "Take all, dapat rilis" and "Dapat rilis dengan catatan"
  // from being swept up as not-releasable.
  return ket != null && ket.toLowerCase() === NOT_RELEASABLE.toLowerCase();
}

// Port of pariwisata/ai.py generate_akomodasi_tables' table block: one row per
// kelas (none dropped), a Total row that is the mean unless the uploaded
// Prov_Jenis sheet has an official estimate, and RSE stars on this month only.
export function reportTable(rows, opts) {
  const { jenis, indicator, year, month, prevYear, prevMonth, lastYear, domain = [], ref = new Map() } = opts;
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const pick = (y, m) => new Map(rows
    .filter((r) => r.jenis_akomodasi === jenis && Number(r.year) === y && Number(r.month) === m)
    .map((r) => [Number(r.kelas_akomodasi), r]));
  const cur = pick(year, month);
  const prev = pick(prevYear, prevMonth);
  const last = pick(lastYear, month);

  const classes = [...new Set([
    ...domain,
    ...cur.keys(),
    ...prev.keys(),
    ...last.keys(),
  ].filter((k) => Number.isFinite(k)))].sort((a, b) => a - b);

  const value = (map, k) => (map.has(k) ? num(map.get(k)[indicator]) : null);
  const body = classes.map((k) => {
    const cv = value(cur, k);
    const pv = value(prev, k);
    const lv = value(last, k);
    const curRow = cur.has(k) ? cur.get(k) : null;
    const starred = isFlagged(curRow, indicator, cv);
    return {
      kelas: k,
      label: kelasLabel(jenis, k),
      last: lv,
      prev: pv,
      current: cv,
      changePrev: cv != null && pv != null ? round2(cv - pv) : null,
      changeLast: cv != null && lv != null ? round2(cv - lv) : null,
      starred,
      // Why the row is starred, so the footnote can be specific instead of
      // always claiming an RSE problem.
      starReason: !starred
        ? null
        : (ketValue(curRow, indicator)?.toLowerCase() === NOT_RELEASABLE.toLowerCase() ? 'ket' : 'rse'),
    };
  });

  const refCell = (y, m) => {
    const found = ref.get(`${jenis}|${y}|${m}`);
    const v = found ? num(found[indicator]) : null;
    return v == null ? null : round2(v);
  };
  const meanOf = (key) => {
    const xs = body.map((r) => (r[key] == null ? null : round2(r[key]))).filter((v) => v != null);
    return xs.length ? round2(xs.reduce((s, v) => s + v, 0) / xs.length) : null;
  };
  const total = {
    last: refCell(lastYear, month) ?? meanOf('last'),
    prev: refCell(prevYear, prevMonth) ?? meanOf('prev'),
    current: refCell(year, month) ?? meanOf('current'),
  };
  total.changePrev = total.current != null && total.prev != null ? round2(total.current - total.prev) : null;
  total.changeLast = total.current != null && total.last != null ? round2(total.current - total.last) : null;

  return {
    hasData: body.length > 0,
    // Number of kelas carrying the (*) marker. The report view uses it so the RSE
    // footnote only appears on the cards where a star is actually shown.
    starCount: body.filter((r) => r.starred).length,
    columns: {
      last: `${INV_MONTH_MAP[month]} ${lastYear}`,
      prev: `${INV_MONTH_MAP[prevMonth]} ${prevYear}`,
      cur: `${INV_MONTH_MAP[month]} ${year}`,
      dPrev: `Δ vs ${INV_MONTH_MAP[prevMonth]} ${prevYear}`,
      dLast: `Δ vs ${INV_MONTH_MAP[month]} ${lastYear}`,
    },
    body: body.map((r) => ({
      label: r.label,
      last: fmt2(r.last),
      prev: fmt2(r.prev),
      current: r.starred ? `${fmt2(r.current)}*` : fmt2(r.current),
      // Kept separately from `current` so the view can render the marker itself
      // while `current` stays plain text for the workbook and the tests.
      starred: r.starred,
      // 'ket' when the figure may not be released, 'rse' when it is only
      // statistically weak; null when the row is not starred.
      starReason: r.starReason,
      kelas: r.kelas,
      dPrev: fmtDelta(r.changePrev),
      changePrev: r.changePrev,
      dLast: fmtDelta(r.changeLast),
      changeLast: r.changeLast,
    })),
    total: {
      last: fmt2(total.last),
      prev: fmt2(total.prev),
      current: fmt2(total.current),
      dPrev: fmtDelta(total.changePrev),
      changePrev: total.changePrev,
      changeLast: total.changeLast,
      dLast: fmtDelta(total.changeLast),
    },
  };
}

// Month-by-month series for one indicator + jenis: the previous year keeps every
// month on record, the current year stops at the selected month (pariwisata/pages.py
// render_yoy_chart). Prov_Jenis values win over the class mean, same as the table.
export function yoySeries(rows, opts) {
  const { jenis, indicator, year, month, ref = new Map() } = opts;
  const prevYear = year - 1;
  const value = (y, m) => {
    const found = ref.get(`${jenis}|${y}|${m}`);
    const refVal = found ? Number(found[indicator]) : NaN;
    if (Number.isFinite(refVal)) return refVal;
    return mean(rows
      .filter((r) => r.jenis_akomodasi === jenis && Number(r.year) === y && Number(r.month) === m)
      .map((r) => r[indicator]));
  };
  return {
    prevYear,
    year,
    labels: MONTH_NAMES.map((n) => n.slice(0, 3)),
    prev: MONTH_NAMES.map((_, i) => value(prevYear, i + 1)),
    cur: MONTH_NAMES.map((_, i) => (i + 1 <= month ? value(year, i + 1) : null)),
  };
}

export function fallbackNarrative(moda, bln, thn, prevBln, prevThn, penumpang, barang, satuan) {
  const f0 = (v) => formatIdNumber(v, 0);
  const f2 = (v) => formatIdNumber(v, 2);
  const fp = (v) => formatIdNumber(v ?? 0, 2);
  const p1 = `Total pergerakan penumpang angkutan ${moda.toLowerCase()} dalam negeri pada bulan ${bln} ${thn} `
    + `mencapai ${f0(penumpang.curr)} orang, ${arahDinamis(penumpang.mtm)} sebesar `
    + `${fp(penumpang.mtm)} persen dibandingkan ${prevBln} ${prevThn} (${f0(penumpang.prev)} orang). `
    + `Volume barang turut ${arahDinamis(barang.mtm)} sebesar ${fp(barang.mtm)} persen, `
    + `dari ${f2(barang.prev)} ${satuan} menjadi ${f2(barang.curr)} ${satuan}.`;
  const p2 = `Secara kumulatif periode Januari-${bln} ${thn}, total penumpang mencapai ${f0(penumpang.cumCurr)} orang, `
    + `${arahDinamis(penumpang.yoy)} ${fp(penumpang.yoy)} persen dibandingkan periode yang sama tahun lalu. `
    + `Total barang kumulatif mencapai ${f2(barang.cumCurr)} ${satuan}.`;
  return [p1, p2];
}
