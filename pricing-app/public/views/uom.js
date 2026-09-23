// Milestone 1: UOM reconciliation. Evidence on the left, human decision on the right.
import { get, patch } from '../api.js';
import { esc, bi, t, rm, toSen, pct, num, toast, errMsg, qualityBadge, on, debounce } from '../ui.js';

export async function render(root) {
  let scope = 'core_suspect', status = 'open', q = '';
  root.innerHTML = `<h1>${bi('uom_title')}</h1>
    <div id="prog" class="card flat"></div>
    <div class="filters"><div class="seg" id="scope">${[['core_suspect', t('core') + ' · ' + t('suspect')], ['core_all', t('core') + ' · ' + t('all')], ['core_nopurchase', t('core') + ' · ' + t('no_purchase')], ['all', t('all')]].map(([k, l]) => `<button data-k="${k}" class="${k === scope ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
      <div class="seg" id="status">${[['open', t('open')], ['done', t('done')], ['', t('all')]].map(([k, l]) => `<button data-k="${k}" class="${k === status ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
      <input type="search" id="q" placeholder="${esc(t('search'))}"></div>
    <p class="small muted">${bi('implied_cost')} = ${t('purchase_side')} ${t('value')} ÷ ${t('qty')} (${t('uom_purchase')}); ${bi('verified_cost')} = ${t('implied_cost')} ÷ ${t('uom_factor').split(' ')[0]}. 推算数字只是证据，请人工核对。<span class="en"> Implied figures are evidence for a human to check, never truth.</span></p>
    <div class="tblwrap"><table class="tbl" id="tbl"></table></div>`;

  const progress = async () => {
    const p = await get('/api/uom/progress');
    const bar = (done, total) => `<div class="progress"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div>`;
    root.querySelector('#prog').innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${p.core_done} / ${p.core_total}</div><div class="l">${bi('core_skus')} · ${bi('done')}</div>${bar(p.core_done, p.core_total)}</div>
      <div class="kpi"><div class="v">${p.suspect_done} / ${p.suspect_total}</div><div class="l">${bi('core')} ${bi('suspect')} · ${bi('done')}</div>${bar(p.suspect_done, p.suspect_total)}</div>
      <div class="kpi"><div class="v">${p.by_quality.OK.done} / ${p.by_quality.OK.total}</div><div class="l">${bi('core')} ${bi('ok_quality')}</div></div>
      <div class="kpi"><div class="v">${p.by_quality.NO_PURCHASE_DATA.done} / ${p.by_quality.NO_PURCHASE_DATA.total}</div><div class="l">${bi('core')} ${bi('no_purchase')}</div></div>
      <div class="kpi"><div class="v">${p.all_done} / ${p.all_total}</div><div class="l">${bi('all')} SKU</div></div></div>`;
  };
  const load = async () => {
    const rows = await get(`/api/uom/queue?scope=${scope}&status=${status}&q=${encodeURIComponent(q)}`);
    const tbl = root.querySelector('#tbl');
    tbl.innerHTML = `<tr><th>SKU</th><th>${bi('purchase_side', '<br>')}</th><th>${bi('sales_side', '<br>')}</th><th>${bi('implied_margin', '<br>')}</th><th>${bi('uom_purchase', '<br>')}</th><th>${bi('uom_selling', '<br>')}</th><th>${t('uom_factor').split(' ')[0]}<br><span class="en">factor</span></th><th>${bi('suggested_cost', '<br>')}</th><th>${bi('verified_cost', '<br>')}</th><th>${bi('mark_no_purchase', '<br>')}</th><th></th></tr>` +
      rows.map(p => `<tr data-code="${esc(p.item_code)}" class="${p.done ? 'done' : ''}">
        <td><b>${esc(p.item_code)}</b><div class="small">${esc(p.description)}</div><div class="small muted">${esc(p.category)} ${p.is_core_80 ? `· <span class="badge ok">${t('core')}</span>` : ''} ${qualityBadge(p.cost_data_quality)}</div></td>
        <td class="small tnum">${num(p.fy_purchase_qty)} ${esc(p.uom_purchase_hint || '')}<br>RM ${rm(p.fy_purchase_value_sen)}<br><b>${p.implied_unit_cost_sen != null ? 'RM ' + rm(p.implied_unit_cost_sen) : '—'}</b> / ${t('unit')}</td>
        <td class="small tnum">${num(p.fy_sales_qty)} ${esc(p.uom_selling_hint || '')}<br>RM ${rm(p.fy_sales_value_sen)}<br><b>${p.implied_unit_price_sen != null ? 'RM ' + rm(p.implied_unit_price_sen) : '—'}</b> / ${t('unit')}</td>
        <td class="num ${p.implied_margin_pct != null && (p.implied_margin_pct < 2 || p.implied_margin_pct > 60) ? 'muted' : ''}">${pct(p.implied_margin_pct)}</td>
        <td><input class="w-sm" data-f="uom_purchase" value="${esc(p.uom_purchase || p.uom_purchase_hint || '')}" placeholder="CTN"></td>
        <td><input class="w-sm" data-f="uom_selling" value="${esc(p.uom_selling || p.uom_selling_hint || '')}" placeholder="PKT"></td>
        <td><input class="w-sm" data-f="uom_factor" inputmode="decimal" value="${p.uom_factor ?? ''}" placeholder="24"></td>
        <td class="num" data-sug>${p.suggested_cost_sen != null ? 'RM ' + rm(p.suggested_cost_sen) : '—'}</td>
        <td><input class="w-num" data-f="verified_unit_cost" inputmode="decimal" value="${p.verified_unit_cost_sen != null ? rm(p.verified_unit_cost_sen, { grouping: false }) : ''}" placeholder="0.00">${p.cost_updated_by ? `<div class="small muted">${esc(p.cost_updated_by)} · ${esc((p.cost_updated_at || '').slice(0, 10))}</div>` : ''}</td>
        <td style="text-align:center"><input type="checkbox" data-f="no_purchase_confirmed" ${p.no_purchase_confirmed ? 'checked' : ''}></td>
        <td><button class="btn sm primary" data-save>${bi('save', '')}</button></td></tr>`).join('') || `<tr><td colspan="11" class="muted">${bi('no_results')}</td></tr>`;
    tbl._rows = new Map(rows.map(r => [r.item_code, r]));
  };
  await progress(); await load();

  on(root.querySelector('#scope'), 'click', 'button', (e, el) => { scope = el.dataset.k; root.querySelectorAll('#scope button').forEach(b => b.classList.toggle('active', b === el)); load(); });
  on(root.querySelector('#status'), 'click', 'button', (e, el) => { status = el.dataset.k; root.querySelectorAll('#status button').forEach(b => b.classList.toggle('active', b === el)); load(); });
  root.querySelector('#q').oninput = debounce(e => { q = e.target.value; load(); }, 250);
  // live suggestion: implied cost per purchase unit / factor
  on(root.querySelector('#tbl'), 'input', 'input[data-f="uom_factor"]', (e, el) => {
    const tr = el.closest('tr'); const p = root.querySelector('#tbl')._rows.get(tr.dataset.code); const f = Number(el.value);
    const sug = p.implied_unit_cost_sen != null && f > 0 ? Math.round(p.implied_unit_cost_sen / f) : null;
    tr.querySelector('[data-sug]').textContent = sug != null ? 'RM ' + rm(sug) : '—';
    const v = tr.querySelector('input[data-f="verified_unit_cost"]'); if (sug != null && (!v.value || v.dataset.auto === '1')) { v.value = rm(sug, { grouping: false }); v.dataset.auto = '1'; }
  });
  on(root.querySelector('#tbl'), 'input', 'input[data-f="verified_unit_cost"]', (e, el) => { el.dataset.auto = '0'; });
  on(root.querySelector('#tbl'), 'click', '[data-save]', async (e, el) => {
    const tr = el.closest('tr'); const code = tr.dataset.code;
    const g = f => tr.querySelector(`[data-f="${f}"]`);
    const cost = g('verified_unit_cost').value.trim();
    const body = { uom_purchase: g('uom_purchase').value.trim(), uom_selling: g('uom_selling').value.trim(), uom_factor: g('uom_factor').value.trim() || null,
      verified_unit_cost_sen: cost === '' ? null : toSen(cost), no_purchase_confirmed: g('no_purchase_confirmed').checked };
    if (cost !== '' && body.verified_unit_cost_sen === null) { toast(`${t('error')}: ${t('verified_cost')}`, 'err'); return; }
    el.disabled = true;
    try { const r = await patch(`/api/products/${encodeURIComponent(code)}`, body); toast(`${t('saved')} ${esc(code)} (${r.changed.length})`); tr.classList.toggle('done', r.product.verified_unit_cost_sen != null || r.product.no_purchase_confirmed === 1); await progress(); }
    catch (ex) { toast(errMsg(ex), 'err'); } finally { el.disabled = false; }
  });
}
