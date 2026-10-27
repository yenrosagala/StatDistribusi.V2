import { escapeHtml } from './lib.js';

/**
 * Admin launcher: one compact card per function in a single row. Clicking a card
 * reveals that function's panel (see adminTabsScript in views.js).
 *
 * @param {{key:string, icon:string, label:string, html:string}[]} sections
 * @param {string} focus  key of the panel to show first
 */
export function adminTabs(sections, focus) {
  const active = sections.some((s) => s.key === focus) ? focus : sections[0].key;

  const tiles = sections.map((s) => {
    const on = s.key === active;
    return `<button type="button" class="admin-tile${on ? ' active' : ''}"`
      + ` role="tab" aria-selected="${on}" aria-controls="admin-panel-${s.key}"`
      + ` id="admin-tab-${s.key}" data-panel="admin-panel-${s.key}">`
      + `<span class="admin-tile-icon">${s.icon}</span>`
      + `<span class="admin-tile-label">${escapeHtml(s.label)}</span>`
      + '</button>';
  }).join('');

  const panels = sections.map((s) => {
    const on = s.key === active;
    return `<div class="admin-panel${on ? ' active' : ''}" id="admin-panel-${s.key}"`
      + ` role="tabpanel" aria-labelledby="admin-tab-${s.key}">${s.html}</div>`;
  }).join('');

  return `<nav class="admin-tiles" role="tablist" aria-label="Fungsi admin">${tiles}</nav>`
    + `<div class="admin-panels">${panels}</div>`;
}
