import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggByProvinsi, arahDinamis, computeStats, fallbackNarrative, formatIdNumber, growthRows,
  isFlagged, pctChange, prevPeriod, reportTable, sortPeriods, yoySeries,
} from './lib.js';
import {
  bannedNarrativeTerms, fallbackTransportNarrative, isPublishableNarrative,
  normalisasiEntitas, normalizeNarrative, transportReport,
} from './lib-transport.js';
import { cleanNumber, computeUploadStats, parseTransportFile } from './etl-transport.js';
import { toNumber } from './etl-pariwisata.js';
import { namaPelabuhan } from './pelabuhan-nama.js';
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
  assert.match(first, /(meningkat|menurun|relatif stabil)/);
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
import { landingPage, perdaganganPage, setExportAvailability, transportasiPage } from './views.js';

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
});test('cached narratives that break the BRS style are rejected', () => {
  // The dashboard used to publish texts written by an older, looser prompt:
  // "27.741 individu", "menandakan penurunan", "faktor musiman".
  assert.equal(isPublishableNarrative('Jumlah penumpang mencapai 27.741 individu.'), false);
  assert.equal(isPublishableNarrative('Angka ini menandakan penurunan.'), false);
  assert.equal(isPublishableNarrative('Penurunan tajam sebesar 5,2 persen.'), false);
  assert.equal(isPublishableNarrative('Naik secara signifikan.'), false);
  assert.equal(isPublishableNarrative(''), false);
  assert.equal(isPublishableNarrative(null), false);
  // A well-formed BRS sentence still passes.
  assert.equal(
    isPublishableNarrative('Jumlah penumpang angkutan udara yang datang pada September 2026 sebanyak 43.764 orang atau turun 2,93 persen dibandingkan Agustus 2026.'),
    true,
  );
  assert.deepEqual(bannedNarrativeTerms('melonjak dan signifikan'), ['melonjak', 'signifikan']);
});

test('arahDinamis stays neutral and the magnitude has no sign', () => {
  // "melonjak"/"tajam" are forbidden, and printing a signed number after the
  // direction word produced "menurun sebesar -8,90 persen".
  assert.equal(arahDinamis(15), 'meningkat');
  assert.equal(arahDinamis(-15), 'menurun');
  assert.equal(arahDinamis(0), 'relatif stabil');
  const paras = fallbackNarrative('Transportasi Laut', 'September', 2026, 'Agustus', 2026,
    { curr: 59156, prev: 64934, mtm: -8.9, yoy: -3.2, cumCurr: 651515 },
    { curr: 594749.1, prev: 619407.8, mtm: -3.98, cumCurr: 5000000 }, 'ton');
  const text = paras.join(' ');
  assert.ok(!/sebesar\s*-/.test(text), 'no signed magnitude after the direction word');
  assert.ok(!/melonjak|tajam|signifikan/i.test(text), 'no forbidden wording');
  assert.ok(text.includes('menurun sebesar 8,90 persen'), 'magnitude printed unsigned');
});test('the pariwisata prompt spells the class level in words, not digits', () => {
  // Requested: "bintang 1" must be written "bintang satu" in the narrative.
  const prompt = readFileSync(new URL('./pariwisata_prompt.py', import.meta.url), 'utf8');
  assert.ok(prompt.includes('Angka tingkat kelas selalu ditulis dengan huruf'),
    'rule must be present');
  assert.ok(prompt.includes('hotel bintang satu'), 'gives the word form as an example');
  assert.ok(prompt.includes('Jangan menulis'), 'names the forbidden digit form');
});// ---------------------------------------------------------------------------
// Perdagangan (ekspor-impor)
// ---------------------------------------------------------------------------
import { readZip } from './zip-reader.js';
import { importPeriod, num, readDbf, toEkspor, toImpor } from './dbf-perdagangan.js';
import { parsePerdaganganZip } from './etl-perdagangan.js';

