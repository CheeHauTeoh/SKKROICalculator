// Price intelligence: our price vs captured competitor prices vs market reference, per SKU over time.
import { get, post, del } from '../api.js';
import { esc, bi, t, rm, rmBig, toSen, pct, num, toast, errMsg, costBadge, modal, on, dt, d } from '../ui.js';

export async function render(root) {
  const cats = await get('/api/categories');
  let f = { core: '1', category: '', only: '' };
  root.innerHTML = `<h1>${bi('intel_title')}</h1>
    <div class="filters"><select id="core"><option value="1">${t('core')} SKU</option><option value="">${t('all')} SKU</option></select>
      <select id="cat"><option value="">${t('category')}: ${t('all')}</option>${cats.map(c => `<option value="${esc(c.category)}">${esc(c.category || '(none)')}</option>`).join('')}</select>
      <select id="only"><option value="">${t('all')}</option><option value="captured">${t('only_captured')}</option><option value="flagged">${t('only_flagged')}</option></select>
      <a class="btn sm" href="/api/export/field-prices.csv">${bi('export')} ${t('field_intel')} CSV</a></div>
    <p class="small muted">${bi('market_ref')}: ${t('branded')} SKU only, ${t('never_auto')}. ${bi('field_intel')}: ${t('all')} SKU.</p>
    <div class="tblwrap"><table class="tbl" id="tbl"></table></div>`;

  const load = async () => {
    const rows = await get(`/api/intel/summary?core=${f.core}&category=${encodeURIComponent(f.category)}&only=${f.only}`);
    root.querySelector('#tbl').innerHTML = `<tr><th>SKU</th><th class="num">${bi('our_list', '<br>')}</th><th class="num">${bi('our_floor', '<br>')}</th><th>${bi('cost', '<br>')}</th><th class="num">${bi('captures', '<br>')}</th><th class="num">${bi('field_min', '<br>')}</th><th class="num">${bi('field_max', '<br>')}</th><th>${bi('market_ref', '<br>')}</th><th></th></tr>` +
      rows.map(r => `<tr data-code="${esc(r.item_code)}" style="cursor:pointer"><td><b>${esc(r.item_code)}</b><div class="small">${esc(r.description)}</div><div class="small muted">${esc(r.category)} ${r.is_branded ? `<span class="badge info">${t('branded')}</span>` : ''}</div></td>
        <td class="num">${r.list_price_sen != null ? rm(r.list_price_sen) : '—'}</td><td class="num">${r.floor_price_sen != null ? rm(r.floor_price_sen) : '—'}</td>
        <td>${costBadge(r.cost.basis)}${r.cost.basis ? `<div class="small">${pct(r.margin_pct)}</div>` : ''}</td>
        <td class="num">${r.field ? `${r.field.n}<div class="small muted">${r.field.won}W/${r.field.lost}L</div>` : '—'}</td>
        <td class="num">${r.field ? rm(r.field.min_sen) : '—'}</td><td class="num">${r.field ? rm(r.field.max_sen) : '—'}${r.field ? `<div class="small muted">${d(r.field.last_at)}</div>` : ''}</td>
        <td class="small">${r.market ? `RM ${rm(r.market.price_sen)} / ${esc(r.market.unit)}<br><a href="${esc(r.market.source_url)}" target="_blank" rel="noopener">${esc(r.market.source_name)}</a> · ${d(r.market.captured_at)}` : '—'}</td>
        <td>${r.above_all_competitors ? `<span class="badge bad">${bi('flag_above', '<br>')}</span>` : ''}${r.floor_above_all_competitors ? `<div class="small muted">${t('floor_price')} ↑</div>` : ''}</td></tr>`).join('') || `<tr><td colspan="9" class="muted">${bi('no_results')}</td></tr>`;
  };
  await load();
  for (const k of ['core', 'cat', 'only']) root.querySelector('#' + k).onchange = e => { f[k === 'cat' ? 'category' : k] = e.target.value; load(); };
  on(root.querySelector('#tbl'), 'click', 'tr[data-code]', (e, el) => { if (e.target.tagName !== 'A') detail(el.dataset.code); });

  async function detail(code) {
    const p = await get(`/api/products/${encodeURIComponent(code)}`);
    const std = p.prices[Object.keys(p.prices)[0]];
    modal(`<h2>${esc(code)}</h2><p class="small">${esc(p.description)} · ${esc(p.category)}</p>
      <div class="kpis">${Object.values(p.prices).map(pr => `<div class="kpi"><div class="v">${rm(pr.list_price_sen)} <span class="small muted">/ ${rm(pr.floor_price_sen)}</span></div><div class="l">${esc(pr.price_tier)} ${t('list_price')} / ${t('floor_price')}</div></div>`).join('') || `<div class="kpi"><div class="v">—</div><div class="l">${t('no_price')}</div></div>`}
        <div class="kpi"><div class="v">${p.cost.cost_sen != null ? rm(p.cost.cost_sen) : '—'}</div><div class="l">${costBadge(p.cost.basis)}</div></div></div>
      <h3>${bi('field_intel')}</h3>${chart(p)}
      <div class="tblwrap"><table class="tbl"><tr><th>${t('date')}</th><th>${t('who')}</th><th>${t('customer')}</th><th class="num">${t('their_price')}</th><th class="num">${t('our_price')}</th><th>${t('competitor')}</th><th>${t('outcome')}</th><th>${t('note')}</th></tr>
        ${p.field_prices.map(x => `<tr><td class="small">${dt(x.captured_at)}</td><td>${esc(x.salesperson)}</td><td class="small">${esc(x.customer_name || x.customer_code || '')}</td><td class="num">${rm(x.competitor_price_sen)}</td><td class="num">${rm(x.our_price_sen)}</td><td>${esc(x.competitor_name || '')}</td><td>${t(x.outcome)}</td><td class="small">${esc(x.note || '')}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${t('none_yet')}</td></tr>`}</table></div>
      <h3>${bi('market_ref')}</h3>
      <div class="tblwrap"><table class="tbl" id="mr"><tr><th>${t('date')}</th><th class="num">${t('value')}</th><th>${t('unit')}</th><th>${t('source')}</th><th></th></tr>
        ${p.market_refs.map(m => `<tr><td>${esc(m.captured_at)}</td><td class="num">${rm(m.price_sen)}</td><td>${esc(m.unit)}</td><td><a href="${esc(m.source_url)}" target="_blank" rel="noopener">${esc(m.source_name)}</a></td><td><button class="btn sm danger" data-del="${m.id}">✕</button></td></tr>`).join('') || `<tr><td colspan="5" class="muted">${t('none_yet')}</td></tr>`}</table></div>
      ${p.is_branded ? `<details style="margin-top:8px"><summary>${bi('add_market_ref')}</summary><label>${bi('source')}</label><input id="mr-src" type="text" placeholder="Wholesaler name"><label>${bi('url')}</label><input id="mr-url" type="url" placeholder="https://"><label>${bi('value')} (RM)</label><input id="mr-price" type="text" inputmode="decimal"><label>${bi('unit')}</label><input id="mr-unit" type="text" value="${esc(p.uom_selling || '')}"><label>${bi('date')}</label><input id="mr-date" type="date" value="${new Date().toISOString().slice(0, 10)}"><button class="btn primary" id="mr-add" style="margin-top:8px">${bi('save')}</button></details>` : `<p class="small muted">${t('market_ref')}: ${t('branded')} SKU only.</p>`}
      <p class="small muted">${bi('never_auto')}</p>
      <div class="row" style="margin-top:12px"><button class="btn grow" data-close>${bi('close')}</button></div>`, {
      onMount: (el, close) => {
        el.querySelector('#mr-add') && (el.querySelector('#mr-add').onclick = async () => {
          try { await post('/api/market-refs', { item_code: code, source_name: el.querySelector('#mr-src').value, source_url: el.querySelector('#mr-url').value, price_sen: toSen(el.querySelector('#mr-price').value), unit: el.querySelector('#mr-unit').value, captured_at: el.querySelector('#mr-date').value }); toast(t('saved')); close(); detail(code); load(); }
          catch (ex) { toast(errMsg(ex), 'err'); }
        });
        on(el, 'click', '[data-del]', async (e, b) => { if (!confirm(t('confirm'))) return; try { await del(`/api/market-refs/${b.dataset.del}`); close(); detail(code); load(); } catch (ex) { toast(errMsg(ex), 'err'); } });
      },
    });
  }
}

