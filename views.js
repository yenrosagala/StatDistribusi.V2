import { INV_MONTH_MAP, MONTH_NAMES, escapeHtml, formatIdNumber, monthNameEn, periodLabel } from './lib.js';
import { icon } from './icons.js';

import { italicizeEnglish } from './lib-transport.js';
import { pariwisataAdminView } from './pariwisata-admin-view.js';

const CHARTS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

// Plugin kecil: menulis nilai hanya pada titik bulan terpilih — tahun berjalan
// dan bulan yang sama tahun lalu. Digambar sendiri (bukan lewat
// chartjs-plugin-datalabels) supaya posisinya pasti di titik data.
function monthLabelPlugin(monthIndex, unit, format) {
  return {
    id: 'monthLabels',
    afterDatasetsDraw(chart) {
      if (monthIndex === null || monthIndex === undefined) return;
      const ctx = chart.ctx;
      const area = chart.chartArea;
      const size = 11;
      ctx.save();
      ctx.font = `600 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      chart.data.datasets.forEach((dataset, di) => {
        const value = dataset.data[monthIndex];
        if (value === null || value === undefined || Number.isNaN(value)) return;
        const point = chart.getDatasetMeta(di).data[monthIndex];
        if (!point || point.skip) return;
        const text = format(value) + unit;
        // Tahun lalu 26px di atas titik, tahun berjalan 10px, supaya dua label
        // tidak bertumpuk ketika nilainya nyaris sama.
        let baseline = 'bottom';
        let y = point.y - (di === 0 ? 26 : 10);
        if (y - size < area.top) {
          baseline = 'top';
          y = point.y + (di === 0 ? 26 : 10);
        }
        ctx.textBaseline = baseline;
        ctx.fillStyle = dataset.borderColor;
        ctx.fillText(text, point.x, y);
      });
      ctx.restore();
    },
  };
}

function chartScript(charts) {
  const json = JSON.stringify(charts).replace(/</g, '\\u003c');
  return `<script src="${CHARTS_CDN}"></script>
<script>
(function () {
  if (typeof Chart === 'undefined') return;
  var CFG = ${json};
  var nf = new Intl.NumberFormat('id-ID');
  CFG.forEach(function (c) {
    var el = document.getElementById(c.id);
    if (!el) return;
    var line = c.type === 'line';
    new Chart(el, {
      type: c.type || 'bar',
      data: {
        labels: c.labels,
        datasets: c.datasets.map(function (d) {
          return line
            ? { label: d.label, data: d.data, borderColor: d.color, backgroundColor: d.color, tension: 0.25, pointRadius: 3 }
            : { label: d.label, data: d.data, backgroundColor: d.color, borderRadius: 4 };
        })
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: !line, grid: { display: false } },
          y: { stacked: !line, beginAtZero: true, ticks: { callback: function (v) { return nf.format(v); } } }
        },
        plugins: {
          legend: { position: 'bottom' },
          title: { display: true, text: c.title, font: { size: 13, weight: '600' } },
          tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ': ' + nf.format(ctx.parsed.y); } } }
        }
      }
    });
  });
})();
</script>`;
}

// Document export needs the Python bridge. server.js probes it at boot and
// flips this flag so the UI can warn instead of failing on click.
let exportAvailable = true;
export function setExportAvailability(ok) { exportAvailable = ok === true; }

function moduleCrumbs(moduleLabel, baseHref, tab) {
  const trail = [{ label: 'Beranda', href: '/' }];
  if (tab === 'admin') trail.push({ label: moduleLabel, href: baseHref }, { label: 'Admin' });
  else trail.push({ label: moduleLabel });
  return trail;
}

/** Breadcrumb trail: the app is now 3 levels deep (Beranda > module > view). */
function crumbsHtml(crumbs) {
  if (!crumbs || !crumbs.length) return '';
  const items = crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    const inner = last
      ? `<span aria-current="page">${escapeHtml(c.label)}</span>`
      : `<a href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>`;
    return `<li>${inner}</li>`;
  }).join('');
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

function layout({ title, body, user, section, scripts = '', crumbs = null }) {
  const adminHref = `${section === 'transportasi' ? '/transportasi' : '/pariwisata'}?tab=admin`;
  const nav = [
    `<a class="side-link${section === 'home' ? ' active' : ''}" href="/">${icon('home')} Beranda</a>`,
    user.role === 'admin'
      ? `<a class="side-link${section === 'admin' ? ' active' : ''}" href="${adminHref}">${icon('lock')} Admin</a>`
      : '',
  ].join('');

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Dashboard Papua</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Fira+Sans:wght@300;400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="app-shell">
  <aside class="app-side">
    <a class="brand-block" href="/">
      <img class="brand-logo" src="/logo.png" alt="Logo">
      <div>
        <p class="sidebar-title">Pariwisata &amp; Transportasi Papua</p>
        <p class="sidebar-subtitle">Dashboard Statistik</p>
      </div>
    </a>
    <nav class="side-nav">${nav}</nav>
    <div class="side-foot">
      <div class="user-card"><b>USER:</b> ${escapeHtml(user.name)}<br><b>ROLE:</b> ${user.role.toUpperCase()}</div>
      <form method="post" action="/logout"><button class="btn btn-ghost" type="submit">Logout</button></form>
      <p class="side-note">Mode baca-saja. Unggah data, regenerasi narasi AI, dan ekspor hanya tersedia di aplikasi Streamlit.</p>
    </div>
  </aside>
  <main class="app-main">
${crumbsHtml(crumbs)}
${exportAvailable ? '' : `<div class="alert alert-warn export-alert">
  <b>Ekspor dokumen nonaktif.</b> Python bridge tidak dapat dijalankan di lingkungan ini (EPERM).
  Jalankan ulang <code>node server.js</code> dari terminal Anda agar tombol unduh PPTX/DOCX/IDML/XLSX berfungsi.
</div>`}
${body}
    <div class="app-footer">Pariwisata &amp; Transportasi Papua · BPS Provinsi Papua</div>
  </main>
</div>
${scripts}
</body>
</html>`;
}

export function landingPage({ user, pari = {}, trans = {} }) {
  const periodText = (p) => (p && p.thn ? `${p.bln} ${p.thn}` : 'Belum ada data');

  const card = (o) => `<a class="landing-card" href="${o.href}">
    <span class="landing-icon" aria-hidden="true">${o.icon}</span>
    <span class="landing-title">${escapeHtml(o.title)}</span>
    <span class="landing-desc">${escapeHtml(o.desc)}</span>
    <span class="landing-stats">
      ${o.stats.map(([k, v]) => `<span class="landing-stat"><b>${escapeHtml(v)}</b><i>${escapeHtml(k)}</i></span>`).join('')}
    </span>
    <span class="landing-cta">Buka ${escapeHtml(o.title)} &rarr;</span>
  </a>`;

  const body = `<div class="landing-hero">
  <h1 class="landing-h1">Pariwisata &amp; Transportasi Papua</h1>
  <p class="landing-sub">Dashboard statistik BPS Provinsi Papua. Pilih modul untuk mulai menjelajah.</p>
</div>
<div class="landing-grid">
  ${card({
    href: '/pariwisata', icon: icon('building'), title: 'Pariwisata',
    desc: 'Tingkat penghunian kamar (TPK) dan rata-rata lama menginap (RLMTGAB) hotel bintang dan non bintang.',
    stats: [
      ['Periode', String(pari.periods ?? 0)],
      ['Provinsi', String(pari.provinces ?? 0)],
      ['Terakhir', periodText(pari.last)],
    ],
  })}
  ${card({
    href: '/transportasi', icon: icon('plane'), title: 'Transportasi',
    desc: 'Arus penumpang dan barang pada angkutan laut dan udara di empat provinsi Tanah Papua.',
    stats: [
      ['Periode', String(trans.periods ?? 0)],
      ['Moda', 'Laut & Udara'],
      ['Terakhir', periodText(trans.last)],
    ],
  })}
</div>
<p class="landing-greet">Masuk sebagai <b>${escapeHtml(user.name)}</b> &middot; peran ${escapeHtml(user.role.toUpperCase())}</p>`;

  return layout({ title: 'Beranda', body, user, section: 'home' });
}