test('readDbf parses a dBase III header and records', () => {
  // Bangun DBF minimal: 1 field C(4) + 1 field N(10), 2 record.
  const fields = [['KODE', 'C', 4], ['NILAI', 'N', 10]];
  const rlen = 1 + 4 + 10;
  const hlen = 32 + fields.length * 32 + 1;
  const buf = Buffer.alloc(hlen + 2 * rlen, 0x20);
  buf[0] = 0x03;
  buf.writeUInt32LE(2, 4);
  buf.writeUInt16LE(hlen, 8);
  buf.writeUInt16LE(rlen, 10);
  fields.forEach(([name, type, len], i) => {
    const p = 32 + i * 32;
    buf.write(name.padEnd(11, '\u0000'), p, 'ascii');
    buf.write(type, p + 11, 'ascii');
    buf[p + 16] = len;
  });
  buf[hlen - 1] = 0x0d;
  // Tiap record diawali satu byte flag (0x20 = aktif), lalu field-field.
  buf.write(' ABCD   123.45', hlen, 'latin1');
  buf.write(' EFGH     0.00', hlen + rlen, 'latin1');
  const { fields: f, rows } = readDbf(buf);
  assert.equal(f.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].KODE, 'ABCD');
  assert.equal(num(rows[0].NILAI), 123.45);
  assert.equal(num(''), 0);
});

test('importPeriod reads the B<MMYY> / N<MMYY> pair', () => {
  // B0926 = netto (kg), N0926 = nilai (US$). Urutan ini diverifikasi terhadap
  // berkas *_total.DBF; menukarnya membuat seluruh angka impor keliru.
  const p = importPeriod(['TIPE', 'HS', 'B0926', 'N0926']);
  assert.deepEqual({ bulan: p.bulan, tahun: p.tahun }, { bulan: 9, tahun: 2026 });
  assert.equal(p.bCol, 'B0926');
  assert.equal(p.nCol, 'N0926');
  assert.throws(() => importPeriod(['TIPE', 'HS']), /B<MMYY>/);
});

test('toEkspor / toImpor map the DBF columns', () => {
  const e = toEkspor({ YEAR: '2026', MTH: '09', KODE_HS: '44071100', HS2: '44', PROVORIG: '9471',
    PEL_MUAT: 'IDJYP', PELABUHAN: '35563', NEGARA: '4411', NGRTUJUAN: 'US', KETERANGAN: 'NonMigas',
    NETTO: '1000.5', FOB: '2000.25' }, 'Papua', 'PROVORIG');
  assert.equal(e.hs8, '44071100');
  assert.equal(e.hs2, '44');
  assert.equal(e.migas, 'NonMigas');
  assert.equal(e.fob, 2000.25);
  const i = toImpor({ TIPE: 'M', JENIS: 'NM', HS: '40081900', K_NEGARA: '124', NEG_ASAL: 'MY',
    K_PELB: '31434', PEL_BONG: 'IDCGK', KPPBC: '120900', NAMA_KPPBC: 'KPPBC BIAK',
    B0926: '630', N0926: '152' }, 'Papua', 'KPPBC', { tahun: 2026, bulan: 9, bCol: 'B0926', nCol: 'N0926' });
  assert.equal(i.netto, 630, 'B column is netto');
  assert.equal(i.cif, 152, 'N column is value');
  assert.equal(i.migas, 'NonMigas');
});

