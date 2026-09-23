// Visit prep: customer profile, regular items, gaps vs peers, bundles. All from the offline cache.
import * as store from '../store.js';
import { esc, bi, t, rm, rmBig, pct, num, dt, on } from '../ui.js';
import { pickCustomer, getLastCustomer, setLastCustomer } from './lookup.js';

export async function render(root, { params }) {
  const customers = await store.customers();
  const tiers = await store.tiers();
  let cust = customers.find(c => c.customer_code === (params.customer || getLastCustomer())) || null;
  root.innerHTML = `<h1>${bi('visit_prep')}</h1><div id="body"></div>`;
  const body = root.querySelector('#body');

  const question = (p, g) => `${esc(p.description)} — 您店里现在从哪里进货？同类客户有 ${Math.round(g.peer_penetration_pct ?? 0)}% 在我们这儿买。<br><span class="en">Where do you get ${esc(p.description)} now? ${Math.round(g.peer_penetration_pct ?? 0)}% of shops like yours buy it from us.</span>`;
  const bundleQ = (p, b) => `最近有没有一起要 ${esc(p.description)}？买您常买那些货的客户，${Math.round(b.support_pct ?? 0)}% 也一起拿这个。<br><span class="en">Shops that buy what you buy also take ${esc(p.description)} (${Math.round(b.support_pct ?? 0)}% of them).</span>`;

  async function draw() {
    if (!cust) { body.innerHTML = `<div class="card"><p class="muted">${bi('choose_customer')}</p><button class="btn primary block" id="pick">${bi('choose_customer')}</button></div>`; body.querySelector('#pick').onclick = pick; return; }
    const tier = cust.price_tier || (await store.settings()).default_price_tier;
    const tierName = (tiers.find(x => x.code === tier) || {}).name_zh || tier;
    const regular = await store.regularItems(cust.customer_code);
    const gaps = (await store.gapsFor(cust.customer_code)).sort((a, b) => (b.estimated_annual_value_sen || 0) - (a.estimated_annual_value_sen || 0));
    const own = new Set(regular.map(r => r.item_code));
    const bundles = (await store.bundlesFor(cust.customer_type)).filter(b => !own.has(b.item_code)).sort((a, b) => (b.lift || 0) - (a.lift || 0)).slice(0, 12);
    const prod = async code => (await store.product(code)) || { item_code: code, description: code };
    const withPrice = async rows => Promise.all(rows.map(async r => ({ ...r, p: await prod(r.item_code), price: await store.priceFor(r.item_code, tier) })));
    const R = await withPrice(regular.slice(0, 20)), G = await withPrice(gaps.slice(0, 10)), B = await withPrice(bundles);
    const captures = (await store.localCaptures()).filter(c => c.customer_code === cust.customer_code).slice(0, 5);
    const priceLine = pr => pr ? `<span class="tnum"><b>RM ${rm(pr.list_price_sen)}</b> <span class="muted">/ ${rm(pr.floor_price_sen)}</span></span>` : `<span class="muted small">${t('no_price')}</span>`;
    body.innerHTML = `
      <div class="card"><div class="row"><div class="grow"><div style="font-size:19px;font-weight:700">${esc(cust.customer_name)}</div><div class="muted small">${esc(cust.customer_code)} · ${esc(cust.salesperson || '')}</div></div><button class="btn sm" id="pick">${bi('choose_customer')}</button></div>
        <div class="kpis" style="margin-top:10px"><div class="kpi"><div class="v">${esc(cust.customer_type || '—')}</div><div class="l">${bi('customer_type')}</div></div><div class="kpi"><div class="v">${esc(cust.size_tier || '—')}</div><div class="l">${bi('size')}</div></div><div class="kpi"><div class="v">${esc(tierName)}</div><div class="l">${bi('price_tier')}</div></div><div class="kpi"><div class="v">${rmBig(cust.fy_value_sen)}</div><div class="l">${bi('fy_value')}</div></div></div></div>
      <h2>${bi('gaps')} <span class="badge">${G.length}</span></h2>
      ${G.length ? G.map(g => `<div class="card flat" style="margin-bottom:8px"><div class="row"><div class="grow"><div class="zh">${esc(g.p.description)}</div><div class="small muted">${esc(g.item_code)} · ${t('peer_pen')} ${pct(g.peer_penetration_pct)} · ${t('est_value')} ${rmBig(g.estimated_annual_value_sen)}/yr</div></div><div class="right">${priceLine(g.price)}</div></div><div class="q">${question(g.p, g)}</div>
        <div class="row" style="margin-top:8px"><a class="btn sm" href="#/capture?item=${encodeURIComponent(g.item_code)}&customer=${encodeURIComponent(cust.customer_code)}">${bi('capture')}</a></div></div>`).join('') : `<p class="muted">${bi('none_yet')}</p>`}
      <h2>${bi('bundles')} <span class="badge">${B.length}</span></h2>
      ${B.length ? B.map(b => `<div class="card flat" style="margin-bottom:8px"><div class="row"><div class="grow"><div class="zh">${esc(b.p.description)}</div><div class="small muted">${esc(b.item_code)} · ${t('support')} ${pct(b.support_pct)} · ${t('lift')} ${b.lift ?? '—'} · ${rmBig(b.median_annual_value_sen)}/yr</div></div><div class="right">${priceLine(b.price)}</div></div><div class="q">${bundleQ(b.p, b)}</div></div>`).join('') : `<p class="muted">${bi('none_yet')}</p>`}
      <h2>${bi('regular_items')} <span class="badge">${regular.length}</span></h2>
      <div class="tblwrap"><table class="tbl"><tr><th>${bi('product')}</th><th class="num">${t('qty')}</th><th class="num">${t('value')}</th><th class="num">${t('list_price')} / ${t('floor_price')}</th></tr>
      ${R.map(r => `<tr><td><a href="#/lookup?item=${encodeURIComponent(r.item_code)}&customer=${encodeURIComponent(cust.customer_code)}">${esc(r.p.description)}</a><div class="small muted">${esc(r.item_code)}</div></td><td class="num">${num(r.fy_qty)}</td><td class="num">${rmBig(r.fy_value_sen)}</td><td class="num">${priceLine(r.price)}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">${bi('none_yet')}</td></tr>`}</table></div>
      <h2>${bi('recent_captures')}</h2>
      ${captures.length ? `<div class="list">${captures.map(c => `<div class="item"><div class="grow"><div class="title">${esc(c.item_code)} · RM ${rm(c.competitor_price_sen)}</div><div class="sub">${esc(c.competitor_name || t('unknown'))} · ${t(c.outcome)} · ${dt(c.captured_at)}</div></div></div>`).join('')}</div>` : `<p class="muted">${bi('none_yet')}</p>`}`;
    body.querySelector('#pick').onclick = pick;
  }
  function pick() { pickCustomer(customers, c => { cust = c; setLastCustomer(c ? c.customer_code : ''); draw(); }); }
  await draw();
}
