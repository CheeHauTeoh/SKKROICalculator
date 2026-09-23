// Product & price management: cost, target margin, tier list/floor, bulk edit by category, history.
import { get, patch, post } from '../api.js';
import { esc, bi, t, rm, toSen, pct, num, toast, errMsg, qualityBadge, costBadge, modal, on, debounce, dt } from '../ui.js';

const priceFromMargin = (cost, m) => (cost == null || m == null || m >= 100 ? null : Math.round(cost / (1 - m / 100)));

export async function render(root) {
  const [tiers, cats, settings] = await Promise.all([get('/api/tiers'), get('/api/categories'), get('/api/settings')]);
  const def = settings.default_price_tier || 'STD';
  let f = { q: '', category: '', core: '1', quality: '' };
  root.innerHTML = `<h1>${bi('products_title')}</h1>
    <div class="filters"><input type="search" id="q" placeholder="${esc(t('search'))}"><select id="cat"><option value="">${t('category')}: ${t('all')}</option>${cats.map(c => `<option value="${esc(c.category)}">${esc(c.category || '(none)')} (${c.core}/${c.products})</option>`).join('')}</select>
      <select id="core"><option value="1">${t('core')} SKU</option><option value="">${t('all')} SKU</option></select>
      <select id="quality"><option value="">${t('cost')}: ${t('all')}</option><option value="OK">${t('ok_quality')}</option><option value="UOM_SUSPECT">${t('suspect')}</option><option value="NO_PURCHASE_DATA">${t('no_purchase')}</option></select>
      <button class="btn sm" id="bulk">${bi('bulk_edit')}</button><a class="btn sm" href="/api/export/products.csv">${bi('export')} CSV</a></div>
    <div id="count" class="small muted"></div>
    <div class="tblwrap"><table class="tbl" id="tbl"></table></div>`;

  const load = async () => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v))).toString();
    const rows = await get(`/api/products?${qs}`);
    root.querySelector('#count').textContent = `${t('showing')} ${rows.length}`;
    const tbl = root.querySelector('#tbl');
    tbl.innerHTML = `<tr><th>SKU</th><th>${bi('cost', '<br>')}</th><th>${bi('target_margin', '<br>')}</th><th>${bi('suggested_list', '<br>')}</th>${tiers.map(tr => `<th>${esc(tr.name_zh)} ${esc(tr.code)}<br><span class="en">${t('list_price')} / ${t('floor_price')}</span></th>`).join('')}<th>${bi('margin_at_list', '<br>')}</th><th></th></tr>` +
      rows.map(p => {
        const cost = p.cost.cost_sen;
        return `<tr data-code="${esc(p.item_code)}"><td><b>${esc(p.item_code)}</b><div class="small">${esc(p.description)}</div><div class="small muted">${esc(p.category)} ${p.is_core_80 ? `· <span class="badge ok">${t('core')}</span>` : ''} ${p.is_branded ? `<span class="badge info">${t('branded')}</span>` : ''} ${qualityBadge(p.cost_data_quality)}</div></td>
        <td class="num">${cost != null ? `RM ${rm(cost)}` : '—'}<br>${costBadge(p.cost.basis)}</td>
        <td><input class="w-sm" data-f="target_margin_pct" inputmode="decimal" value="${p.target_margin_pct ?? ''}" placeholder="%"></td>
        <td class="num" data-sug>${priceFromMargin(cost, p.target_margin_pct) != null ? 'RM ' + rm(priceFromMargin(cost, p.target_margin_pct)) : '—'}</td>
        ${tiers.map(tr => { const cur = p.prices[tr.code]; return `<td class="nowrap"><input class="w-num" data-tier="${tr.code}" data-k="list" inputmode="decimal" value="${cur ? rm(cur.list_price_sen, { grouping: false }) : ''}" placeholder="${t('list_price')}"> <input class="w-num" data-tier="${tr.code}" data-k="floor" inputmode="decimal" value="${cur ? rm(cur.floor_price_sen, { grouping: false }) : ''}" placeholder="${t('floor_price')}">${cur ? `<div class="small muted">${esc(cur.effective_from)} · ${esc(cur.set_by)}</div>` : ''}</td>`; }).join('')}
        <td class="num">${p.cost.basis ? pct(p.margin_pct) : `<span class="badge warn">${t('cost_not_verified')}</span>`}<div class="small muted">${p.cost.basis && p.floor_margin_pct != null ? `${t('floor_price')} ${pct(p.floor_margin_pct)}` : ''}</div></td>
        <td class="nowrap"><button class="btn sm primary" data-save>${bi('save', '')}</button> <button class="btn sm" data-hist>${bi('history', '')}</button></td></tr>`;
      }).join('') || `<tr><td colspan="${6 + tiers.length}" class="muted">${bi('no_results')}</td></tr>`;
    tbl._rows = new Map(rows.map(r => [r.item_code, r]));
  };
  await load();
  root.querySelector('#q').oninput = debounce(e => { f.q = e.target.value; load(); }, 250);
  for (const k of ['cat', 'core', 'quality']) root.querySelector('#' + k).onchange = e => { f[k === 'cat' ? 'category' : k] = e.target.value; load(); };

  on(root.querySelector('#tbl'), 'input', 'input[data-f="target_margin_pct"]', (e, el) => {
    const tr = el.closest('tr'); const p = root.querySelector('#tbl')._rows.get(tr.dataset.code);
    const s = priceFromMargin(p.cost.cost_sen, el.value === '' ? null : Number(el.value)); tr.querySelector('[data-sug]').textContent = s != null ? 'RM ' + rm(s) : '—';
  });
  on(root.querySelector('#tbl'), 'click', '[data-save]', async (e, el) => {
    const tr = el.closest('tr'); const code = tr.dataset.code; const p = root.querySelector('#tbl')._rows.get(code);
    el.disabled = true;
    try {
      const m = tr.querySelector('input[data-f="target_margin_pct"]').value.trim();
      const mv = m === '' ? null : Number(m);
      if (mv !== (p.target_margin_pct ?? null)) await patch(`/api/products/${encodeURIComponent(code)}`, { target_margin_pct: mv });
      let changes = 0;
      for (const tier of tiers) {
        const l = tr.querySelector(`input[data-tier="${tier.code}"][data-k="list"]`).value.trim(), fl = tr.querySelector(`input[data-tier="${tier.code}"][data-k="floor"]`).value.trim();
        if (l === '' && fl === '') continue;
        const ls = toSen(l), fs = fl === '' ? ls : toSen(fl);
        if (ls === null || fs === null) throw new Error(`${tier.code}: ${t('list_price')} / ${t('floor_price')}`);
        const cur = p.prices[tier.code];
        if (cur && cur.list_price_sen === ls && cur.floor_price_sen === fs) continue;
        const r = await post('/api/prices', { item_code: code, price_tier: tier.code, list_price_sen: ls, floor_price_sen: fs });
        if (r.changed) changes++;
      }
      toast(`${t('saved')} ${esc(code)} · ${changes} ${t('changed')}`); await load();
    } catch (ex) { toast(errMsg(ex), 'err'); } finally { el.disabled = false; }
  });
  on(root.querySelector('#tbl'), 'click', '[data-hist]', async (e, el) => {
    const code = el.closest('tr').dataset.code;
    const [p, audit] = await Promise.all([get(`/api/products/${encodeURIComponent(code)}`), get(`/api/audit?entity=products&entity_id=${encodeURIComponent(code)}&limit=100`)]);
    modal(`<h2>${esc(code)} · ${bi('history')}</h2><p class="small">${esc(p.description)}</p>
      <h3>${bi('list_price')} / ${bi('floor_price')}</h3><div class="tblwrap"><table class="tbl"><tr><th>${t('price_tier')}</th><th class="num">${t('list_price')}</th><th class="num">${t('floor_price')}</th><th>${t('effective_from')}</th><th>→</th><th>${t('set_by')}</th><th>${t('note')}</th></tr>
      ${p.price_history.map(h => `<tr><td>${esc(h.price_tier)}</td><td class="num">${rm(h.list_price_sen)}</td><td class="num">${rm(h.floor_price_sen)}</td><td>${esc(h.effective_from)}</td><td>${esc(h.effective_to || '—')}</td><td>${esc(h.set_by)}</td><td class="small">${esc(h.note || '')}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">${t('none_yet')}</td></tr>`}</table></div>
      <h3>${bi('audit')}</h3><div class="tblwrap"><table class="tbl"><tr><th>${t('when')}</th><th>${t('who')}</th><th>${t('field')}</th><th>${t('old')}</th><th>${t('new')}</th></tr>
      ${audit.map(a => `<tr><td class="small">${dt(a.at)}</td><td>${esc(a.who)}</td><td>${esc(a.field || a.action)}</td><td class="small">${esc(a.old_value ?? '')}</td><td class="small">${esc(a.new_value ?? '')}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">${t('none_yet')}</td></tr>`}</table></div>
      <div class="row" style="margin-top:12px"><button class="btn grow" data-close>${bi('close')}</button></div>`);
  });

  root.querySelector('#bulk').onclick = () => {
    modal(`<h2>${bi('bulk_edit')}</h2>
      <label>${bi('category')}</label><select id="b-cat"><option value="">${t('all')}</option>${cats.map(c => `<option value="${esc(c.category)}" ${c.category === f.category ? 'selected' : ''}>${esc(c.category || '(none)')}</option>`).join('')}</select>
      <label><input type="checkbox" id="b-core" checked> ${bi('core')} SKU</label>
      <label>${t('what')}</label><select id="b-action"><option value="set_target_margin">${t('bulk_set_margin')}</option><option value="derive_list_from_cost">${t('bulk_derive')}</option><option value="set_floor_pct">${t('bulk_floor')}</option><option value="adjust_pct">${t('bulk_adjust')}</option><option value="copy_tier">${t('bulk_copy_tier')}</option></select>
      <label>${bi('price_tier')}</label><select id="b-tier">${tiers.map(tr => `<option value="${tr.code}" ${tr.code === def ? 'selected' : ''}>${esc(tr.name_zh)} ${tr.code}</option>`).join('')}</select>
      <label>${bi('target_margin')}</label><input type="text" id="b-margin" inputmode="decimal" placeholder="25">
      <label>${bi('floor_discount')}</label><input type="text" id="b-floor" inputmode="decimal" value="${esc(settings.default_floor_discount_pct || '5')}">
      <label>${bi('pct')} (±)</label><input type="text" id="b-pct" inputmode="decimal" placeholder="-3">
      <label><input type="checkbox" id="b-verified"> ${bi('verified_only')}</label>
      <div id="b-res" class="small muted" style="margin-top:8px"></div>
      <div class="row" style="margin-top:12px"><button class="btn grow" data-close>${bi('cancel')}</button><button class="btn primary grow" id="b-go">${bi('apply')}</button></div>`, {
      onMount: (el, close) => {
        el.querySelector('#b-go').onclick = async () => {
          const action = el.querySelector('#b-action').value; const tier = el.querySelector('#b-tier').value;
          const params = { price_tier: tier, target_margin_pct: el.querySelector('#b-margin').value, floor_discount_pct: el.querySelector('#b-floor').value, pct: el.querySelector('#b-pct').value, verified_only: el.querySelector('#b-verified').checked, to_tier: tier, from_tier: def };
          if (action === 'set_target_margin' && params.target_margin_pct === '') { toast(t('target_margin'), 'err'); return; }
          if (!confirm(t('confirm'))) return;
          try { const r = await post('/api/prices/bulk', { filter: { category: el.querySelector('#b-cat').value, core: el.querySelector('#b-core').checked }, action, params });
            el.querySelector('#b-res').textContent = `${t('matched')} ${r.matched} · ${t('changed')} ${r.changed} · ${t('skipped')} ${r.skipped} ${JSON.stringify(r.skipped_reasons)}`; await load(); }
          catch (ex) { toast(errMsg(ex), 'err'); }
        };
      },
    });
  };
}
