import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggByProvinsi, computeStats, fallbackNarrative, formatIdNumber, growthRows,
  isFlagged, pctChange, prevPeriod, reportTable, sortPeriods, yoySeries,
} from './lib.js';
import {
  fallbackTransportNarrative, normalisasiEntitas, normalizeNarrative, transportReport,
} from './lib-transport.js';
import { cleanNumber, computeUploadStats, parseTransportFile } from './etl-transport.js';
import { toNumber } from './etl-pariwisata.js';
import { exportFileName } from './export.js';

test('prevPeriod rolls back over the year boundary', () => {
  assert.deepEqual(prevPeriod(2026, 'September'), { thn: 2026, bln: 'Agustus' });
  assert.deepEqual(prevPeriod(2026, 'Januari'), { thn: 2025, bln: 'Desember' });
});

test('pctChange guards zero and missing baselines', () => {
  assert.equal(pctChange(120, 100), 20);
  assert.equal(pctChange(80, 100), -20);
  assert.equal(pctChange(5, 0), null);
  assert.equal(pctChange(null, 10), null);
});

test('aggByProvinsi sums matching provinces and ignores the rest', () => {
  const rows = [
    { nama_provinsi: 'PAPUA SELATAN', a: '10', b: 1 },
    { nama_provinsi: 'Papua Selatan', a: 5, b: 2 },
    { nama_provinsi: 'Jawa Barat', a: 999, b: 999 },
  ];
  const agg = aggByProvinsi(rows, ['a', 'b']);
  assert.deepEqual(agg['Papua Selatan'], { a: 15, b: 3 });
  assert.equal(agg['Jawa Barat'], undefined);
});

test('computeStats produces month-to-month and year-to-date deltas', () => {
  const agg = (v) => aggByProvinsi([{ nama_provinsi: 'Papua', v }], ['v']);
  const stats = computeStats(agg(150), agg(100), agg(300), agg(240), ['v']);
  assert.equal(stats.curr, 150);
  assert.equal(stats.mtm, 50);
  assert.equal(stats.yoy, 25);
});

test('growthRows keeps PROVINSI_ORDER and nulls missing baselines', () => {
  const rows = growthRows(
    aggByProvinsi([{ nama_provinsi: 'Papua', v: 110 }], ['v']),
    aggByProvinsi([], ['v']),
    ['v'],
    ['VOLUME'],
  );
  assert.equal(rows.length, 4);
  assert.equal(rows[0].provinsi, 'Papua');
  assert.equal(rows[0].values[0], null);
});

test('formatIdNumber uses Indonesian separators', () => {
  assert.equal(formatIdNumber(1234567.891, 2), '1.234.567,89');
  assert.equal(formatIdNumber(0, 0), '0');
  assert.equal(formatIdNumber(null), 'Undefined');
});

test('fallbackNarrative names the direction of the change', () => {
  const stats = { curr: 1200, prev: 1000, mtm: 20, cumCurr: 5000, cumPrev: 5000, yoy: 0 };
  const [first] = fallbackNarrative('Laut', 'September', 2026, 'Agustus', 2026, stats, stats, 'ton');
  assert.match(first, /mengalami lonjakan/);
  assert.match(first, /1\.200 orang/);
});

test('sortPeriods dedupes and orders by year then month', () => {
  const rows = [
    { tahun: '2026', bulan: 'Januari' },
    { tahun: 2025, bulan: 'Desember' },
    { tahun: 2026, bulan: 'Januari' },
  ];
  assert.deepEqual(sortPeriods(rows), [
    { thn: 2025, bln: 'Desember' },
    { thn: 2026, bln: 'Januari' },
  ]);
});

