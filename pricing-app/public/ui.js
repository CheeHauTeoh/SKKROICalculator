import { t, te, bi } from './i18n.js';
export { t, te, bi };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** integer sen -> "1,234.50" */
export function rm(sen, { grouping = true } = {}) {
  if (sen === null || sen === undefined) return '—';
  const neg = sen < 0, abs = Math.abs(Math.trunc(sen));
  const whole = Math.floor(abs / 100), frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${grouping ? whole.toLocaleString('en-MY') : whole}.${frac}`;
}
export const rmBig = sen => (sen === null || sen === undefined ? '—' : `RM ${Math.round(sen / 100).toLocaleString('en-MY')}`);
/** "12.34" -> 1234 sen, string-based (no float). null if invalid. */
export function toSen(str) {
  const s = String(str ?? '').trim().replace(/[,\sRM]/gi, '');
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-') return null;
  const neg = s.startsWith('-'); const [w = '0', f = ''] = s.replace('-', '').split('.');
  const frac = (f + '000').slice(0, 3);
  let sen = Number(w || 0) * 100 + Number(frac.slice(0, 2)); if (Number(frac[2]) >= 5) sen += 1;
  return neg ? -sen : sen;
}
export const pct = v => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
export const num = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-MY'));
export const dt = iso => (iso ? new Date(iso).toLocaleString('en-MY', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const d = iso => (iso ? String(iso).slice(0, 10) : '—');
export const qualityBadge = q => ({ OK: `<span class="badge ok">${bi('ok_quality')}</span>`, UOM_SUSPECT: `<span class="badge warn">${bi('suspect')}</span>`, NO_PURCHASE_DATA: `<span class="badge muted">${bi('no_purchase')}</span>` }[q] || '');
export const costBadge = basis => basis === 'verified' ? `<span class="badge ok">${bi('cost_verified')}</span>` : basis === 'implied' ? `<span class="badge info">${bi('cost_implied')}</span>` : `<span class="badge warn">${bi('cost_not_verified')}</span>`;

let toastTimer;
export function toast(msg, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = `toast ${kind} show`; el.innerHTML = msg;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
export function modal(html, { onMount } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(wrap);
  onMount?.(wrap.querySelector('.modal'), close);
  return close;
}
export const errMsg = e => e?.body?.error ? `${t('error')}: ${esc(e.body.error)}` : e?.message === 'network' ? `${t('offline')} / Offline` : `${t('error')}: ${esc(e?.message || e)}`;
export const on = (root, event, selector, fn) => root.addEventListener(event, e => { const el = e.target.closest(selector); if (el && root.contains(el)) fn(e, el); });
export const debounce = (fn, ms = 120) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
