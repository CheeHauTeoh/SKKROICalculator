// Competitor price capture: customer -> SKU -> number -> save. Offline-first, queued, synced silently.
import * as store from '../store.js';
import { esc, bi, t, rm, toSen, toast, dt, on, debounce, modal } from '../ui.js';
import { pickCustomer, getLastCustomer, setLastCustomer } from './lookup.js';

export async function render(root, { params, user }) {
  const all = await store.products();
  const customers = await store.customers();
  let cust = customers.find(c => c.customer_code === (params.customer || getLastCustomer())) || null;
  let prod = params.item ? await store.product(params.item) : null;
  let editing = params.edit ? (await store.localCaptures()).find(c => c.id === params.edit) : null;
  if (editing) { prod = await store.product(editing.item_code); cust = customers.find(c => c.customer_code === editing.customer_code) || cust; }
  let outcome = editing?.outcome || 'quoted';
  let compName = editing?.competitor_name || '';

  root.innerHTML = `<h1>${bi('capture')}</h1>
    <div class="card flat" style="padding:10px 12px;margin-bottom:8px"><div class="row"><div class="grow"><div class="small muted">1 · ${bi('customer')}</div><div id="c-line"></div></div><button class="btn sm" id="pick-c">${bi('choose_customer')}</button></div></div>
    <div class="card flat" style="padding:10px 12px;margin-bottom:8px"><div class="small muted">2 · ${bi('product')}</div><div id="p-line"></div><div id="p-search" style="display:none"><input type="search" id="pq" placeholder="${esc(t('search_product'))}" autocomplete="off" style="margin-top:6px;font-size:18px"><div id="p-results" class="list" style="margin-top:8px"></div></div></div>
    <div class="card" id="entry"><div class="small muted">3 · ${bi('their_price')}</div>
      <input type="text" inputmode="decimal" class="big" id="price" placeholder="0.00" value="${editing?.competitor_price_sen != null ? rm(editing.competitor_price_sen, { grouping: false }) : ''}" autocomplete="off">
      <div class="chips" style="margin-top:10px" id="outcomes">${['quoted', 'won', 'lost'].map(o => `<button type="button" class="chip ${o === outcome ? 'active' : ''}" data-o="${o}">${t(o)}<span class="en"> ${esc({ quoted: 'Quoted', won: 'Won', lost: 'Lost' }[o])}</span></button>`).join('')}</div>
      <details style="margin-top:10px"><summary class="small">${bi('more_options')}</summary>
        <label>${bi('competitor')} <span class="muted">(${t('optional')})</span></label><input type="text" id="comp" list="comp-list" value="${esc(compName)}" placeholder="${esc(t('unknown'))}" autocomplete="off"><datalist id="comp-list"></datalist>
        <label>${bi('our_price')} <span class="muted">(${t('optional')})</span></label><input type="text" inputmode="decimal" id="our" value="${editing?.our_price_sen != null ? rm(editing.our_price_sen, { grouping: false }) : ''}" autocomplete="off">
        <label>${bi('note')} <span class="muted">(${t('optional')})</span></label><input type="text" id="note" value="${esc(editing?.note || '')}" autocomplete="off"></details>
      <button class="btn primary block" id="save" style="margin-top:14px;font-size:18px;min-height:56px">${bi('save_capture')}</button>
      <div class="small muted" style="margin-top:6px;text-align:center">${bi('queued')}</div></div>
    <h2>${bi('my_captures')}</h2><div id="mine" class="list"></div>`;

  const cLine = () => { root.querySelector('#c-line').innerHTML = cust ? `<b>${esc(cust.customer_name)}</b> <span class="small muted">${esc(cust.customer_code)}</span>` : `<span class="muted">${bi('no_customer')}</span>`; };
  const pLine = () => {
    root.querySelector('#p-line').innerHTML = prod ? `<div class="row"><div class="grow"><b>${esc(prod.description)}</b> <span class="small muted">${esc(prod.item_code)}${prod.uom_selling ? ` · ${t('per')} ${esc(prod.uom_selling)}` : ''}</span></div><button class="btn sm" id="chg-p">${bi('change_product')}</button></div>` : `<button class="btn block" id="chg-p">${bi('pick_product')}</button>`;
    root.querySelector('#chg-p').onclick = () => { root.querySelector('#p-search').style.display = 'block'; root.querySelector('#pq').focus(); drawP(root.querySelector('#pq').value); };
    root.querySelector('#entry').style.opacity = prod ? 1 : .5;
  };
  const drawP = q => {
    const hits = store.searchProducts(all, q, 25);
    root.querySelector('#p-results').innerHTML = hits.map(p => `<div class="item" data-code="${esc(p.item_code)}"><div class="grow"><div class="title">${esc(p.description)}</div><div class="sub">${esc(p.item_code)} · ${esc(p.category)}</div></div></div>`).join('') || `<p class="muted">${bi('no_results')}</p>`;
  };
  cLine(); pLine();
  root.querySelector('#pick-c').onclick = () => pickCustomer(customers, c => { cust = c; setLastCustomer(c ? c.customer_code : ''); cLine(); });
  root.querySelector('#pq').oninput = debounce(e => drawP(e.target.value));
  on(root.querySelector('#p-results'), 'click', '.item', async (e, el) => { prod = await store.product(el.dataset.code); root.querySelector('#p-search').style.display = 'none'; pLine(); root.querySelector('#price').focus(); });
  on(root.querySelector('#outcomes'), 'click', '.chip', (e, el) => { outcome = el.dataset.o; root.querySelectorAll('#outcomes .chip').forEach(c => c.classList.toggle('active', c === el)); });
  if (!prod) root.querySelector('#chg-p').click(); else if (!editing) root.querySelector('#price').focus();

  const mine = async () => {
    const rows = (await store.localCaptures()).slice(0, 30);
    const names = new Set(rows.map(r => r.competitor_name).filter(Boolean));
    root.querySelector('#comp-list').innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
    root.querySelector('#mine').innerHTML = rows.length ? rows.map(r => `<div class="item" data-id="${r.id}"><div class="grow"><div class="title">${esc(r.item_code)} · RM ${rm(r.competitor_price_sen)} ${r.our_price_sen != null ? `<span class="muted small">(${t('our_price').split(' ')[0]} ${rm(r.our_price_sen)})</span>` : ''}</div><div class="sub">${esc(customers.find(c => c.customer_code === r.customer_code)?.customer_name || r.customer_code || '')} · ${esc(r.competitor_name || t('unknown'))} · ${t(r.outcome)} · ${dt(r.captured_at)}${r.sync_error ? ` · <span class="badge bad">${esc(r.sync_error)}</span>` : ''}</div></div><span class="badge">${bi('edit', '')}</span></div>`).join('') : `<p class="muted">${bi('none_yet')}</p>`;
  };
  await mine();
  on(root.querySelector('#mine'), 'click', '.item', (e, el) => { location.hash = `#/capture?edit=${el.dataset.id}`; });

  root.querySelector('#save').onclick = async () => {
    if (!prod) { toast(t('pick_product'), 'err'); return; }
    const comp = toSen(root.querySelector('#price').value), our = toSen(root.querySelector('#our').value);
    if (comp === null && our === null) { toast(t('enter_price'), 'err'); root.querySelector('#price').focus(); return; }
    await store.queueCapture({ id: editing?.id, captured_at: editing?.captured_at, customer_code: cust?.customer_code, item_code: prod.item_code, competitor_price_sen: comp, our_price_sen: our,
      competitor_name: root.querySelector('#comp').value.trim(), outcome, note: root.querySelector('#note').value.trim() });
    toast(`${t('captured')} ✓`);
    if (editing) { location.hash = '#/capture'; return; }
    root.querySelector('#price').value = ''; root.querySelector('#note').value = ''; outcome = 'quoted';
    root.querySelectorAll('#outcomes .chip').forEach(c => c.classList.toggle('active', c.dataset.o === 'quoted'));
    await mine(); root.querySelector('#chg-p').click();
  };
}