test('reportTable keeps every kelas, stars high RSE and lets Prov_Jenis win the Total', () => {
  const rows = [
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 1, year: 2026, month: 8, tpk: 40, tpk_rse: 0.1 },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 2, year: 2026, month: 8, tpk: 30, tpk_rse: 0.4 },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 1, year: 2026, month: 7, tpk: 36 },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 1, year: 2025, month: 8, tpk: 32 },
  ];
  const ref = new Map([['Hotel Bintang|2026|8', { tpk: 41.5 }]]);
  const table = reportTable(rows, {
    jenis: 'Hotel Bintang', indicator: 'tpk', year: 2026, month: 8,
    prevYear: 2026, prevMonth: 7, lastYear: 2025, domain: [1, 2, 3], ref,
  });
  assert.deepEqual(table.body.map((r) => r.label), ['Bintang 1', 'Bintang 2', 'Bintang 3']);
  assert.equal(table.body[1].current, '30.00*');
  assert.equal(table.body[0].dPrev, '+4.00 pts');
  assert.equal(table.body[2].prev, '-');
  assert.equal(table.starCount, 1);
  assert.equal(table.total.current, '41.50');
  assert.equal(table.total.dPrev, '+5.50 pts');
});

test('yoySeries stops the current year at the selected month and prefers ref values', () => {
  const rows = [
    { jenis_akomodasi: 'Hotel Bintang', year: 2026, month: 7, tpk: 20 },
    { jenis_akomodasi: 'Hotel Bintang', year: 2026, month: 8, tpk: 30 },
    { jenis_akomodasi: 'Hotel Bintang', year: 2025, month: 12, tpk: 10 },
  ];
  const series = yoySeries(rows, {
    jenis: 'Hotel Bintang', indicator: 'tpk', year: 2026, month: 8,
    ref: new Map([['Hotel Bintang|2026|8', { tpk: 33 }]]),
  });
  assert.equal(series.prevYear, 2025);
  assert.equal(series.cur[7], 33);
  assert.equal(series.cur[8], null);
  assert.equal(series.prev[11], 10);
  assert.equal(series.labels[7], 'Agu');
});

test('normalisasiEntitas strips modal prefixes and maps Nabire to Douw Aturure', () => {
  assert.equal(normalisasiEntitas('Bandara Sentani', 'Transportasi Udara'), 'Sentani');
  assert.equal(normalisasiEntitas('Bandara Nabire', 'Transportasi Udara'), 'Douw Aturure');
  assert.equal(normalisasiEntitas('Pelabuhan Jayapura', 'Transportasi Laut'), 'Jayapura');
});

test('transportReport lays out the BRS hierarchy, converts kg to ton and recomputes pct', () => {
  const mk = (tahun, bulan, bandara, kg) => ({
    tahun, bulan, nama_bandara: bandara, barang_muat_kg: kg, nama_provinsi: 'PAPUA',
  });
  const rows = [
    mk(2026, 'Agustus', 'Bandara Sentani', 1000),
    mk(2026, 'Agustus', 'Bandara Frans Kaisiepo', 500),
    mk(2026, 'Juli', 'Bandara Sentani', 500),
    mk(2025, 'Agustus', 'Bandara Sentani', 400),
    mk(2026, 'Januari', 'Bandara Sentani', 1000),
  ];
  const table = transportReport(rows, {
    col: 'barang_muat_kg', label: 'Barang Muat (Ton)', rowCol: 'nama_bandara',
    moda: 'Transportasi Udara', prov: 'Papua',
    year: 2026, monthName: 'Agustus', prevYear: 2026, prevMonthName: 'Juli',
  });
  assert.equal(table.columns.curr, 'Agustus 2026');
  assert.equal(table.columns.cumPrev, 'Jan-Agustus 2025');
  const labels = table.rows.map((r) => r.label);
  // separator row is emitted whenever the province has a "lainnya" block, even
  // when no other bandara reports in the period (matches build_brs_display_table)
  assert.deepEqual(labels, [
    'Sentani', 'Frans Kaisiepo', 'Subtotal', 'Bandara Lainnya', 'Total',
  ]);
  const sentani = table.rows[0];
  assert.equal(sentani.curr, '1,00');
  assert.equal(sentani.prev, '0,50');
  assert.equal(sentani.mtm, '100,00');
  assert.equal(sentani.cumPrev, '0,40');
  // Jan + Jul + Aug 2026 (all inside the cumulative window) = 2,5 ton
  assert.equal(sentani.cumCurr, '2,50');
  assert.equal(sentani.yoy, '525,00');
  const total = table.rows.at(-1);
  assert.equal(total.prev, '0,50');
  assert.equal(total.curr, '1,50');
  assert.equal(total.mtm, '200,00');
  assert.equal(table.rows[2].kind, 'subtotal');
  assert.equal(table.rows[3].kind, 'other');
  assert.equal(table.rows[3].mtm, 'undefined');
  assert.equal(table.rows[3].curr, '');
});

