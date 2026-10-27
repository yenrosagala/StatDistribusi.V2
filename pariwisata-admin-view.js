import { MONTH_NAMES, escapeHtml, formatIdNumber } from './lib.js';
import { icon } from './icons.js';
import { summaryPanel } from './summary-panel.js';

const TABS = [
  { key: 'upload', label: '📥 Ingesti Data (Upload)' },
  { key: 'edit', label: '🛠️ Koreksi Manual' },
  { key: 'delete', label: '⚠️ Hapus Data' },
  { key: 'series', label: '📊 Data Series Graph' },
];

const PALETTE = ['#1F4E79', '#6EE7B7', '#FCD34D', '#B45309', '#0F766E'];

function flashHtml(message) {
  if (!message) return '';
  return `<div class="alert ${message.ok ? 'alert-info' : 'alert-warn'}">${escapeHtml(message.text)}</div>`;
}

function uploadPanel(upload) {
  const { preview, files, stage, message } = upload;
  const flash = flashHtml(message);

  if (preview) {
    const cards = preview.map((p) => {
      if (p.error) {
        return `<article class="admin-file"><h4>⚠️ ${escapeHtml(p.nama_file)}</h4>
          <div class="alert alert-warn">Gagal memproses berkas: ${escapeHtml(p.error)}</div></article>`;
      }
      const s = p.stats;
      const note = p.existing_rows > 0
        ? `<div class="alert alert-warn">⚠️ Sudah ada <strong>${formatIdNumber(p.existing_rows, 0)} baris</strong> pada periode ${escapeHtml(s.periode_label || '-')}. Data lama akan ditimpa.</div>`
        : '<div class="alert alert-info">✅ Periode ini belum punya data di database.</div>';
      return `<article class="admin-file">
        <h4>📄 ${escapeHtml(p.nama_file)} — ${escapeHtml(s.periode_label || '-')}</h4>
        ${note}
        <div class="metric-row">
          <div class="metric"><span>Jumlah Baris</span><strong>${formatIdNumber(s.jumlah_baris, 0)}</strong></div>
          <div class="metric"><span>Periode</span><strong>${formatIdNumber(s.jumlah_periode, 0)}</strong></div>
          <div class="metric"><span>Provinsi</span><strong>${formatIdNumber(s.jumlah_provinsi, 0)}</strong></div>
          <div class="metric"><span>Tabel Referensi</span><strong>${s.ada_ref_avg ? 'Ada' : 'Tidak ada'}</strong></div>
        </div>
      </article>`;
    }).join('');
    const anyValid = preview.some((p) => !p.error);
    const confirm = anyValid ? `<div class="admin-confirm">
        <input type="hidden" name="stage" value="${escapeHtml(stage)}">
        <label class="check-row"><input type="checkbox" name="confirm" value="1" required><span>Saya sudah memverifikasi ringkasan di atas dan siap menyimpan ke database.</span></label>
        <button type="submit" class="btn btn-primary">✅ Simpan ke Database</button>
      </div>` : '';
    return `<section class="dashboard-card">${flash}
      <h2>📥 Langkah 2: Pratinjau &amp; Simpan</h2>
      <form method="post" action="/pariwisata/admin/save">${cards}${confirm}</form>
      <p class="muted"><a href="/pariwisata?tab=admin&amp;sub=upload">↩︎ Mulai ulang unggahan</a></p></section>`;
  }

  if (stage && files.length) {
    const rows = files.map((f, i) => {
      const tahun = f.tahun || upload.defaultYear || '';
      const bulan = f.bulan || upload.defaultMonth || MONTH_NAMES[0];
      return `<tr>
        <td><strong>📄 ${escapeHtml(f.nama_file)}</strong></td>
        <td><input type="number" name="tahun_${i}" value="${escapeHtml(String(tahun))}" min="2015" max="2100" required></td>
        <td><select name="bulan_${i}">${MONTH_NAMES.map((m) => `<option value="${m}"${m === bulan ? ' selected' : ''}>${m}</option>`).join('')}</select></td>
      </tr>`;
    }).join('');
    return `<section class="dashboard-card">${flash}
      <h2>📥 Langkah 1: Verifikasi Periode</h2>
      <p class="muted">Periode dibaca dari kolom <code>year</code>/<code>month</code> berkas bila ada; nilai di bawah dipakai bila berkas tidak membawanya.</p>
      <form method="post" action="/pariwisata/admin/preview">
        <input type="hidden" name="stage" value="${escapeHtml(stage)}">
        <table class="data-table admin-files"><thead><tr><th>Berkas</th><th>Tahun</th><th>Bulan</th></tr></thead><tbody>${rows}</tbody></table>
        <button type="submit" class="btn btn-primary">🔍 Analisis &amp; Pratinjau</button>
      </form></section>`;
  }

  return `<section class="dashboard-card">${flash}
    <h2>📥 Unggah Matriks Excel Pariwisata</h2>
    <p class="muted">Berkas <code>.xlsx</code> dengan sheet <code>Prov_Jenis_Kelas</code> (opsional <code>Prov_Jenis</code>). Satu berkas boleh memuat beberapa periode sekaligus.</p>
    <form method="post" action="/pariwisata/admin/upload" enctype="multipart/form-data" class="admin-form">
      <input type="file" name="files" accept=".xlsx" multiple required>
      <button type="submit" class="btn btn-primary">⬆️ Unggah &amp; Deteksi</button>
    </form></section>`;
}