test('readZip rejects a buffer that is not a ZIP', () => {
  assert.throws(() => readZip(Buffer.from('bukan zip')), /ZIP/);
});test('the perdagangan admin page exposes the ZIP upload form', () => {
  const html = perdaganganPage({
    user: { name: 'Admin', role: 'admin' }, tab: 'admin',
    provinsi: ['Papua'], province: 'Papua', tahun: 2026, bulan: 8, periods: [{ tahun: 2026, bulan: 8 }],
    admin: {
      stage: 'abc123',
      ringkas: [{ prov: 'Papua', kode: '94', ekspor: 401, impor: 13,
        validasi: [{ arus: 'ekspor', basis: 'PROVORIG', dicocokkan: true }], warnings: [] }],
      log: [], periode: [{ tahun: 2026, bulan: 8, ekspor: 406, impor: 1257 }], flash: null,
    },
  });
  assert.ok(html.includes('action="/perdagangan/admin/upload"'), 'form unggah ZIP harus ada');
  assert.ok(html.includes('action="/perdagangan/admin/save"'), 'tombol simpan pratinjau harus ada');
  assert.ok(html.includes('Simpan ke Database'), 'label simpan');
  assert.ok(html.includes('Papua Selatan') || html.includes('Papua'), 'ringkasan provinsi tampil');
});

test('the perdagangan export card lives on the Laporan tab and posts to idml', () => {
  const nilai = [null, null, 100, null, 250];
  const laporan = {
    ekspor: { ringkasan: [{ label: 'Total', nilai }], hs2: [], negara: [], pelabuhan: [] },
    impor: { ringkasan: [{ label: 'Total', nilai }], hs2: [], negara: [], pelabuhan: [] },
    neraca: { ringkasan: [{ label: 'Total', nilai }], rekap: [] },
  };
  const html = perdaganganPage({
    user: { name: 'Admin', role: 'admin' }, tab: 'laporan',
    provinsi: ['Papua Selatan'], province: 'Papua Selatan', tahun: 2026, bulan: 8,
    periods: [{ tahun: 2026, bulan: 8 }],
    ringkasan: {
      bulanIni: { ekspor: 0, eksporMigas: 0, eksporNonMigas: 0, impor: 5318732.79, imporMigas: 0, imporNonMigas: 5318732.79 },
      kumulatif: { ekspor: 0, impor: 5318732.79 },
    },
    seri: { ekspor: [], impor: [], neraca: [] }, hs2: { ekspor: [], impor: [] },
    negara: { ekspor: [], impor: [] }, pelabuhan: { ekspor: [], impor: [] },
    laporan,
  });
  assert.ok(html.includes('action="/export/perdagangan/idml"'), 'form unduh menuju rute idml');
  assert.ok(html.includes('method="post"'), 'form unduh memakai POST seperti Pariwisata');
  assert.ok(html.includes('enctype="multipart/form-data"'), 'form unduh menerima berkas');
  ['infografis', 'qr', 'nomor', 'tanggal'].forEach((n) => {
    assert.ok(html.includes(`name="${n}"`), `isian ${n} ada`);
  });
  assert.ok(html.includes('/export/perdagangan/xlsx'), 'tautan Excel ada');
  assert.ok(html.includes('name="bulan" value="Agustus"'), 'bulan dikirim sebagai nama');

  // Kartu unduh tidak lagi menempel di tab Ringkasan.
  const ringkasan = perdaganganPage({
    user: { name: 'Admin', role: 'admin' }, tab: 'ringkasan',
    provinsi: ['Papua Selatan'], province: 'Papua Selatan', tahun: 2026, bulan: 8,
    periods: [{ tahun: 2026, bulan: 8 }],
    ringkasan: {
      bulanIni: { ekspor: 0, eksporMigas: 0, eksporNonMigas: 0, impor: 1, imporMigas: 0, imporNonMigas: 1 },
      kumulatif: { ekspor: 0, impor: 1 },
    },
    seri: { ekspor: [], impor: [], neraca: [] }, hs2: { ekspor: [], impor: [] },
    negara: { ekspor: [], impor: [] }, pelabuhan: { ekspor: [], impor: [] },
  });
  assert.ok(!ringkasan.includes('/export/perdagangan/idml'), 'kartu unduh pindah dari Ringkasan');
  assert.equal(exportFileName('idml-exim', { prov: 'Papua Selatan', bln: 'Agustus', thn: 2026 }),
    'BRS_Exim_Papua_Selatan_Agustus_2026.zip');
});test('the landing page lists all three modules as full-height cards', () => {
  const html = landingPage({
    user: { name: 'Admin', role: 'admin' },
    pari: { periods: 21, provinces: 4, last: { thn: 2026, bln: 'September' } },
    trans: { periods: 21, last: { thn: 2026, bln: 'September' } },
    dagang: { periods: 2, last: { thn: 2026, bln: 'September' } },
  });
  assert.ok(html.includes('class="landing-screen"'), 'wrapper layar penuh');
  assert.equal((html.match(/class="landing-card"/g) || []).length, 3, 'tiga kartu modul');
  ['Pariwisata', 'Transportasi', 'Perdagangan'].forEach((label) => {
    assert.ok(html.includes(`>${label}</span>`), `kartu ${label} ada`);
  });
  assert.ok(html.includes('href="/perdagangan"'), 'kartu perdagangan menuju modulnya');
});