test('fallbackTransportNarrative is deterministic and normalizes Indonesian numbers', () => {
  const meta = { subject: 'Jumlah penumpang yang datang', satuan: 'orang', penumpang: true };
  const total = { prev: 1000, curr: 1250, cumPrev: 8000, cumCurr: 9000, mtm: 25, yoy: 12.5 };
  const one = fallbackTransportNarrative({
    total, meta, moda: 'Transportasi Udara', prov: 'Papua', bln: 'Agustus', thn: 2026,
    prevBln: 'Juli', prevThn: 2026,
  });
  const two = fallbackTransportNarrative({
    total, meta, moda: 'Transportasi Udara', prov: 'Papua', bln: 'Agustus', thn: 2026,
    prevBln: 'Juli', prevThn: 2026,
  });
  assert.deepEqual(one, two);
  assert.equal(one.length, 2);
  assert.match(one[0], /1\.250 orang/);
  assert.match(one.join(' '), /lonjakan/);
  assert.equal(normalizeNarrative('naik 10,5% dari 7.778,45 ton', 'dn_muat_barang_ton'), 'naik 10,50 persen dari 7.778,45 ton');
});

const BPS_UDARA_HTML = `<html><body><table>
<tr><th colspan="11">PROVINSI PAPUA Tahun 2026 Bulan Agustus</th></tr>
<tr><th>Provinsi</th><th>Kabupaten</th><th>Bandara</th><th>Pesawat Terbang</th></tr>
<tr><td>[94] PAPUA</td><td>[9403] KABUPATEN JAYAPURA</td><td>[940301] SENTANI</td><td>-</td>
  <td>1.000</td><td>1.100</td><td>57.941</td><td>54.760</td><td>0</td><td>1,5</td><td>656,549</td></tr>
<tr><td>JUMLAH</td><td></td><td></td><td></td>
  <td>1.000</td><td>1.100</td><td>57.941</td><td>54.760</td><td>0</td><td>1,5</td><td>656,549</td></tr>
</table></body></html>`;

test('cleanNumber mirrors the Python dot-thousands / comma-decimal rule', () => {
  assert.equal(cleanNumber('10.000'), 10000);
  assert.equal(cleanNumber('2,5'), 2.5);
  assert.equal(cleanNumber('7.778,45'), 7778.45);
  assert.equal(cleanNumber('-'), 0);
  assert.equal(cleanNumber(''), 0);
});

test('parseTransportFile reads a BPS HTML table and attributes the province', () => {
  const { tableType, rows } = parseTransportFile(Buffer.from(BPS_UDARA_HTML, 'utf8'), 2026, 'Agustus');
  assert.equal(tableType, 'transportasi_udara');
  assert.equal(rows.length, 1, 'JUMLAH row is skipped');
  const [row] = rows;
  assert.equal(row.nama_bandara, 'SENTANI');
  assert.equal(row.nama_provinsi, 'PAPUA');
  assert.equal(row.kode_provinsi, 94);
  assert.equal(row.penumpang_datang, 54760);
  assert.equal(row.barang_bongkar_kg, 656.549);

  const stats = computeUploadStats(tableType, rows);
  assert.equal(stats.jumlah_baris, 1);
  assert.equal(stats.total_penumpang, 54760 + 57941);
  assert.equal(stats.satuan_barang, 'kg');
});

test('parseTransportFile rejects files whose kabupaten is unmapped', () => {
  const html = BPS_UDARA_HTML.replace('KABUPATEN JAYAPURA', 'KABUPATEN ANTARTIKA');
  assert.throws(
    () => parseTransportFile(Buffer.from(html, 'utf8'), 2026, 'Agustus'),
    /PEMETAAN_WILAYAH/,
  );
});

