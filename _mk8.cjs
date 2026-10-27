// Add the summary panel as a 5th accordion in both admin views
const fs = require('fs');
let n = 0;

// --- transportasi (views.js) ---
const vf = 'D:/New Project/Distribusi-main (1)/Distribusi-main/node-app/views.js';
let v = fs.readFileSync(vf, 'utf8');
const e = v.includes('\r\n') ? '\r\n' : '\n';
const tAnchor = "    { key: 'series', icon: icon('chart'), label: 'Analisis Tren', html: adminSeriesPanel(admin) },";
if (v.includes(tAnchor) && !v.includes("key: 'summary'")) {
  v = v.replace(tAnchor, tAnchor + e
    + "    { key: 'summary', icon: icon('edit'), label: 'Ringkasan Justifikasi (AI)', html: summaryPanel('transportasi') },");
  n++;
}
fs.writeFileSync(vf, v, 'utf8');

// --- pariwisata (pariwisata-admin-view.js) ---
const pf = 'D:/New Project/Distribusi-main (1)/Distribusi-main/node-app/pariwisata-admin-view.js';
let p = fs.readFileSync(pf, 'utf8');
const pe = p.includes('\r\n') ? '\r\n' : '\n';
const pAnchor = "    { key: 'series', icon: icon('chart'), label: 'Data Series Graph', html: seriesPanel(form) },";
if (p.includes(pAnchor) && !p.includes("key: 'summary'")) {
  p = p.replace(pAnchor, pAnchor + pe
    + "    { key: 'summary', icon: icon('edit'), label: 'Ringkasan Justifikasi (AI)', html: summaryPanel('pariwisata') },");
  n++;
}
// import summaryPanel from views.js (circular-safe: it is called at render time)
if (!p.includes('summaryPanel')) {
  p = p.replace("import { icon } from './icons.js';", "import { icon } from './icons.js';" + pe + "import { summaryPanel } from './views.js';");
}
fs.writeFileSync(pf, p, 'utf8');

console.log('folds added:', n);