test('Perdagangan is no longer a sidebar link for admins', () => {
  const html = landingPage({ user: { name: 'Admin', role: 'admin' } });
  const nav = /<nav class="side-nav">([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.ok(!nav.includes('/perdagangan'), 'sidebar tidak lagi memuat Perdagangan');
  assert.ok(nav.includes('href="/"'), 'Beranda tetap ada');
});test('the Laporan tab renders the full perdagangan report', () => {
  const laporan = {
    ekspor: {
      ringkasan: [{ label: 'Total', nilai: [null, null, 0, null, 0] }],
      hs2: [{ label: 'HS44', nilai: [null, null, 0, null, 0] }],
      negara: [{ label: 'Australia', nilai: [null, null, 0, null, 0] }],
      pelabuhan: [{ label: '-', nilai: [null, null, 0, null, 0] }],
    },
    impor: {
      ringkasan: [{ label: 'Total', nilai: [null, null, 5318.73, null, 5318.73] }],
      hs2: [{ label: 'Mesin & Peralatan Mekanis (HS84)', nilai: [null, null, 4532.66, null, 4532.66] }],
      negara: [{ label: 'Tiongkok', nilai: [null, null, 5318.73, null, 5318.73] }],
      pelabuhan: [{ label: '95979', nilai: [null, null, 5318.73, null, 5318.73] }],
    },
    neraca: {
      ringkasan: [{ label: 'Total', nilai: [null, null, -5318.73, null, -5318.73] }],
      rekap: Array.from({ length: 12 }, (_, i) => ({
        bulan: i + 1, eksporLast: 0, imporLast: 0, neracaLast: 0,
        eksporNow: null, imporNow: null, neracaNow: null, kumLast: 0, kumNow: null,
      })),
    },
  };
  const html = perdaganganPage({
    user: { name: 'Admin', role: 'admin' }, tab: 'laporan',
    provinsi: ['Papua Selatan'], province: 'Papua Selatan', tahun: 2026, bulan: 8,
    periods: [{ tahun: 2026, bulan: 8 }], ringkasan: null, laporan,
  });
  // Sepuluh bab bernomor 1..10, masing-masing tepat satu judul.
  const bab = [...html.matchAll(/<h3>(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(bab, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '10 bab perdagangan lengkap dan berurut');
  assert.ok(html.includes('5.318,73'), 'nilai impor tampil');
  assert.ok(html.includes('-5.318,73'), 'neraca negatif tampil');
  assert.ok(html.includes('Tiongkok'), 'nama negara, bukan kode');
  assert.ok(html.includes('HS84'), 'label golongan barang');
});test('the Laporan tab keeps the requested section order and adds two bar charts', () => {
  const nilai = [null, null, 100, null, 250];
  const blok = (label) => [
    { label: 'Total', nilai },
    { label: label, nilai: [null, null, 60, null, 160] },
  ];
  const laporan = {
    ekspor: { ringkasan: blok('Migas'), hs2: [{ label: 'HS44', nilai }],
      negara: [{ label: 'Australia', nilai }, { label: 'Total', nilai }],
      pelabuhan: [{ label: '-', nilai }] },
    impor: { ringkasan: blok('Migas'), hs2: [{ label: 'HS84', nilai }],
      negara: [{ label: 'Tiongkok', nilai }, { label: 'Total', nilai }],
      pelabuhan: [{ label: '95979', nilai }] },
    neraca: {
      ringkasan: [{ label: 'Total', nilai: [null, null, -100, null, -250] }],
      rekap: [],
    },
  };
  const html = perdaganganPage({
    user: { name: 'Admin', role: 'admin' }, tab: 'laporan',
    provinsi: ['Papua'], province: 'Papua', tahun: 2026, bulan: 8,
    periods: [{ tahun: 2026, bulan: 8 }], ringkasan: null, laporan,
  });

  // Urutan bab: Ekspor -> 1..3 -> grafik -> 5, Impor -> 6..8 -> grafik -> 10.
  const judul = [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);
  const idx = (frag) => judul.findIndex((j) => j.includes(frag));
  assert.ok(idx('1. Ringkasan Perkembangan Ekspor') >= 0, 'tabel 1 ekspor ada');
  assert.ok(idx('1. Ringkasan Perkembangan Ekspor') < idx('2. Nilai Ekspor'), '1 sebelum 2');
  assert.ok(idx('2. Nilai Ekspor') < idx('3. Nilai Ekspor'), '2 sebelum 3');
  assert.ok(idx('3. Nilai Ekspor') < idx('Perbandingan Nilai Kumulatif Ekspor'), '3 sebelum grafik ekspor');
  assert.ok(idx('Perbandingan Nilai Kumulatif Ekspor') < idx('5. Nilai Ekspor Menurut Pelabuhan'), 'grafik sebelum 5');
  assert.ok(idx('6. Nilai Impor Migas') < idx('7. Nilai Impor'), '6 sebelum 7');
  assert.ok(idx('7. Nilai Impor') < idx('8. Nilai Impor'), '7 sebelum 8');
  assert.ok(idx('8. Nilai Impor') < idx('Perbandingan Nilai Kumulatif Impor'), '8 sebelum grafik impor');
  assert.ok(idx('Perbandingan Nilai Kumulatif Impor') < idx('10. Ringkasan Perkembangan Neraca'), 'grafik sebelum 10');

  // Dua grafik batang dengan dua seri kumulatif.
  assert.ok(html.includes('id="pdg-negara-ekspor"'), 'kanvas ekspor ada');
  assert.ok(html.includes('id="pdg-negara-impor"'), 'kanvas impor ada');
  assert.ok(html.includes('"type":"bar"'), 'grafik bertipe bar');
  assert.ok(html.includes('Kumulatif 2025') && html.includes('Kumulatif 2026'), 'dua seri kumulatif');
});test('the Laporan tab groups 1-5 in Ekspor, 6-9 in Impor, and 10 separately', () => {
  const nilai = [null, null, 100, null, 250];
  const laporan = {
    ekspor: { ringkasan: [{ label: 'Total', nilai }], hs2: [{ label: 'HS44', nilai }],
      negara: [{ label: 'Australia', nilai }, { label: 'Total', nilai }],
      pelabuhan: [{ label: 'JAYAPURA', nilai }, { label: 'Total', nilai }] },
    impor: { ringkasan: [{ label: 'Total', nilai }], hs2: [{ label: 'HS84', nilai }],
      negara: [{ label: 'Tiongkok', nilai }, { label: 'Total', nilai }],
      pelabuhan: [{ label: 'MERAUKE', nilai }] },
    neraca: { ringkasan: [{ label: 'Total', nilai: [null, null, -100, null, -250] }], rekap: [] },
  };
  const html = perdaganganPage({
    user: { name: 'Admin', role: 'admin' }, tab: 'laporan',
    provinsi: ['Papua'], province: 'Papua', tahun: 2026, bulan: 8,
    periods: [{ tahun: 2026, bulan: 8 }], ringkasan: null, laporan,
  });

  // Empat kartu: tiga bab + kartu unduh yang pindah dari tab Ringkasan.
  const kartu = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(kartu, ['Ekspor', 'Impor', 'Neraca Perdagangan', '📥 Unduh BRS Ekspor-Impor']);

  // Nomor 1-5 berada setelah judul "Ekspor" dan sebelum judul "Impor".
  const pos = (frag) => html.indexOf(frag);
  assert.ok(pos('>Ekspor</h2>') < pos('1. Ringkasan Perkembangan Ekspor'));
  assert.ok(pos('5. Nilai Ekspor Menurut Pelabuhan Muat') < pos('>Impor</h2>'));
  assert.ok(pos('>Impor</h2>') < pos('6. Nilai Impor Migas'));
  assert.ok(pos('9. Perbandingan Nilai Kumulatif Impor') < pos('>Neraca Perdagangan</h2>'));
  assert.ok(pos('>Neraca Perdagangan</h2>') < pos('10. Ringkasan Perkembangan Neraca'));

  // Setiap tabel punya wadah narasi; dua grafik tidak.
  const slot = [...html.matchAll(/data-narasi="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(slot, ['ekspor-ringkasan', 'ekspor-hs2', 'ekspor-negara', 'ekspor-pelabuhan',
    'impor-ringkasan', 'impor-hs2', 'impor-negara', 'neraca-ringkasan']);
});

test('port codes are rendered with names from the master file', () => {
  assert.equal(namaPelabuhan('94974'), 'Jayapura');
  assert.equal(namaPelabuhan('31431'), 'Tanjung Priok');
  assert.equal(namaPelabuhan('94001'), 'Skouw');
  // Kode tak dikenal dikembalikan apa adanya, bukan kosong.
  assert.equal(namaPelabuhan('00000'), '00000');
  assert.equal(namaPelabuhan(null), '-');
});test('each perdagangan table has an AI narrative holder with a generate button', () => {
  const nilai = [null, null, 100, null, 250];
  const laporan = {
    ekspor: { ringkasan: [{ label: 'Total', nilai }], hs2: [{ label: 'HS44', nilai }],
      negara: [{ label: 'Australia', nilai }], pelabuhan: [{ label: 'JAYAPURA', nilai }] },
    impor: { ringkasan: [{ label: 'Total', nilai }], hs2: [{ label: 'HS84', nilai }],
      negara: [{ label: 'Tiongkok', nilai }], pelabuhan: [{ label: 'MERAUKE', nilai }] },
    neraca: { ringkasan: [{ label: 'Total', nilai: [null, null, -100, null, -250] }], rekap: [] },
  };
  const dasar = { tab: 'laporan', provinsi: ['Papua Selatan'], province: 'Papua Selatan',
    tahun: 2026, bulan: 8, periods: [{ tahun: 2026, bulan: 8 }], ringkasan: null, laporan };

  const admin = perdaganganPage({ ...dasar, user: { name: 'Admin', role: 'admin' } });
  assert.equal((admin.match(/action="\/perdagangan\/narasi\/generate"/g) || []).length, 8,
    'delapan form generate untuk delapan tabel');
  assert.ok(admin.includes('Buat Narasi AI'), 'tombol buat ada');

  const rekon = perdaganganPage({ ...dasar, user: { name: 'Rekon', role: 'rekon' } });
  assert.ok(!rekon.includes('/perdagangan/narasi/generate'), 'non-admin tanpa tombol');

  const berisi = perdaganganPage({ ...dasar, user: { name: 'Admin', role: 'admin' },
    narasi: { 'impor-negara': { teks: 'Nilai impor naik.\n\nParagraf kedua.', sumber: 'Gemini' } } });
  assert.ok(berisi.includes('Regenerasi'), 'narasi tersimpan -> tombol regenerasi');
  assert.ok(berisi.includes('Nilai impor naik.'), 'teks narasi tampil');
  assert.ok(berisi.includes('AI Narrative — Gemini'), 'sumber narasi tampil');
});