test('exportFileName keeps province and period in every download name', () => {
  const payload = { prov: 'Papua Selatan', thn: 2026, bln: 'September' };
  assert.equal(exportFileName('pptx', payload), 'dashboard_transportasi_September_2026.pptx');
  assert.equal(exportFileName('docx', payload), 'Master_Laporan_Transportasi_Papua_Selatan_September_2026.docx');
  assert.equal(exportFileName('idml-transport', payload), 'BRS_Transportasi_Papua_Selatan_September_2026.zip');
  assert.equal(exportFileName('idml-pariwisata', payload), 'BRS_Pariwisata_Papua_Selatan_September_2026.zip');
  assert.equal(exportFileName('xlsx-transport', payload), 'Tabel_Transportasi_Papua_Selatan_September_2026.xlsx');
  assert.equal(exportFileName('xlsx-pariwisata', payload), 'Tabel_Pariwisata_Papua_Selatan_September_2026.xlsx');
});

// ---------------------------------------------------------------------------
// Export banner: it must never claim "EPERM" again, must explain the real reason,
// and must stay hidden from roles that cannot export at all.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { landingPage, setExportAvailability, transportasiPage } from './views.js';

const viewsSource = readFileSync(new URL('./views.js', import.meta.url), 'utf8');

test('views.js no longer hard-codes the old EPERM banner sentence', () => {
  assert.ok(!viewsSource.includes('Python bridge tidak dapat dijalankan di lingkungan ini'));
  assert.ok(!viewsSource.includes('Jalankan ulang <code>node server.js</code>'));
  assert.ok(viewsSource.includes('exportReason('), 'banner must render the reported reason');
});

test('no export banner is rendered when exports are healthy', () => {
  setExportAvailability({ ok: true, mode: 'service' });
  const html = landingPage({ user: { name: 'Admin', role: 'admin' } });
  assert.ok(!html.includes('Ekspor dokumen nonaktif'));
});

test('an unavailable exporter renders the reported reason, not a guess', () => {
  setExportAvailability({ ok: false, mode: 'none', code: 'ENOENT', message: 'python tidak ditemukan' });
  const html = landingPage({ user: { name: 'Admin', role: 'admin' } });
  assert.ok(html.includes('Ekspor dokumen nonaktif'), 'banner expected when exports are down');
  assert.ok(html.includes('python tidak ditemukan'), 'must show the real reason');
  assert.ok(!html.includes('EPERM'), 'must not invent EPERM');
  assert.ok(html.includes('python export_service.py'), 'must tell the user how to fix it');
});

test('the export-less rekon role never sees the banner', () => {
  setExportAvailability({ ok: false, mode: 'none', message: 'apa pun' });
  const html = landingPage({ user: { name: 'Analis', role: 'rekon' } });
  assert.ok(!html.includes('Ekspor dokumen nonaktif'));
  setExportAvailability({ ok: true, mode: 'service' });
});

test('a stale sidecar warns without pretending exports are dead', () => {
  setExportAvailability({ ok: true, mode: 'service', warning: 'Sidecar berjalan dengan kode lama (x.py).' });
  const html = landingPage({ user: { name: 'Admin', role: 'admin' } });
  assert.ok(html.includes('Perhatian'), 'warning banner expected');
  assert.ok(html.includes('kode lama'), 'must name the problem');
  assert.ok(!html.includes('Ekspor dokumen nonaktif'), 'must not claim exports are off');
  setExportAvailability({ ok: true, mode: 'service' });
});