export function loginPage({ error = '' } = {}) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login · Dashboard Papua</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Fira+Sans:wght@300;400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <div class="brand-block">
      <img class="brand-logo" src="/logo.png" alt="Logo">
      <div>
        <p class="sidebar-title">Pariwisata &amp; Transportasi Papua</p>
        <p class="sidebar-subtitle">Dashboard Statistik</p>
      </div>
    </div>
    <h1 class="hero-title">Selamat Datang</h1>
    <p class="login-sub">Masuk untuk mengakses dashboard statistik Pariwisata dan Transportasi Provinsi Papua.</p>
    ${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/login" class="login-form">
      <label class="field"><span>Username</span><input name="username" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary" type="submit">Masuk</button>
    </form>
    <p class="login-foot">Akses terbatas untuk analis data dan administrator portal.</p>
  </div>
</div>
</body>
</html>`;
}

function growthTable(caption, rows, labels) {
  const head = labels.map((l) => `<th>PERKEMBANGAN ${l} ${escapeHtml(caption)} (%)</th>`).join('');
  const body = rows.map((row) => `<tr><td><b>${escapeHtml(row.provinsi)}</b></td>${row.values.map((v) => (
    `<td>${v == null
      ? '<span class="stat-delta-na">&mdash;</span>'
      : `<span class="${v >= 0 ? 'pos' : 'neg'}">${formatIdNumber(v)}</span>`}</td>`
  )).join('')}</tr>`).join('');
  return `<table class="data-table"><thead><tr><th>PROVINSI</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function rawTable(rows, caption) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return `<details class="raw-block"><summary>${escapeHtml(caption)}</summary>
<div class="table-scroll"><table class="data-table"><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

function periodSelect(periods, selected) {
  const value = `${selected.thn}-${selected.bln}`;
  const options = periods.map((p) => {
    const v = `${p.thn}-${p.bln}`;
    return `<option value="${escapeHtml(v)}"${v === value ? ' selected' : ''}>${escapeHtml(periodLabel(p.thn, p.bln))}</option>`;
  }).join('');
  return `<form method="get" action="/transportasi" class="toolbar">
  <label class="field-inline"><span>Periode</span><select name="periode" onchange="this.form.submit()">${options}</select></label>
  <noscript><button class="btn btn-primary" type="submit">Tampilkan</button></noscript>
</form>`;
}

function sectionCard(section) {
  if (section.empty) {
    return `<section class="dashboard-card">
  <div class="section-header"><div><div class="section-title">PERKEMBANGAN TRANSPORTASI ${section.moda.toUpperCase()}</div></div></div>
  <div class="alert alert-warn">Belum ada data Transportasi ${escapeHtml(section.moda)} untuk periode ${escapeHtml(section.periode)}.</div>
</section>`;
  }

  const charts = section.charts.map((c) => `<div class="chart-box"><canvas id="${c.id}"></canvas></div>`).join('');
  const paras = section.narrative.paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('');

  return `<section class="dashboard-card">
  <div class="section-header">
    <div>
      <div class="section-title">PERKEMBANGAN TRANSPORTASI ${section.moda.toUpperCase()}</div>
      <div class="section-subtitle">Periode ${escapeHtml(section.periode)} &middot; perbandingan bulanan dan kumulatif</div>
    </div>
  </div>
  <div class="chart-grid">${charts}</div>
  <div class="table-grid">
    <div>${growthTable(section.periodeLabel, section.growthP, section.labelsP)}</div>
    <div>${growthTable(section.periodeLabel, section.growthB, section.labelsB)}</div>
  </div>
  <div class="narrative">
    <div class="narrative-head"><h3>Ringkasan Naratif</h3><span class="source-tag">${escapeHtml(section.narrative.source)}</span></div>
    ${paras}
  </div>
  ${rawTable(section.raw, `Data detail Transportasi ${section.moda} — ${section.periode}`)}
</section>`;
}

function brsTable(item) {
  const head = `<tr><th>${escapeHtml(item.rowLabel)}</th><th>${escapeHtml(item.columns.prev)}</th>`
    + `<th>${escapeHtml(item.columns.curr)}</th><th>M-to-M (%)</th>`
    + `<th>${escapeHtml(item.columns.cumPrev)}</th><th>${escapeHtml(item.columns.cumCurr)}</th>`
    + '<th>Y-on-Y (%)</th></tr>';
  const cell = (v, kind) => {
    if (kind === 'other') return '';
    if (v === '') return '<td></td>';
    const neg = v.startsWith('-');
    const cls = v === 'undefined' ? ' class="muted"' : neg ? ' class="num-neg"' : '';
    return `<td${cls}>${v}</td>`;
  };
  const body = item.rows.map((r) => {
    if (r.kind === 'other') {
      return `<tr class="brs-separator"><th colspan="7">${escapeHtml(r.label)}</th></tr>`;
    }
    const cls = r.kind === 'subtotal' ? ' class="brs-subtotal"' : '';
    return `<tr${cls}><th>${escapeHtml(r.label)}</th>${cell(r.prev, r.kind)}${cell(r.curr, r.kind)}`
      + `${cell(r.mtm, r.kind)}${cell(r.cumPrev, r.kind)}${cell(r.cumCurr, r.kind)}${cell(r.yoy, r.kind)}</tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="data-table brs-table">
  <thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function transportNarrativeBox(item, isAdmin) {
  const fields = `<input type="hidden" name="kind" value="transportasi"><input type="hidden" name="provinsi" value="${escapeHtml(item.prov)}"><input type="hidden" name="tahun" value="${escapeHtml(item.tahun)}"><input type="hidden" name="bulan" value="${escapeHtml(item.bulan)}"><input type="hidden" name="moda" value="${escapeHtml(item.moda)}"><input type="hidden" name="label" value="${escapeHtml(item.label)}">`;
  const regen = isAdmin
    ? `<form method="post" action="/api/narrative/regenerate" class="inline-form">${fields}<button class="btn btn-secondary" type="submit">🔄 Regenerasi</button></form>`
    : '';
  if (!item.narrative) {
    if (isAdmin) {
      return `<div class="alert alert-info">Narasi AI belum dibuat untuk tabel ini.<form method="post" action="/api/narrative/generate" class="inline-form">${fields}<button class="btn btn-primary" type="submit">🤖 Generate Narasi AI</button></form></div>`;
    }
    return `<div class="alert alert-info">${escapeHtml('Narasi AI belum tersedia untuk tabel ini. Hubungi admin untuk membuatnya.')}</div>`;
  }
  const paras = item.narrative.paras
    .map((p) => `<p>${italicizeEnglish(escapeHtml(p), true)}</p>`)
    .join('');
  return `<div class="ai-note"><strong>📝 Executive Summary — ${escapeHtml(item.label)}</strong>`
    + `<p class="muted">Executive Summary — ${escapeHtml(item.narrative.source)}</p>${paras}${regen}</div>`;
}

function transportReportTab(report, isAdmin) {
  const control = `<form method="get" action="/transportasi" class="toolbar">
  <input type="hidden" name="tab" value="report">
  <label class="field-inline"><span>Provinsi</span><select name="provinsi" onchange="this.form.submit()">
    ${report.provinces.map((p) => option(p, p, p === report.province)).join('')}
  </select></label>
  <label class="field-inline"><span>Tahun</span><select name="tahun" onchange="this.form.submit()">
    ${report.years.map((y) => option(y, String(y), y === report.year)).join('')}
  </select></label>
  <label class="field-inline"><span>Bulan</span><select name="bulan" onchange="this.form.submit()">
    ${report.months.map((m) => option(m, m, m === report.monthName)).join('')}
  </select></label>
  <noscript><button class="btn btn-primary" type="submit">Tampilkan</button></noscript>
</form>`;

  const head = `<h2 class="hero-title">📋 Laporan Komparatif Strategis</h2>${control}`;  if (report.warning) {
    return `${head}<section class="dashboard-card"><div class="alert alert-warn">${escapeHtml(report.warning)}</div></section>`;
  }
  const groups = report.groups.map((group) => {
    const cards = group.items.map((item) => `<section class="dashboard-card report-card">
  <div class="card-header"><span>${escapeHtml(item.title)}</span></div>
  ${brsTable(item)}
  ${transportNarrativeBox(item, isAdmin)}
</section>`).join('');
    return `<h3 class="section-title">${icon(group.icon)} Moda: ${escapeHtml(group.moda)}</h3>${cards}`;
  }).join('');
  const exportCard = `<section class="dashboard-card">
  <h2>📥 Unduh Laporan</h2>
  <form method="post" action="/export/transportasi/idml" enctype="multipart/form-data" class="admin-form">
    <input type="hidden" name="provinsi" value="${escapeHtml(report.province)}">
    <input type="hidden" name="tahun" value="${report.year}">
    <input type="hidden" name="bulan" value="${escapeHtml(report.monthName)}">
    <div class="admin-grid">
      <label>Infografis (PNG/JPG) <input type="file" name="infografis" accept="image/png,image/jpeg"></label>
      <label>Kode QR (PNG/JPG) <input type="file" name="qr" accept="image/png,image/jpeg"></label>
      <label>Nomor BRS <input name="nomor" placeholder="mis. 235/10/94/Th. XXIX"></label>
      <label>Tanggal Rilis <input name="tanggal" placeholder="mis. 1 Oktober 2026"></label>
    </div>
    <div class="metric-row">
      <a class="btn btn-secondary" href="/export/transportasi/xlsx?provinsi=${encodeURIComponent(report.province)}&tahun=${report.year}&bulan=${encodeURIComponent(report.monthName)}">📊 Unduh Excel (Hanya Tabel)</a>
      <button class="btn btn-primary" type="submit">🎨 Unduh Paket InDesign (.zip)</button>
    </div>
  </form>
</section>`;
  return head + groups + exportCard;
}

function seriesChart(series) {
  const palette = ['#ED7D31', '#70AD47', '#4472C4', '#A5A5A5', '#FFC000', '#5B9BD5', '#264478', '#9E480E'];
  return {
    id: 'admin-series-chart',
    type: 'line',
    title: series.title,
    labels: series.periods,
    datasets: series.series.map((s, i) => ({ label: s.name, data: s.data, color: palette[i % palette.length] })),
  };
}

function checkList(name, options, values, idPrefix) {
  return options.map((opt, i) => `<label class="check-row">
      <input type="checkbox" name="${name}" value="${escapeHtml(opt)}"${values.includes(opt) ? ' checked' : ''} id="${idPrefix}${i}">
      <span>${escapeHtml(opt.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))}</span>
    </label>`).join('');
}

function adminSeriesPanel(admin) {
  const { moda, kabupaten, entities, variabel, series, kabupatenList } = admin.seriesForm;
  const chart = series && !series.empty ? `<div class="chart-frame"><canvas id="admin-series-chart"></canvas></div>` : '';
  const table = series && !series.empty
    ? `<details class="admin-raw"><summary>📋 Lihat Tabel Data Mentah di Balik Grafik</summary>
    <table class="data-table"><thead><tr><th>Periode</th><th>Seri</th><th class="num">Nilai</th></tr></thead>
    <tbody>${series.rows.map((r) => `<tr><td>${escapeHtml(r.Periode)}</td><td>${escapeHtml(r.Seri)}</td><td class="num">${formatIdNumber(r.Nilai, 2)}</td></tr>`).join('')}</tbody></table></details>`
    : '';
  const warning = series && series.empty
    ? '<div class="alert alert-warn">⚠️ Tidak ditemukan data yang cocok dengan kombinasi filter Anda.</div>'
    : '';

  return `<section class="dashboard-card">
  <h2>📊 Filter Analisis Tren</h2>
  <form method="get" action="/transportasi" class="admin-form">
    <input type="hidden" name="tab" value="admin">
    <input type="hidden" name="sub" value="series">
    <div class="admin-grid">
      <label>Moda Transportasi
        <select name="moda">${['Transportasi Udara', 'Transportasi Laut'].map((m) => `<option value="${m}"${m === moda ? ' selected' : ''}>${m}</option>`).join('')}</select>
      </label>
      <label>Kabupaten/Kota
        <select name="kabupaten"><option value="SEMUA">SEMUA</option>${kabupatenList.map((k) => `<option value="${escapeHtml(k)}"${k === kabupaten ? ' selected' : ''}>${escapeHtml(k)}</option>`).join('')}</select>
      </label>
    </div>
    <fieldset class="check-grid"><legend>${admin.seriesForm.entityLabel} (kosongkan untuk agregat)</legend>${checkList('entity', entities.options, entities.selected, 'ent')}</fieldset>
    <fieldset class="check-grid"><legend>Indikator Variabel</legend>${checkList('variabel', variabel.options, variabel.selected, 'var')}</fieldset>
    <button type="submit" class="btn btn-primary">📈 Buat Visualisasi Grafik</button>
  </form>
  ${warning}${chart}${table}
</section>`;
}

function adminUploadPanel(admin) {
  const { stage, files, preview, message } = admin.upload;
  const flash = message ? `<div class="alert ${message.ok ? 'alert-info' : 'alert-warn'}">${escapeHtml(message.text)}</div>` : '';

  if (preview) {
    const cards = preview.map((p, i) => {
      if (p.error) {
        return `<article class="admin-file"><h4>⚠️ ${escapeHtml(p.nama_file)} (${escapeHtml(p.bulan)} ${p.tahun})</h4>
          <div class="alert alert-warn">Gagal memproses file: ${escapeHtml(p.error)}</div></article>`;
      }
      const modaLabel = p.table_type === 'transportasi_udara' ? '✈️ Transportasi Udara' : '🚢 Transportasi Laut';
      const note = p.existing_rows > 0
        ? `<div class="alert alert-warn">⚠️ Terdapat <strong>${p.existing_rows} baris data eksisting</strong> untuk periode ${escapeHtml(p.bulan)} ${p.tahun}. Data lama akan ditimpa jika opsi aktif.</div>`
        : '<div class="alert alert-info">✅ Periode ini bersih (belum ada data pada database).</div>';
      const s = p.stats;
      return `<article class="admin-file">
        <h4>${modaLabel} — ${escapeHtml(p.nama_file)} (${escapeHtml(p.bulan)} ${p.tahun})</h4>
        ${note}
        <div class="metric-row">
          <div class="metric"><span>Jumlah Baris</span><strong>${formatIdNumber(s.jumlah_baris, 0)}</strong></div>
          <div class="metric"><span>Total Penumpang</span><strong>${formatIdNumber(s.total_penumpang, 0)}</strong></div>
          <div class="metric"><span>Total Barang</span><strong>${formatIdNumber(s.total_barang, 2)} ${s.satuan_barang}</strong></div>
          <div class="metric"><span>Lokasi (${s.label_lokasi})</span><strong>${s.jumlah_lokasi}</strong></div>
        </div>
      </article>`;
    }).join('');
    const anyValid = preview.some((p) => !p.error);
    const confirm = anyValid ? `<div class="admin-confirm">
      <input type="hidden" name="stage" value="${escapeHtml(stage)}">
      <label class="check-row"><input type="checkbox" name="overwrite" value="1" checked><span>Timpa data lama jika periode sama sudah tersedia</span></label>
      <label class="check-row"><input type="checkbox" name="confirm" value="1" required><span>Saya telah memverifikasi statistik di atas dan siap menyimpannya ke database utama.</span></label>
      <button type="submit" class="btn btn-primary">✅ Proses &amp; Simpan ke Database</button>
    </div>` : '';
    return `<section class="dashboard-card">${flash}<h2>📥 Langkah 2 &amp; 3: Ringkasan, Validasi &amp; Simpan</h2>
  <form method="post" action="/transportasi/admin/save">${cards}${confirm}</form>
  <p class="muted"><a href="/transportasi?tab=admin&amp;sub=upload">↩︎ Mulai ulang unggahan</a></p></section>`;
  }

  if (stage && files.length) {
    const rows = files.map((f, i) => `<tr>
      <td><strong>📄 ${escapeHtml(f.nama_file)}</strong><br><span class="muted">${f.table_type === 'transportasi_udara' ? 'Moda: ✈️ Transportasi Udara' : f.table_type === 'transportasi_laut' ? 'Moda: 🚢 Transportasi Laut' : '<span class="num-neg">Format header tidak dikenali.</span>'}</span></td>
      <td><input type="number" name="tahun_${i}" value="${f.tahun}" min="2020" max="2035" required></td>
      <td><select name="bulan_${i}">${MONTH_NAMES.map((m) => `<option value="${m}"${m === f.bulan ? ' selected' : ''}>${m}</option>`).join('')}</select></td>
    </tr>`).join('');
    const validCount = files.filter((f) => f.table_type).length;
    return `<section class="dashboard-card">${flash}<h2>📥 Langkah 1: Verifikasi Deteksi Otomatis</h2>
  <form method="post" action="/transportasi/admin/preview">
    <input type="hidden" name="stage" value="${escapeHtml(stage)}">
    <table class="data-table admin-files"><thead><tr><th>Berkas</th><th>Tahun</th><th>Bulan</th></tr></thead><tbody>${rows}</tbody></table>
    ${validCount ? '<button type="submit" class="btn btn-primary">🔍 Analisis &amp; Pratinjau Berkas</button>' : '<div class="alert alert-warn">Tidak ada berkas dengan format yang dikenali.</div>'}
  </form></section>`;
  }

  return `<section class="dashboard-card">${flash}
  <h2>📥 Unggah Data BPS Baru</h2>
  <p class="muted">Unggah satu atau beberapa berkas Excel/HTML BPS sekaligus (.xls, .xlsx). Sistem mendeteksi metadata secara otomatis.</p>
  <form method="post" action="/transportasi/admin/upload" enctype="multipart/form-data" class="admin-form">
    <input type="file" name="files" accept=".xls,.xlsx,.html,.htm" multiple required>
    <button type="submit" class="btn btn-primary">⬆️ Unggah &amp; Deteksi</button>
  </form></section>`;
}

function adminEditPanel(admin) {
  const { table, tahun, bulan, tsv, message, months } = admin.edit;
  const flash = message ? `<div class="alert ${message.ok ? 'alert-info' : 'alert-warn'}">${escapeHtml(message.text)}</div>` : '';
  return `<section class="dashboard-card">${flash}
  <h2>🛠️ Koreksi Data Tabel Langsung</h2>
  <form method="get" action="/transportasi" class="admin-form">
    <input type="hidden" name="tab" value="admin"><input type="hidden" name="sub" value="edit">
    <div class="admin-grid">
      <label>Moda Transportasi
        <select name="moda">${['transportasi_udara', 'transportasi_laut'].map((t) => `<option value="${t}"${t === table ? ' selected' : ''}>${t === 'transportasi_udara' ? 'Transportasi Udara' : 'Transportasi Laut'}</option>`).join('')}</select>
      </label>
      <label>Tahun Periode <input type="number" name="tahun" value="${tahun}" min="2020" max="2035" required></label>
      <label>Bulan Periode
        <select name="bulan">${months.map((m) => `<option value="${m}"${m === bulan ? ' selected' : ''}>${m}</option>`).join('')}</select>
      </label>
    </div>
    <button type="submit" class="btn btn-primary">🔍 Muat Data untuk Diedit</button>
  </form>
  ${tsv == null ? '' : tsv === '' ? '<div class="alert alert-warn">Data tidak ditemukan untuk periode tersebut.</div>' : `
  <form method="post" action="/transportasi/admin/edit" class="admin-form">
    <input type="hidden" name="moda" value="${table}">
    <input type="hidden" name="tahun" value="${tahun}">
    <input type="hidden" name="bulan" value="${bulan}">
    <p class="muted">Sunting nilai pada kotak di bawah (pemisah TAB), lalu simpan. Seluruh baris periode ini diganti isi kotak.</p>
    <textarea name="tsv" rows="18" spellcheck="false">${escapeHtml(tsv)}</textarea>
    <button type="submit" class="btn btn-primary">💾 Simpan Perubahan Baris</button>
  </form>`}</section>`;
}

function adminDeletePanel(admin) {
  const { moda, province, tahun, bulan, years, provinces, months, count, message } = admin.del;
  const flash = message ? `<div class="alert ${message.ok ? 'alert-info' : 'alert-warn'}">${escapeHtml(message.text)}</div>` : '';
  return `<section class="dashboard-card">${flash}
  <h2>⚠️ Zona Pemeliharaan &amp; Penghapusan Data</h2>
  <p class="muted">Hapus data berdasarkan kriteria filter tertentu untuk membersihkan entri yang salah atau duplikat.</p>
  <form method="get" action="/transportasi" class="admin-form">
    <input type="hidden" name="tab" value="admin"><input type="hidden" name="sub" value="delete">
    <div class="admin-grid">
      <label>Moda Transportasi
        <select name="moda">${['Transportasi Udara', 'Transportasi Laut'].map((m) => `<option value="${m}"${m === moda ? ' selected' : ''}>${m}</option>`).join('')}</select>
      </label>
      <label>Provinsi
        <select name="province"><option value="SEMUA">SEMUA</option>${provinces.map((p) => `<option value="${escapeHtml(p)}"${p === province ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select>
      </label>
      <label>Tahun
        <select name="year"><option value="SEMUA">SEMUA</option>${years.map((y) => `<option value="${escapeHtml(y)}"${y === tahun ? ' selected' : ''}>${escapeHtml(y)}</option>`).join('')}</select>
      </label>
      <label>Bulan
        <select name="month"><option value="SEMUA">SEMUA</option>${months.map((m) => `<option value="${m}"${m === bulan ? ' selected' : ''}>${m}</option>`).join('')}</select>
      </label>
    </div>
    <button type="submit" class="btn btn-primary">🔍 Hitung Data yang Akan Dihapus</button>
  </form>
  ${count == null ? '' : `<form method="post" action="/transportasi/admin/delete" class="admin-form">
    <input type="hidden" name="moda" value="${escapeHtml(moda)}">
    <input type="hidden" name="province" value="${escapeHtml(province)}">
    <input type="hidden" name="year" value="${escapeHtml(tahun)}">
    <input type="hidden" name="month" value="${escapeHtml(bulan)}">
    <div class="alert ${count ? 'alert-warn' : 'alert-info'}">${count ? `Akan menghapus <strong>${formatIdNumber(count, 0)} baris</strong> dari ${escapeHtml(moda)}.` : 'Tidak ada baris yang cocok dengan filter.'}</div>
    ${count ? '<label class="check-row"><input type="checkbox" name="confirm" value="1" required><span>Saya yakin ingin menghapus data ini secara permanen.</span></label><button type="submit" class="btn btn-danger">🗑 Hapus Data Terfilter</button>' : ''}
  </form>`}</section>`;
}

/** Transportasi admin: four expandable sections instead of nested tabs. */
export function transportAdminTab(admin) {
  const focus = admin.focus || 'series';

  const sections = [
    { key: 'upload', icon: icon('upload'), label: 'Ingesti Data (Upload)', html: adminUploadPanel(admin) },
    { key: 'edit', icon: icon('edit'), label: 'Koreksi Manual', html: adminEditPanel(admin) },
    { key: 'delete', icon: icon('trash'), label: 'Pengaturan & Hapus', html: adminDeletePanel(admin) },
    { key: 'series', icon: icon('chart'), label: 'Analisis Tren', html: adminSeriesPanel(admin) },
  ];

  const folds = sections.map((s) => `
  <details class="admin-fold" id="fold-${s.key}"${s.key === focus ? ' open' : ''}>
    <summary><span class="fold-icon">${s.icon}</span>${escapeHtml(s.label)}</summary>
    <div class="admin-fold-body">${s.html}</div>
  </details>`).join('');

  const series = admin.seriesForm && admin.seriesForm.series;
  const chart = series && !series.empty ? chartScript([seriesChart(series)]) : '';

  return {
    body: `<div class="admin-shell">
  <div class="admin-hero"><h1>📈 Pusat Analisis &amp; Manajemen Data</h1>
    <p>Jelajahi tren data transportasi antar periode secara bebas. Gunakan panel di bawah untuk mengunggah, mengoreksi, atau menghapus data.</p></div>
  ${folds}
</div>`,
    scripts: chart,
  };
}

export function transportasiPage({ user, periods, selected, sections, tab = 'dashboard', report = null, admin = null }) {
  const periodQuery = selected ? `?periode=${selected.thn}-${selected.bln}` : '';
  const tabs = [
    { label: 'Dashboard', href: `/transportasi${periodQuery}`, active: tab === 'dashboard' },
    { label: 'Laporan', href: `/transportasi?tab=report${selected ? `&periode=${selected.thn}-${selected.bln}` : ''}`, active: tab === 'report' },
  ];

  const header = `<div class="section-hero">
  <div>
    <div class="section-title">Transportasi</div>
    <div class="section-subtitle">Arus penumpang dan barang empat provinsi di Tanah Papua.</div>
  </div>
  ${heroActions(tabs, 'transportasi', user)}</div>${tabNav(tabs)}`;

  let content;
  let scripts = '';
  if (tab === 'report') {
    content = report
      ? transportReportTab(report, user.role === 'admin')
      : '<section class="dashboard-card"><div class="alert alert-warn">Pilih periode laporan terlebih dahulu.</div></section>';
  } else if (tab === 'admin') {
    const adminView = transportAdminTab(admin || {});
    content = adminView.body;
    scripts = adminView.scripts;
  } else if (periods.length) {
    const deck = selected
      ? `<div class="toolbar"><a class="btn btn-primary" href="/export/transportasi/pptx?periode=${selected.thn}-${selected.bln}">📊 Unduh Deck PowerPoint</a></div>`
      : '';
    content = `${periodSelect(periods, selected)}${deck}${sections.map(sectionCard).join('')}`;
  } else {
    content = `<section class="dashboard-card"><div class="alert alert-warn">Belum ada data transportasi di database. Unggah data lewat tab Admin &amp; Analisis Series terlebih dahulu.</div></section>`;
  }

  const body = header + content;
  const charts = tab === 'dashboard' ? sections.flatMap((s) => s.charts || []) : [];
  return layout({
    title: 'Transportasi',
    body,
    user,
    section: tab === 'admin' ? 'admin' : 'transportasi',
    crumbs: moduleCrumbs('Transportasi', '/transportasi', tab),
    scripts: charts.length ? chartScript(charts) : scripts,
  });
}

export function pariwisataPage({ user, info, periods, tab = 'home', map = null, report = null, admin = null }) {
  const latest = periods.at(-1);
  const numberFmt = (v, unit = '') => (v == null || !Number.isFinite(Number(v))
    ? '&mdash;'
    : `${formatIdNumber(v, 1)}${unit}`);

  const tabs = [
    { label: 'Dashboard', href: '/pariwisata', active: tab === 'home' },
    { label: 'Peta', href: '/pariwisata?tab=map', active: tab === 'map' },
    { label: 'Laporan', href: '/pariwisata?tab=report', active: tab === 'report' },
  ];

  let body = `<div class="section-hero">
  <div>
    <div class="section-title">Pariwisata</div>
    <div class="section-subtitle">Tingkat penghunian kamar dan rata-rata lama menginap.</div>
  </div>
  ${heroActions(tabs, 'pariwisata', user)}</div>${tabNav(tabs)}`;

  if ((!info.rows.length || !latest) && tab !== 'admin') {
    body += `<section class="dashboard-card"><div class="alert alert-warn">Belum ada data pariwisata yang dimuat. Jika Anda admin, unggah matriks Excel pertama lewat tab Admin ETL Uploads.</div></section>`;
    return layout({ title: 'Pariwisata', body, user, section: 'pariwisata' });
  }

  const scripts = [];
  if (tab === 'map') {
    body += mapTab(map);
    scripts.push(mapScript());
  } else if (tab === 'report' && report) {
    const parts = reportTab(report, user.role === 'admin');
    body += parts.html;
    if (parts.configs.length) scripts.push(reportScript(parts.configs));
  } else if (tab === 'admin') {
    const adminView = pariwisataAdminView(admin || {});
    body += adminView.body;
    if (adminView.charts && adminView.charts.length) scripts.push(chartScript(adminView.charts));
  } else {
    body += `<h2 class="hero-title">Selamat datang, ${escapeHtml(user.name)}</h2>
<div class="metric-grid">
  <div class="metric-card"><span class="stat-label">Provinsi Tercakup</span><span class="metric-value">${info.provCount}</span></div>
  <div class="metric-card"><span class="stat-label">Periode Terakhir</span><span class="metric-value">${escapeHtml(periodLabel(latest.thn, latest.bln))}</span></div>
  <div class="metric-card"><span class="stat-label">Rata-rata TPK (terakhir)</span><span class="metric-value">${numberFmt(info.metrics?.tpk, '%')}</span></div>
  <div class="metric-card"><span class="stat-label">Rata-rata RLMTGAB (terakhir)</span><span class="metric-value">${numberFmt(info.metrics?.rlmtgab, ' malam')}</span></div>
</div>
<section class="dashboard-card">
  <div class="card-header"><h3>Cakupan Data</h3><span>${info.rows.length} baris</span></div>
  <p>Data mencakup <b>${escapeHtml(periodLabel(periods[0].thn, periods[0].bln))}</b> sampai
  <b>${escapeHtml(periodLabel(latest.thn, latest.bln))}</b>, meliputi ${info.provCount} provinsi
  dengan klasifikasi Hotel Bintang dan Non Bintang.</p>
</section>`;
  }

  return layout({
    title: 'Pariwisata',
    body,
    user,
    section: tab === 'admin' ? 'admin' : 'pariwisata',
    crumbs: moduleCrumbs('Pariwisata', '/pariwisata', tab),
    scripts: scripts.join(''),
  });
}

/** Right-aligned admin shortcut in the section header (admins only). */
function heroActions(tabs, moduleId, user) {
  if (user.role !== 'admin') return '';
  const onAdmin = tabs.some((t) => t.active && String(t.href).includes('tab=admin'));
  return `<div class="hero-actions">
    <a class="btn${onAdmin ? ' btn-primary' : ''}" href="/${moduleId}?tab=admin">🔐 Admin ETL</a>
  </div>`;
}

export function tabNav(tabs) {
  return `<nav class="tabs">${tabs.map((t) => (
    `<a class="tab${t.active ? ' active' : ''}" href="${escapeHtml(t.href)}">${escapeHtml(t.label)}</a>`
  )).join('')}</nav>`;
}

function provinceCard(card, unit) {
  const rows = card.rows.map((r) => {
    const value = r.value == null ? '&mdash;' : `${formatIdNumber(r.value, 2)}${unit}`;
    const delta = r.delta == null
      ? '<span class="stat-delta-na">&ndash; N/A</span>'
      : `<span class="${r.delta >= 0 ? 'badge-up' : 'badge-down'}">${r.delta >= 0 ? '▲' : '▼'} ${Math.abs(r.delta).toFixed(1)}%</span>`;
    return `<div class="stat-row"><div><span class="stat-label">${escapeHtml(r.label)}</span><span class="stat-value">${value}</span></div>${delta}</div>`;
  }).join('');
  return `<div class="province-card"><div class="province-header">${escapeHtml(card.province)}</div>${rows}</div>`;
}

function mapTab(map) {
  if (!map || map.empty) {
    return `<section class="dashboard-card"><div class="alert alert-warn">No records match this period yet. Try a different month/year, or ask an admin to ingest data for this range in Admin ETL Uploads.</div></section>`;
  }

  const option = (value, label, selected) => `<option value="${escapeHtml(String(value))}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const control = `<form method="get" action="/pariwisata" class="toolbar">
  <input type="hidden" name="tab" value="map">
  <label class="field-inline"><span>Indikator</span><select name="indikator" onchange="this.form.submit()">
    ${option('tpk', 'TPK (Occupancy Rate)', map.indicator === 'tpk')}
    ${option('rlmtgab', 'RLMTGAB (Length of Stay)', map.indicator === 'rlmtgab')}
  </select></label>
  <label class="field-inline"><span>Tahun</span><select name="tahun" onchange="this.form.submit()">
    ${map.years.map((y) => option(y, String(y), y === map.year)).join('')}
  </select></label>
  <label class="field-inline"><span>Bulan</span><select name="bulan" onchange="this.form.submit()">
    ${map.months.map((m) => option(m, monthNameEn(m), m === map.month)).join('')}
  </select></label>
  <noscript><button class="btn btn-primary" type="submit">Tampilkan</button></noscript>
</form>`;

  const left = map.cards.filter((c) => ['Papua Tengah', 'Papua Selatan'].includes(c.province));
  const right = map.cards.filter((c) => ['Papua', 'Papua Pegunungan'].includes(c.province));

  return `<h2 class="hero-title">Papua Regional Performance — ${escapeHtml(map.monthName)} ${map.year}</h2>
${control}
<div class="map-layout">
  <div>${left.map((c) => provinceCard(c, map.unit)).join('')}</div>
  <div>
    <div class="map-panel">
      <div class="map-panel-title">Papua Regional Performance — ${escapeHtml(map.monthName)} ${map.year}</div>
      <div id="papua-svg" class="map-stage" data-values="${escapeHtml(JSON.stringify(map.values))}" data-labels="${escapeHtml(JSON.stringify(map.labels))}" data-title="${escapeHtml(map.indicator)}"></div>
      <div class="map-legend">
        <span>${escapeHtml(map.indicatorLabel)} (${escapeHtml(map.unit.trim())})</span>
        <i class="map-ramp"></i>
        <span>${map.lo == null ? '&mdash;' : formatIdNumber(map.lo, 2)}</span>
        <span>${map.hi == null ? '&mdash;' : formatIdNumber(map.hi, 2)}</span>
      </div>
    </div>
    <a class="btn" href="#" onclick="event.preventDefault(); window.downloadPapuaMap && window.downloadPapuaMap(); return false;">📥 Download Map + Legend (PNG)</a>
  </div>
  <div>${right.map((c) => provinceCard(c, map.unit)).join('')}</div>
</div>`;
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(String(value))}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function narrativeBox(entry, isAdmin) {
  const fields = `<input type="hidden" name="kind" value="pariwisata"><input type="hidden" name="provinsi" value="${escapeHtml(entry.prov || entry.province)}"><input type="hidden" name="tahun" value="${entry.tahun || entry.year}"><input type="hidden" name="bulan" value="${entry.bulan || entry.month}"><input type="hidden" name="jenis_akomodasi" value="${escapeHtml(entry.jenis || entry.jenis_akomodasi)}"><input type="hidden" name="indikator" value="${escapeHtml(entry.indikator || entry.indicator)}">`;
  if (entry.narrative) {
    const paras = entry.narrative.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
    const regen = isAdmin
      ? `<form method="post" action="/api/narrative/regenerate" class="inline-form">${fields}<button class="btn btn-secondary" type="submit">🔄 Regenerasi</button></form>`
      : '';
    return `<div class="ai-note"><strong>🤖 AI Narrative (from database):</strong>${paras}<div class="narrative-actions">${regen}</div></div>`;
  }
  if (isAdmin) {
    return `<div class="alert alert-info">Narasi AI belum dibuat untuk indikator ini.<form method="post" action="/api/narrative/generate" class="inline-form">${fields}<button class="btn btn-primary" type="submit">🤖 Generate Narasi AI</button></form></div>`;
  }
  return `<div class="alert alert-info">${escapeHtml('Narasi AI belum tersedia untuk indikator ini. Hubungi admin untuk membuatnya.')}</div>`;
}

function valueGrid(series) {
  const months = series.labels.map((label, i) => ({ label, i }))
    .filter(({ i }) => series.prev[i] != null || series.cur[i] != null);
  if (!months.length) return '';
  const cell = (v) => (v == null || v === undefined || v === 'undefined' ? '' : formatIdNumber(v, 2));
  const row = (label, values) => `<tr><th>${escapeHtml(label)}</th>${months.map(({ i }) => `<td>${cell(values && values[i])}</td>`).join('')}</tr>`;
  const prevArr = Array.isArray(series.prev) ? series.prev : [];
  const curArr = Array.isArray(series.cur) ? series.cur : [];
  return `<div class="table-scroll"><table class="data-table yoy-grid">
  <thead><tr><th>Tahun</th>${months.map(({ label }) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>
  <tbody>${row(String(series.prevYear || ''), prevArr)}${row(String(series.year || ''), curArr)}</tbody>
</table></div>`;
}

function reportTab(report, isAdmin) {
  const control = `<form method="get" action="/pariwisata" class="toolbar">
  <input type="hidden" name="tab" value="report">
  <label class="field-inline"><span>Provinsi</span><select name="provinsi" onchange="this.form.submit()">
    ${report.provinces.map((p) => option(p, p, p === report.province)).join('')}
  </select></label>
  <label class="field-inline"><span>Tahun</span><select name="tahun" onchange="this.form.submit()">
    ${report.years.map((y) => option(y, String(y), y === report.year)).join('')}
  </select></label>
  <label class="field-inline"><span>Bulan</span><select name="bulan" onchange="this.form.submit()">
    ${report.months.map((m) => option(m, INV_MONTH_MAP[m], m === report.month)).join('')}
  </select></label>
  <noscript><button class="btn btn-primary" type="submit">Tampilkan</button></noscript>
</form>`;

  const head = `<h2 class="hero-title">Laporan &amp; Narasi AI</h2>${control}`;
  if (report.warning) {
    return { html: `${head}<section class="dashboard-card"><div class="alert alert-warn">${escapeHtml(report.warning)}</div></section>`, configs: [] };
  }
  if (!report.indicators.length) {
    return { html: `${head}<section class="dashboard-card"><div class="alert alert-warn">No data found matching parameters for Province: ${escapeHtml(report.province)}.</div></section>`, configs: [] };
  }

  // Chart series colours, reused by the table header swatches so the year
  // legend sits beside each year instead of in a separate legend box.
  const CUR_COLOR = '#ED7D31';
  const PREV_COLOR = '#70AD47';
  const swatch = (color, label) => `<span class="legend-swatch" style="background:${color}" aria-hidden="true"></span>${label}`;

  const configs = [];
  const cards = report.indicators.map((ind) => ind.jenis.map((entry) => {
    const fmt = (v) => (v === undefined || v === null || v === 'undefined') ? '-' : v;
    const table = `<div class="table-scroll"><table class="data-table">
  <thead><tr><th>Kelas Akomodasi</th><th>${swatch(PREV_COLOR, escapeHtml(entry.table.columns.last))}</th><th>${swatch(CUR_COLOR, escapeHtml(entry.table.columns.prev))}</th><th>${swatch(CUR_COLOR, escapeHtml(entry.table.columns.cur))}</th><th>${escapeHtml(entry.table.columns.dPrev)}</th><th>${escapeHtml(entry.table.columns.dLast)}</th></tr></thead>
  <tbody>${entry.table.body.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${fmt(r.last)}</td><td>${fmt(r.prev)}</td><td>${fmt(r.current)}</td><td>${fmt(r.dPrev)}</td><td>${fmt(r.dLast)}</td></tr>`).join('')}</tbody>
  <tfoot><tr><th>Total</th><td>${fmt(entry.table.total.last)}</td><td>${fmt(entry.table.total.prev)}</td><td>${fmt(entry.table.total.current)}</td><td>${fmt(entry.table.total.dPrev)}</td><td>${fmt(entry.table.total.dLast)}</td></tr></tfoot>
</table></div>`;
    const canvasId = `yoy-${ind.key}-${entry.jenis.replace(/\s+/g, '-')}`;
    configs.push({
      id: canvasId,
      series: entry.series || { labels: [], prev: [], cur: [], prevYear: '', year: '' },
      unit: ind.unit || '',
      axis: `${ind.short || ''} (${(ind.unit || '').trim()})`,
      curColor: CUR_COLOR,
      prevColor: PREV_COLOR,
      monthIndex: Number(report.month) - 1,
    });
    return `<section class="dashboard-card report-card">
  <div class="card-header"><h3>Indicator: ${escapeHtml(ind.key.toUpperCase())} — ${escapeHtml(entry.jenis)}</h3></div>
  ${narrativeBox({ ...entry, prov: report.province, tahun: report.year, bulan: report.month, indikator: ind.key }, isAdmin)}
  ${table}
  <div class="chart-frame" style="height:340px"><canvas id="${canvasId}"></canvas></div>
  ${valueGrid(entry.series)}
</section>`;
  }).join('')).join('');

  return { html: `${head}${cards}${pariwisataExportCard(report)}`, configs };
}

function pariwisataExportCard(report) {
  const bulan = INV_MONTH_MAP[report.month] || MONTH_NAMES[0];
  return `<section class="dashboard-card">
  <h2>📥 Unduh BRS Pariwisata</h2>
  <form method="post" action="/export/pariwisata/idml" class="admin-form" enctype="multipart/form-data" onsubmit="return false;" data-export-pariwisata="1" id="pariwisata-idml-form">
    <input type="hidden" name="provinsi" value="${escapeHtml(report.province)}">
    <input type="hidden" name="tahun" value="${report.year}">
    <input type="hidden" name="bulan" value="${escapeHtml(bulan)}">
    <div class="admin-grid">
      <label>Infografis (PNG/JPG) <input type="file" name="infografis" accept="image/png,image/jpeg"></label>
      <label>Kode QR (PNG/JPG) <input type="file" name="qr" accept="image/png,image/jpeg"></label>
      <label>Nomor BRS <input name="nomor" placeholder="mis. 235/10/94/Th. XXIX"></label>
      <label>Tanggal Rilis <input name="tanggal" placeholder="mis. 1 Oktober 2026"></label>
    </div>
    <div class="metric-row">
      <a class="btn btn-secondary" href="/export/pariwisata/xlsx?provinsi=${encodeURIComponent(report.province)}&tahun=${report.year}&bulan=${encodeURIComponent(bulan)}">📊 Unduh Excel (Hanya Tabel)</a>
      <button class="btn btn-primary" id="pariwisata-idml-submit" type="button" onclick="event.preventDefault(); document.getElementById('pariwisata-idml-form').submit(); return false;">🎨 Unduh Paket InDesign (.zip)</button>
    </div>
  </form>
</section>`;
}

function reportScript(configs) {
  const json = JSON.stringify(configs).replace(/</g, '\\u003c');
  return `<script src="${CHARTS_CDN}"></script>
<script>
(function () {
  if (typeof Chart === 'undefined') return;
  var monthLabelPlugin = ${monthLabelPlugin.toString()};
  var CFG = ${json};
  var nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
  CFG.forEach(function (c) {
    var el = document.getElementById(c.id);
    if (!el) return;
    new Chart(el, {
      type: 'line',
      data: {
        labels: c.series.labels,
        datasets: [
          { label: String(c.series.prevYear), data: c.series.prev, borderColor: c.prevColor, backgroundColor: c.prevColor, pointRadius: 4, borderWidth: 4, tension: 0.2 },
          { label: String(c.series.year), data: c.series.cur, borderColor: c.curColor, backgroundColor: c.curColor, pointRadius: 4, borderWidth: 4, tension: 0.2 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 18 } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: false, title: { display: true, text: c.axis }, ticks: { callback: function (v) { return nf.format(v); } } }
        },
        plugins: {
          legend: { display: false }, // year legend now lives in the table header
          tooltip: { callbacks: { label: function (ctx) { return 'Tahun ' + ctx.dataset.label + ': ' + nf.format(ctx.parsed.y) + c.unit; } } }
        }
      },
      plugins: [monthLabelPlugin(c.monthIndex, c.unit, function (v) { return nf.format(v); })]
    });
  });
})();
</script>`;
}

function mapScript() {  return `<script>
(async function () {
  var host = document.getElementById('papua-svg');
  if (!host) return;
  var values = JSON.parse(host.dataset.values || '{}');
  var labels = JSON.parse(host.dataset.labels || '{}');
  var res = await fetch('/papua_provinces.json');
  if (!res.ok) { host.textContent = 'Map geometry file (papua_provinces.json) could not be loaded.'; return; }
  var fc = await res.json();
  var pts = [];
  (function walk(node) {
    if (typeof node[0] === 'number') { pts.push(node); return; }
    for (var i = 0; i < node.length; i++) walk(node[i]);
  })(fc.features.map(function (f) { return f.geometry.coordinates; }));
  var lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  pts.forEach(function (p) {
    if (p[0] < lonMin) lonMin = p[0];
    if (p[0] > lonMax) lonMax = p[0];
    if (p[1] < latMin) latMin = p[1];
    if (p[1] > latMax) latMax = p[1];
  });
  var W = 780, k = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  var scale = W / ((lonMax - lonMin) * k);
  var H = Math.round((latMax - latMin) * scale);
  function xy(p) { return [((p[0] - lonMin) * k * scale).toFixed(1), ((latMax - p[1]) * scale).toFixed(1)]; }
  function ringPath(ring) {
    var d = '';
    for (var i = 0; i < ring.length; i++) {
      var q = xy(ring[i]);
      d += (i ? 'L' : 'M') + q[0] + ' ' + q[1];
    }
    return d + 'Z';
  }
  var nums = Object.keys(values).map(function (p) { return values[p]; }).filter(function (v) { return typeof v === 'number'; });
  var lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
  var stops = [[58, 42, 14], [245, 158, 11], [253, 230, 138]];
  function fill(v) {
    if (typeof v !== 'number' || hi === lo) return '#9CA3AF';
    var t = (v - lo) / (hi - lo), a = t < 0.5 ? 0 : 1, local = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    var c = [0, 1, 2].map(function (i) {
      return Math.round(stops[a][i] + (stops[a + 1][i] - stops[a][i]) * local);
    });
    return 'rgb(' + c.join(',') + ')';
  }
  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Peta statistik ' + host.dataset.title);
  var bgRect = document.createElementNS(ns, 'rect');
  bgRect.setAttribute('x', '0');
  bgRect.setAttribute('y', '0');
  bgRect.setAttribute('width', String(W));
  bgRect.setAttribute('height', String(H));
  bgRect.setAttribute('fill', '#E5E7EB');
  svg.appendChild(bgRect);
  fc.features.forEach(function (f) {
    var name = f.properties.PROVINSI, g = f.geometry;
    var polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    var d = polys.map(function (poly) { return ringPath(poly[0]); }).join(' ');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill(values[name]));
    path.setAttribute('stroke', '#0B0F14');
    path.setAttribute('stroke-width', '1');
    var t = document.createElementNS(ns, 'title');
    t.textContent = name + ': ' + (labels[name] || 'tidak ada data');
    path.appendChild(t);
    svg.appendChild(path);
  });
  fc.features.forEach(function (f) {
    var name = f.properties.PROVINSI;
    if (!labels[name]) return;
    var g = f.geometry;
    var ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
    var sx = 0, sy = 0;
    ring.forEach(function (p) { var q = xy(p); sx += +q[0]; sy += +q[1]; });
    var tx = document.createElementNS(ns, 'text');
    tx.setAttribute('x', (sx / ring.length).toFixed(1));
    tx.setAttribute('y', (sy / ring.length).toFixed(1));
    tx.setAttribute('text-anchor', 'middle');
    tx.setAttribute('class', 'map-label');
    tx.setAttribute('font-size', '16');
    tx.setAttribute('font-weight', '700');
    tx.setAttribute('font-family', 'Inter, sans-serif');
    tx.setAttribute('fill', '#0F172A');
    tx.setAttribute('paint-order', 'stroke');
    tx.setAttribute('stroke', '#FFFFFF');
    tx.setAttribute('stroke-width', '3');
    tx.setAttribute('stroke-linejoin', 'round');
    tx.textContent = name;
    svg.appendChild(tx);
  });
  host.appendChild(svg);
  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  var FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';

  function drawPanelCard(c, x, y, w, h) {
    c.fillStyle = '#FFFFFF';
    roundRectPath(c, x + 0.5, y + 0.5, w - 1, h - 1, 14);
    c.fill();
    c.strokeStyle = '#E2E8F0';
    c.lineWidth = 1;
    c.stroke();
  }

  // Read the on-screen province legend cards so the export matches the page.
  function readProvinceCards(container) {
    if (!container || !container.querySelectorAll) return [];
    var list = container.querySelectorAll('.province-card');
    return Array.prototype.map.call(list, function (card) {
      var head = card.querySelector('.province-header');
      var rows = card.querySelectorAll('.stat-row');
      var out = Array.prototype.map.call(rows, function (row) {
        var lab = row.querySelector('.stat-label');
        var val = row.querySelector('.stat-value');
        var badge = row.querySelector('.badge-up') || row.querySelector('.badge-down') || row.querySelector('.stat-delta-na');
        var cls = badge && badge.className ? String(badge.className) : '';
        return {
          label: lab ? lab.textContent.trim() : '',
          value: val ? val.textContent.trim() : '',
          delta: badge ? badge.textContent.trim() : '',
          tone: cls.indexOf('badge-up') >= 0 ? 'up' : (cls.indexOf('badge-down') >= 0 ? 'down' : 'na')
        };
      });
      return { name: head ? head.textContent.trim() : '', rows: out };
    });
  }

  var PROV_HEAD_H = 46, PROV_ROW_H = 44, PROV_PAD = 16, PROV_TAIL = 12;
  function provinceCardHeight(card) {
    return PROV_HEAD_H + card.rows.length * PROV_ROW_H + PROV_TAIL;
  }

  function drawProvinceCard(c, card, x, y, w) {
    var h = provinceCardHeight(card);
    drawPanelCard(c, x, y, w, h);
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#0F172A';
    c.font = '700 15px ' + FONT;
    c.fillText(card.name, x + PROV_PAD, y + 29);
    var ry = y + PROV_HEAD_H;
    for (var i = 0; i < card.rows.length; i++) {
      var r = card.rows[i];
      c.fillStyle = '#64748B';
      c.font = '500 12px ' + FONT;
      c.fillText(r.label, x + PROV_PAD, ry + 13);
      c.fillStyle = '#0F172A';
      c.font = '600 14px ' + FONT;
      c.fillText(r.value, x + PROV_PAD, ry + 32);
      if (r.delta) {
        c.textAlign = 'right';
        c.font = '600 12px ' + FONT;
        c.fillStyle = r.tone === 'up' ? '#047857' : (r.tone === 'down' ? '#B91C1C' : '#94A3B8');
        c.fillText(r.delta, x + w - PROV_PAD, ry + 26);
        c.textAlign = 'left';
      }
      if (i < card.rows.length - 1) {
        c.strokeStyle = '#F1F5F9';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x + PROV_PAD, ry + PROV_ROW_H - 6);
        c.lineTo(x + w - PROV_PAD, ry + PROV_ROW_H - 6);
        c.stroke();
      }
      ry += PROV_ROW_H;
    }
    return h;
  }

  window.downloadPapuaMap = function () {
    var svgEl = host.querySelector('svg');
    if (!svgEl) return;

    var panel = host.closest ? host.closest('.map-panel') : null;
    var layout = host.closest ? host.closest('.map-layout') : null;
    var titleEl = panel ? panel.querySelector('.map-panel-title') : null;
    var legendEl = panel ? panel.querySelector('.map-legend') : null;
    var title = titleEl ? titleEl.textContent.trim() : 'Peta Statistik Papua';
    var legend = legendEl
      ? Array.prototype.map.call(legendEl.querySelectorAll('span'), function (s) { return s.textContent.trim(); })
      : [];

    var leftCards = [];
    var rightCards = [];
    if (layout && layout.children && layout.children.length >= 3) {
      leftCards = readProvinceCards(layout.children[0]);
      rightCards = readProvinceCards(layout.children[2]);
    }

    var mapW = (svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.width) || W;
    var mapH = (svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.height) || H;

    var PAD = 26, GAP = 18, COL_W = 290, FOOT = 28;
    var PANEL_PAD = 28, TITLE_BLOCK = 62, LEGEND_BLOCK = 58;
    var panelW = mapW + PANEL_PAD * 2;
    var panelH = PANEL_PAD + TITLE_BLOCK + mapH + LEGEND_BLOCK;

    function colHeight(cards) {
      var h = 0;
      for (var i = 0; i < cards.length; i++) {
        h += provinceCardHeight(cards[i]);
        if (i < cards.length - 1) h += GAP;
      }
      return h;
    }

    var bodyH = Math.max(panelH, colHeight(leftCards), colHeight(rightCards));
    var cardW = Math.round(PAD * 2 + (leftCards.length ? COL_W + GAP : 0) + panelW + (rightCards.length ? GAP + COL_W : 0));
    var cardH = Math.round(PAD * 2 + bodyH + FOOT);

    var dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(cardW * dpr);
    canvas.height = Math.round(cardH * dpr);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(0, 0, cardW, cardH);

    var x = PAD;
    var i;
    if (leftCards.length) {
      var ly = PAD;
      for (i = 0; i < leftCards.length; i++) ly += drawProvinceCard(ctx, leftCards[i], x, ly, COL_W) + GAP;
      x += COL_W + GAP;
    }

    var panelX = x;
    x += panelW + GAP;
    var rightX = x;
    if (rightCards.length) {
      var ry2 = PAD;
      for (i = 0; i < rightCards.length; i++) ry2 += drawProvinceCard(ctx, rightCards[i], rightX, ry2, COL_W) + GAP;
    }

    drawPanelCard(ctx, panelX, PAD, panelW, panelH);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#0F172A';
    ctx.font = '600 19px ' + FONT;
    ctx.fillText(title, panelX + PANEL_PAD, PAD + 34);
    if (legend[0]) {
      ctx.fillStyle = '#64748B';
      ctx.font = '500 13px ' + FONT;
      ctx.fillText(legend[0], panelX + PANEL_PAD, PAD + 56);
    }

    var serializer = new XMLSerializer();
    var svgStr = serializer.serializeToString(svgEl);
    if (svgStr.indexOf('xmlns=') === -1) svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    var url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
    var img = new Image();

    img.onload = function () {
      var mapX = panelX + PANEL_PAD;
      var mapY = PAD + TITLE_BLOCK;
      ctx.drawImage(img, mapX, mapY, mapW, mapH);

      var rampX = mapX;
      var rampY = mapY + mapH + 14;
      var rampW = 240;
      var rampH = 10;
      var grad = ctx.createLinearGradient(rampX, 0, rampX + rampW, 0);
      grad.addColorStop(0, 'rgb(58,42,14)');
      grad.addColorStop(0.5, 'rgb(245,158,11)');
      grad.addColorStop(1, 'rgb(253,230,138)');
      ctx.fillStyle = grad;
      roundRectPath(ctx, rampX, rampY, rampW, rampH, 5);
      ctx.fill();

      ctx.font = '500 12px ' + FONT;
      ctx.fillStyle = '#475569';
      ctx.textAlign = 'left';
      ctx.fillText(legend[1] || '', rampX, rampY + rampH + 20);
      ctx.textAlign = 'right';
      ctx.fillText(legend[2] || '', rampX + rampW, rampY + rampH + 20);
      ctx.textAlign = 'left';

      ctx.fillStyle = '#94A3B8';
      ctx.font = '400 12px ' + FONT;
      ctx.fillText('Pariwisata & Transportasi Papua - BPS Provinsi Papua', PAD, cardH - 12);

      URL.revokeObjectURL(url);
      canvas.toBlob(function (blob) {
        if (!blob) return;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'papua_map.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, 'image/png');
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  };
})();
</script>`;
}

export function errorPage(message) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terjadi kesalahan</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Fira+Sans:wght@300;400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <h1 class="hero-title">Terjadi kesalahan</h1>
    <div class="alert alert-error">${escapeHtml(message)}</div>
    <p><a class="btn btn-ghost" href="/pariwisata">Kembali ke dashboard</a></p>
  </div>
</div>
</body>
</html>`;
}