/** Inline SVG: competitor captures (dots) over time with our current list/floor as lines. */
function chart(p) {
  const pts = p.field_prices.filter(x => x.competitor_price_sen != null).map(x => ({ t: Date.parse(x.captured_at), y: x.competitor_price_sen, o: x.outcome })).sort((a, b) => a.t - b.t);
  const std = Object.values(p.prices)[0];
  const refs = p.market_refs.map(m => ({ t: Date.parse(m.captured_at), y: m.price_sen }));
  if (!pts.length && !std && !refs.length) return `<p class="muted small">${t('none_yet')}</p>`;
  const W = 640, H = 220, L = 56, R = 12, T = 12, B = 28;
  const ys = [...pts.map(x => x.y), ...refs.map(x => x.y), std?.list_price_sen, std?.floor_price_sen].filter(v => v != null);
  const ts = [...pts.map(x => x.t), ...refs.map(x => x.t)]; const now = Date.now();
  const t0 = ts.length ? Math.min(...ts) : now - 30 * 864e5, t1 = ts.length ? Math.max(Math.max(...ts), t0 + 864e5) : now;
  const y0 = Math.min(...ys) * 0.9, y1 = Math.max(...ys) * 1.1 || 1;
  const X = v => L + ((v - t0) / (t1 - t0)) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const line = (v, cls, label) => v == null ? '' : `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="${cls}" stroke-dasharray="6 4"/><text x="${W - R}" y="${Y(v) - 4}" text-anchor="end" font-size="11">${label} ${rm(v)}</text>`;
  const col = { won: 'var(--accent)', lost: 'var(--red)', quoted: 'var(--blue)' };
  return `<svg class="svgchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:220px"><g stroke="var(--ink-faint)" fill="var(--ink-soft)" font-family="system-ui" font-size="11">
    ${[0, .5, 1].map(k => { const v = y0 + (y1 - y0) * k; return `<text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" stroke="none">${rm(v)}</text>`; }).join('')}
    <line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    <text x="${L}" y="${H - 8}" stroke="none">${new Date(t0).toISOString().slice(0, 10)}</text><text x="${W - R}" y="${H - 8}" text-anchor="end" stroke="none">${new Date(t1).toISOString().slice(0, 10)}</text></g>
    <g stroke="var(--accent-ink)" fill="var(--accent-ink)" font-family="system-ui">${line(std?.list_price_sen, '', t('our_list'))}</g><g stroke="var(--amber)" fill="var(--amber)" font-family="system-ui">${line(std?.floor_price_sen, '', t('our_floor'))}</g>
    ${refs.map(r => `<rect x="${X(r.t) - 5}" y="${Y(r.y) - 5}" width="10" height="10" fill="var(--blue-soft)" stroke="var(--blue)"><title>${t('market_ref')} ${rm(r.y)}</title></rect>`).join('')}
    ${pts.map(x => `<circle cx="${X(x.t)}" cy="${Y(x.y)}" r="5" fill="${col[x.o] || col.quoted}"><title>${new Date(x.t).toISOString().slice(0, 10)} RM ${rm(x.y)} ${t(x.o)}</title></circle>`).join('')}</svg>
    <div class="small muted">● ${t('won')} <span style="color:var(--accent)">■</span> · ${t('lost')} <span style="color:var(--red)">■</span> · ${t('quoted')} <span style="color:var(--blue)">■</span> · ▢ ${t('market_ref')}</div>`;
}