test('the transport Regenerasi form posts a numeric month and full period', () => {
  // Regression: the report items carried no prov/tahun/bulan/moda, so the hidden
  // inputs rendered empty and the narrative bridge raised
  // "int() argument must be ... not 'NoneType'". The month must also be the
  // number, because the bridge does int(payload["bulan"]).
  const report = {
    provinces: ['Papua Tengah'], province: 'Papua Tengah',
    years: [2026], months: [9], year: 2026, monthName: 'September', warning: null,
    groups: [{
      moda: 'Transportasi Udara', icon: 'plane',
      items: [{
        tableNo: 1, label: 'Penumpang Datang',
        title: 'Tabel 1', rowLabel: 'Bandara', col: 'datang',
        columns: ['Bandara', 'Agustus 2026', 'September 2026'],
        rows: [],
        prov: 'Papua Tengah', tahun: 2026, bulan: 'September', bulanNo: 9, moda: 'Transportasi Udara',
        narrative: { source: 'Database (Cached)', paras: ['Contoh narasi.'] },
      }],
    }],
  };
  const html = transportasiPage({
    user: { name: 'Admin', role: 'admin' },
    periods: [{ thn: 2026, bln: 'September' }],
    selected: { thn: 2026, bln: 'September' },
    sections: [],
    tab: 'report',
    report,
  });
  assert.ok(html.includes('name="provinsi" value="Papua Tengah"'), 'provinsi must be filled');
  assert.ok(html.includes('name="tahun" value="2026"'), 'tahun must be filled');
  assert.ok(html.includes('name="bulan" value="9"'), 'bulan must be the number 9');
  assert.ok(!html.includes('name="bulan" value=""'), 'bulan must never be blank');
  assert.ok(html.includes('name="moda" value="Transportasi Udara"'), 'moda must be filled');
});
// ---------------------------------------------------------------------------
// Export supervisor + boot preflight
// ---------------------------------------------------------------------------
const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');

test('the boot preflight forwards the full export status, not a bare boolean', () => {
  // A boolean drops mode/code/message, so the banner cannot explain the failure.
  assert.ok(serverSource.includes('setExportAvailability(status)'),
    'must pass the status object');
  assert.ok(!serverSource.includes('setExportAvailability(status.ok)'),
    'must not pass status.ok');
});

test('the boot preflight never logs "undefined" for service mode', () => {
  // Service mode carries no `.python` field; interpolating it printed
  // "Python bridge siap (undefined)".
  assert.ok(!serverSource.includes('siap (${status.python})'),
    'must branch on status.mode instead of assuming .python');
  assert.ok(serverSource.includes("status.mode === 'service'"), 'must handle service mode');
});

test('the stale-sidecar hint points at the supervisor', () => {
  const exportSource = readFileSync(new URL('./export.js', import.meta.url), 'utf8');
  assert.ok(exportSource.includes('export-supervisor.mjs'),
    'stale warning must name the auto-restarting runner');
});

test('the supervisor restarts only when the sidecar reports stale modules', () => {
  // Mirrors export-supervisor.mjs's poll() decision without spawning python.
  const needsRestart = (h) => Boolean(h && Array.isArray(h.stale) && h.stale.length);
  assert.equal(needsRestart({ ok: true, stale: ['export_bridge.py'] }), true);
  assert.equal(needsRestart({ ok: true, stale: [] }), false);
  assert.equal(needsRestart({ ok: true }), false);
  assert.equal(needsRestart(null), false);
});

test('the pariwisata prompt uses hari/poin units, never "malam"', () => {
  // BRS units: TPK value persen, RLMT value hari, both deltas poin. The prompt
  // previously told the model to write RLMT values and deltas in "malam", so
  // every generated RLMT narrative read "1,95 malam / naik 0,16 malam".
  const prompt = readFileSync(new URL('./pariwisata_prompt.py', import.meta.url), 'utf8');
  assert.ok(!/malam/.test(prompt), 'prompt must not mention "malam"');
  // The prompt source stores escaped quotes (\\"hari\\"), so match that form.
  assert.ok(prompt.includes('\\"hari\\"'), 'RLMT value unit must be hari');
  assert.ok(prompt.includes('selisih ditulis dalam \\"poin\\"'), 'RLMT delta unit must be poin');
  assert.ok(prompt.includes('[persen/hari]'), 'paragraph skeleton must offer persen/hari');
});test('the (*) marker covers "Tidak dapat rilis" as well as high RSE', () => {
  // The VHTS workbook carries tpk_ket / rlmtgab_ket. A "Tidak dapat rilis" figure
  // must be starred even though every such row has RSE 0, so the rule is an OR.
  assert.equal(isFlagged({ tpk: 63.2, tpk_rse: 0, tpk_ket: 'Tidak dapat rilis' }, 'tpk', 63.2), true);
  assert.equal(isFlagged({ tpk: 18.3, tpk_rse: 0.76, tpk_ket: 'Dapat rilis' }, 'tpk', 18.3), true);
  assert.equal(isFlagged({ tpk: 40, tpk_rse: 0.1, tpk_ket: 'Dapat rilis' }, 'tpk', 40), false);
  // Near-miss wording must not be swept up.
  assert.equal(isFlagged({ tpk_ket: 'Take all, dapat rilis' }, 'tpk', 40), false);
  assert.equal(isFlagged({ tpk_ket: 'Dapat rilis dengan catatan' }, 'tpk', 40), false);
  // Each indicator reads its own column.
  assert.equal(isFlagged({ rlmtgab_ket: 'Tidak dapat rilis' }, 'rlmtgab', 1.7), true);
  assert.equal(isFlagged({ tpk_ket: 'Tidak dapat rilis' }, 'rlmtgab', 1.7), false);
});