function editPanel(edit) {
  const { tahun, bulan, tsv, message } = edit;
  const flash = flashHtml(message);
  const table = tsv == null ? ''
    : tsv === ''
      ? '<div class="alert alert-warn">Tidak ada data pada periode tersebut.</div>'
      : `<form method="post" action="/pariwisata/admin/edit" class="admin-form">
          <input type="hidden" name="tahun" value="${escapeHtml(String(tahun))}">
          <input type="hidden" name="bulan" value="${escapeHtml(bulan)}">
          <p class="muted">Sunting nilai (pemisah TAB), lalu simpan. Seluruh baris periode ini diganti isi kotak.</p>
          <textarea name="tsv" rows="20" spellcheck="false">${escapeHtml(tsv)}</textarea>
          <button type="submit" class="btn btn-primary">💾 Simpan Perubahan</button>
        </form>`;
  return `<section class="dashboard-card">${flash}
    <h2>🛠️ Koreksi Data Tabel Langsung</h2>
    <form method="get" action="/pariwisata" class="admin-form">
      <input type="hidden" name="tab" value="admin"><input type="hidden" name="sub" value="edit">
      <div class="admin-grid">
        <label>Tahun Periode <input type="number" name="tahun" value="${escapeHtml(String(tahun))}" min="2015" max="2100" required></label>
        <label>Bulan Periode
          <select name="bulan">${MONTH_NAMES.map((m) => `<option value="${m}"${m === bulan ? ' selected' : ''}>${m}</option>`).join('')}</select>
        </label>
      </div>
      <input type="hidden" name="load" value="1">
      <button type="submit" class="btn btn-primary">🔍 Muat Data untuk Diedit</button>
    </form>
    ${table}</section>`;
}

