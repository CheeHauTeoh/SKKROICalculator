// Salesperson price lookup. Reads only the IndexedDB cache so it works with no signal.
import * as store from '../store.js';
import { esc, bi, t, rm, toast, on, debounce } from '../ui.js';

const LAST_CUSTOMER = 'skk.lastCustomer';
export const getLastCustomer = () => { try { return localStorage.getItem(LAST_CUSTOMER) || ''; } catch { return ''; } };
export const setLastCustomer = code => { try { code ? localStorage.setItem(LAST_CUSTOMER, code) : localStorage.removeItem(LAST_CUSTOMER); } catch {} };

export async function render(root, { params, navigate }) {
  const all = await store.products();
  const customers = await store.customers();
  const tiers = await store.tiers();
  let cust = customers.find(c => c.customer_code === (params.customer || getLastCustomer())) || null;
  let q = params.q || '';
  const tierName = code => { const x = tiers.find(t => t.code === code); return x ? `${x.name_zh} · ${x.name_en}` : code; };

  root.innerHTML = `<h1>${bi('price_lookup')}</h1>
    <div class="card flat" style="padding:10px 12px;margin-bottom:10px"><div class="row"><div class="grow">
      <div class="small muted">${bi('customer')}</div><div id="cust-line" class="nowrap" style="overflow:hidden;text-overflow:ellipsis"></div></div>
      <button class="btn sm" id="pick-cust">${bi('choose_customer')}</button></div></div>
    <input type="search" id="q" placeholder="${esc(t('search_product'))} / ${esc('Search item')}" value="${esc(q)}" autocomplete="off" style="font-size:18px">
    <div id="results" class="list" style="margin-top:10px"></div>
    <div id="detail"></div>
    ${all.length ? '' : `<p class="alert warn">${bi('refresh')}: ${store.state.online ? 'sync…' : t('offline')}</p>`}`;

  const custLine = () => { root.querySelector('#cust-line').innerHTML = cust ? `<b>${esc(cust.customer_name)}</b> <span class="badge">${esc(tierName(cust.price_tier))}</span>` : `<span class="muted">${bi('no_customer')}</span>`; };
  custLine();

  const results = root.querySelector('#results');
  const draw = () => {
    const hits = store.searchProducts(all, q, 40);
    results.innerHTML = hits.length ? hits.map(p => `<div class="item" data-code="${esc(p.item_code)}"><div class="grow"><div class="title">${esc(p.description)}</div><div class="sub">${esc(p.item_code)} · ${esc(p.category)}${p.is_core_80 ? ` · <span class="badge ok">${t('core')}</span>` : ''}</div></div><div class="muted">›</div></div>`).join('')
      : `<p class="muted">${bi('no_results')}</p>`;
  };
  draw();
  root.querySelector('#q').oninput = debounce(e => { q = e.target.value; root.querySelector('#detail').innerHTML = ''; draw(); });

  on(results, 'click', '.item', async (e, el) => showPrice(el.dataset.code));
  let currentCode = null;
  async function showPrice(code) {
    currentCode = code;
    const p = await store.product(code);
    if (!p) return;
    const tier = cust?.price_tier || (await store.settings()).default_price_tier;
    const pr = await store.priceFor(code, tier);
    root.querySelector('#detail').innerHTML = `<div class="card" style="margin-top:10px"><div class="row"><div class="grow"><div style="font-size:19px;font-weight:700">${esc(p.description)}</div><div class="muted">${esc(p.item_code)} · ${esc(p.category)}${p.uom_selling ? ` · ${t('per')} ${esc(p.uom_selling)}` : ''}</div></div></div>
      <div class="price-panel" style="margin-top:12px">
        <div class="price-box list"><div class="lbl">${bi('list_price', '<br>')}</div><div class="val">${pr ? `<small>RM</small>${rm(pr.list_price_sen)}` : '—'}</div></div>
        <div class="price-box floor"><div class="lbl">${bi('floor_price', '<br>')}</div><div class="val">${pr ? `<small>RM</small>${rm(pr.floor_price_sen)}` : '—'}</div></div></div>
      <div class="small muted" style="margin-top:8px">${pr ? `${t('price_tier')}: ${esc(tierName(pr.price_tier))}${pr.fallback ? ` ${t('tier_fallback')}` : ''} · ${pr.effective_from}` : bi('no_price')}</div>
      <div class="row" style="margin-top:12px"><a class="btn grow" href="#/capture?item=${encodeURIComponent(code)}${cust ? `&customer=${encodeURIComponent(cust.customer_code)}` : ''}">${bi('capture')}</a></div></div>`;
    root.querySelector('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  if (params.item) showPrice(params.item);

  root.querySelector('#pick-cust').onclick = () => pickCustomer(customers, c => { cust = c; setLastCustomer(c ? c.customer_code : ''); custLine(); if (currentCode) showPrice(currentCode); });
}

export function pickCustomer(customers, onPick) {
  import('../ui.js').then(({ modal }) => {
    modal(`<h2>${bi('choose_customer')}</h2><input type="search" id="cq" placeholder="${esc(t('search'))}" autocomplete="off"><div id="cl" class="list" style="margin-top:10px"></div>`, {
      onMount: (el, close) => {
        const list = el.querySelector('#cl');
        const draw = q => {
          const s = q.trim().toLowerCase();
          const hits = customers.filter(c => !s || c.customer_code.toLowerCase().includes(s) || (c.customer_name || '').toLowerCase().includes(s)).slice(0, 60);
          list.innerHTML = `<div class="item" data-code=""><div class="grow muted">${bi('no_customer')}</div></div>` + hits.map(c => `<div class="item" data-code="${esc(c.customer_code)}"><div class="grow"><div class="title">${esc(c.customer_name)}</div><div class="sub">${esc(c.customer_code)} · ${esc(c.customer_type || '')} ${esc(c.size_tier || '')}</div></div><span class="badge">${esc(c.price_tier || '')}</span></div>`).join('');
        };
        draw('');
        el.querySelector('#cq').oninput = e => draw(e.target.value);
        el.querySelector('#cq').focus();
        list.onclick = e => { const it = e.target.closest('.item'); if (!it) return; onPick(customers.find(c => c.customer_code === it.dataset.code) || null); close(); };
      },
    });
  });
}
