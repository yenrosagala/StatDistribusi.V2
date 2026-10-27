function summaryPanel(module) {
  const label = module === 'pariwisata' ? 'Pariwisata' : 'Transportasi';
  return `<section class="dashboard-card summary-panel" data-module="${module}">
    <h2>📝 Ringkasan Justifikasi — ${label}</h2>
    <p class="muted">Merangkum justifikasi analis dari <b>seluruh provinsi</b> pada satu bulan,
      lalu dapat diunduh sebagai PDF.</p>
    <form class="admin-form" onsubmit="return false">
      <div class="admin-grid">
        <label>Periode
          <select class="summary-period"><option value="">Memuat…</option></select>
        </label>
      </div>
    </form>
    <p class="summary-coverage muted"></p>
    <div class="toolbar">
      <button type="button" class="btn btn-primary summary-generate">Buat Ringkasan (AI)</button>
      <a class="btn btn-secondary summary-pdf" href="#" aria-disabled="true">Unduh PDF</a>
    </div>
    <div class="summary-body narrative"></div>
    <p class="summary-status muted" role="status" aria-live="polite"></p>
  </section>`;
}
export { summaryPanel };