function deletePanel(del) {
  const { province, tahun, bulan, years, provinces, count, message } = del;
  const flash = flashHtml(message);
  const preview = count == null ? ''
    : count === 0
      ? '<div class="alert alert-warn">Tidak ada baris yang cocok dengan filter tersebut.</div>'
      : `<form method="post" action="/pariwisata/admin/delete" class="admin-form"
            onsubmit="return confirm('Hapus ${formatIdNumber(count, 0)} baris dari all_data?')">
          <input type="hidden" name="province" value="${escapeHtml(province)}">
          <input type="hidden" name="year" value="${escapeHtml(tahun)}">
          <input type="hidden" name="month" value="${escapeHtml(bulan)}">
          <div class="alert alert-warn">⚠️ <strong>${formatIdNumber(count, 0)} baris</strong> akan dihapus permanen.</div>
          <label class="check-row"><input type="checkbox" name="confirm" value="1" required><span>Saya yakin ingin menghapus data ini.</span></label>
          <button type="submit" class="btn btn-danger">🗑️ Hapus Data Sesuai Filter</button>
        </form>`;
  return `<section class="dashboard-card">${flash}
    <h2>⚠️ Zona Penghapusan Data</h2>
    <p class="muted">Hapus data berdasarkan filter untuk membuang entri salah atau duplikat.</p>
    <form method="get" action="/pariwisata" class="admin-form">
      <input type="hidden" name="tab" value="admin"><input type="hidden" name="sub" value="delete">
      <input type="hidden" name="count" value="1">
      <div class="admin-grid">
        <label>Provinsi
          <select name="province"><option value="SEMUA">SEMUA</option>${(provinces || []).map((p) => `<option value="${escapeHtml(p)}"${p === province ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select>
        </label>
        <label>Tahun
          <select name="year"><option value="SEMUA">SEMUA</option>${(years || []).map((y) => `<option value="${y}"${String(y) === String(tahun) ? ' selected' : ''}>${y}</option>`).join('')}</select>
        </label>
        <label>Bulan
          <select name="month"><option value="SEMUA">SEMUA</option>${MONTH_NAMES.map((m) => `<option value="${m}"${m === bulan ? ' selected' : ''}>${m}</option>`).join('')}</select>
        </label>
      </div>
      <button type="submit" class="btn btn-secondary">🔍 Hitung Baris Terdampak</button>
    </form>
    ${preview}</section>`;
}

function seriesPanel(form) {
  const series = form.series || { empty: true };
  const variabel = form.variabel || { options: [], selected: [] };
  const chart = !series.empty && series.series && series.series.length
    ? '<div class="chart-frame"><canvas id="pari-admin-series"></canvas></div>'
    : '<div class="alert alert-warn">Tidak ditemukan data yang cocok dengan filter Anda.</div>';
  const checks = (variabel.options || []).map((v, i) => `
        <label class="check-row"><input type="checkbox" name="variabel" value="${escapeHtml(v)}"${(variabel.selected || []).includes(v) ? ' checked' : ''} id="pvar${i}"><span>${escapeHtml(v.toUpperCase())}</span></label>`).join('');
  return `<section class="dashboard-card">
    <h2>📊 Data Series Graph</h2>
    <form method="get" action="/pariwisata" class="admin-form">
      <input type="hidden" name="tab" value="admin"><input type="hidden" name="sub" value="series">
      <div class="admin-grid">
        <label>Provinsi
          <select name="provinsi"><option value="SEMUA">SEMUA</option>${(form.provinces || []).map((p) => `<option value="${escapeHtml(p)}"${p === form.provinsi ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select>
        </label>
      </div>
      <fieldset class="check-grid"><legend>Indikator</legend>${checks}</fieldset>
      <button type="submit" class="btn btn-primary">📈 Buat Grafik</button>
    </form>
    ${chart}</section>`;
}

/** Render the pariwisata admin tab. Returns { body, charts } for views.js. */
/** Render the pariwisata admin page: four expandable sections, no sub-tabs. */
export function pariwisataAdminView(admin = {}) {
  const focus = admin.focus || 'upload';
  const charts = [];

  const form = admin.seriesForm || {};
  const series = form.series || { empty: true };
  if (!series.empty && series.series && series.series.length) {
    charts.push({
      id: 'pari-admin-series',
      type: 'line',
      labels: series.periods,
      title: `Data Series Pariwisata${form.provinsi && form.provinsi !== 'SEMUA' ? ' — ' + form.provinsi : ''}`,
      datasets: series.series.map((s, i) => ({
        label: s.name,
        color: PALETTE[i % PALETTE.length],
        data: s.data,
      })),
    });
  }

  const sections = [
    { key: 'upload', icon: icon('upload'), label: 'Ingesti Data (Upload)', html: uploadPanel(admin.upload || {}) },
    { key: 'edit', icon: icon('edit'), label: 'Koreksi Manual', html: editPanel(admin.edit || {}) },
    { key: 'delete', icon: icon('trash'), label: 'Hapus Data', html: deletePanel(admin.del || {}) },
    { key: 'series', icon: icon('chart'), label: 'Data Series Graph', html: seriesPanel(form) },
    { key: 'summary', icon: icon('edit'), label: 'Ringkasan Justifikasi (AI)', html: summaryPanel('pariwisata') },
  ];

  const folds = sections.map((s) => `
  <details class="admin-fold" id="fold-${s.key}"${s.key === focus ? ' open' : ''}>
    <summary><span class="fold-icon">${s.icon}</span>${escapeHtml(s.label)}</summary>
    <div class="admin-fold-body">${s.html}</div>
  </details>`).join('');

  const body = `<div class="admin-shell">
  <div class="admin-hero"><h1>🛠️ Admin ETL Pariwisata</h1>
    <p>Ingesti matriks Excel sumber, koreksi baris, bersihkan data, dan telusuri tren indikator pariwisata.</p></div>
  ${folds}
</div>`;

  return { body, charts };
}