test('reportTable reports why a row is starred', () => {
  const rows = [
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 5, year: 2026, month: 9, tpk: 63.27, tpk_rse: 0, tpk_ket: 'Tidak dapat rilis' },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 2, year: 2026, month: 9, tpk: 20, tpk_rse: 0.9, tpk_ket: 'Dapat rilis' },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 1, year: 2026, month: 9, tpk: 9.14, tpk_rse: 0, tpk_ket: 'Dapat rilis' },
  ];
  const table = reportTable(rows, { jenis: 'Hotel Bintang', indicator: 'tpk', year: 2026, month: 9, prevYear: 2026, prevMonth: 8, lastYear: 2025, domain: [1, 2, 5] });
  assert.equal(table.body.find((r) => r.kelas === 5).starReason, 'ket');
  assert.equal(table.body.find((r) => r.kelas === 2).starReason, 'rse');
  assert.equal(table.body.find((r) => r.kelas === 1).starReason, null);
  assert.equal(table.starCount, 2);
});

test('toNumber tells Indonesian and plain decimals apart', () => {
  // Regression: blindly stripping dots turned the raw cell "17.9977766075712"
  // into 179977766075712, which would have corrupted every uploaded figure.
  assert.equal(toNumber('17.9977766075712'), 17.9977766075712);
  assert.equal(toNumber('-0.045'), -0.045);
  assert.equal(toNumber('0.045'), 0.045);
  assert.equal(toNumber('1.5'), 1.5);
  assert.equal(toNumber('1.234,56'), 1234.56);
  assert.equal(toNumber('2,5'), 2.5);
  assert.equal(toNumber('10.000'), 10000);
  assert.equal(toNumber('1.234.567,89'), 1234567.89);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('abc'), null);
});test('the comparison columns are starred on their own period', () => {
  // Each column is judged on the row of its own period: a figure is starred for
  // its own RSE/status, never inherited from the current month.
  const rows = [
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 1, year: 2026, month: 9, tpk: 40, tpk_rse: 0, tpk_ket: 'Tidak dapat rilis' },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 1, year: 2026, month: 8, tpk: 36, tpk_rse: 0, tpk_ket: 'Dapat rilis' },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 1, year: 2025, month: 9, tpk: 32, tpk_rse: 0.9, tpk_ket: 'Dapat rilis' },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 2, year: 2026, month: 9, tpk: 20, tpk_rse: 0, tpk_ket: 'Dapat rilis' },
    { jenis_akomodasi: 'Hotel Bintang', kelas_akomodasi: 2, year: 2026, month: 8, tpk: 25, tpk_rse: 0.8, tpk_ket: 'Dapat rilis' },
  ];
  const t = reportTable(rows, { jenis: 'Hotel Bintang', indicator: 'tpk', year: 2026, month: 9, prevYear: 2026, prevMonth: 8, lastYear: 2025, domain: [1, 2] });
  const k1 = t.body.find((r) => r.kelas === 1);
  const k2 = t.body.find((r) => r.kelas === 2);
  // kelas 1: current flagged by ket, last flagged by RSE, prev clean
  assert.equal(k1.starred, true);
  assert.equal(k1.starredLast, true);
  assert.equal(k1.starredPrev, false);
  // kelas 2: only the previous month is weak
  assert.equal(k2.starred, false);
  assert.equal(k2.starredPrev, true);
  assert.equal(k2.starredLast, false);
  // starCount drives whether the footnote is shown, so it counts ROWS with at
  // least one starred cell, not the number of starred cells.
  assert.equal(t.starCount, 2);
});