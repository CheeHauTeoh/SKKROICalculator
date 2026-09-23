import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, allKeys, readSample } from './helpers.js';
import { SENSITIVE_KEY } from '../server/redact.js';

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const noSensitive = (data, label) => {
  const bad = [...allKeys(data)].filter(k => SENSITIVE_KEY.test(k));
  assert.deepEqual(bad, [], `${label} leaked keys: ${bad.join(', ')}`);
};

test('unauthenticated requests are rejected', async () => {
  const r = await fetch(`${t.base}/api/products`);
  assert.equal(r.status, 401);
});

test('salesperson never receives cost or margin from any endpoint they can reach', async () => {
  const sp = await t.client('ali', 'sk1234');
  for (const path of ['/api/products', '/api/products/9.EC22', '/api/products?core=1', '/api/sync/snapshot', '/api/customers', '/api/customers/C0001/visit', '/api/tiers', '/api/categories', '/api/field-prices', '/api/auth/me']) {
    const r = await sp.get(path);
    assert.equal(r.status, 200, path);
    noSensitive(r.data, path);
  }
  // management-only endpoints are forbidden outright
  for (const path of ['/api/uom/queue', '/api/uom/progress', '/api/intel/summary', '/api/prices/history', '/api/export/products.csv', '/api/audit', '/api/imports', '/api/settings'])
    assert.equal((await sp.get(path)).status, 403, path);
  assert.equal((await sp.patch('/api/products/9.EC22', { verified_unit_cost_sen: 1 })).status, 403);
  assert.equal((await sp.post('/api/prices', { item_code: '9.EC22', price_tier: 'STD', list_price_sen: 1, floor_price_sen: 1 })).status, 403);
});

test('owner can flip the cost-visibility setting and it takes effect server-side', async () => {
  const boss = await t.client('boss');
  const sp = await t.client('ali', 'sk1234');
  await boss.put('/api/settings', { salesperson_can_see_cost: '1' });
  const r = await sp.get('/api/products/SXLSK');
  assert.ok('implied_unit_cost_sen' in r.data);
  await boss.put('/api/settings', { salesperson_can_see_cost: '0' });
  noSensitive((await sp.get('/api/products/SXLSK')).data, 'after reset');
});

test('margin is suppressed for UOM_SUSPECT with no verified cost, and verified cost overrides implied', async () => {
  const fin = await t.client('fin');
  await fin.post('/api/prices', { item_code: '9.EC22', price_tier: 'STD', list_price_sen: 520, floor_price_sen: 490 });
  let p = (await fin.get('/api/products/9.EC22')).data;
  assert.equal(p.cost_data_quality, 'UOM_SUSPECT');
  assert.equal(p.margin_pct, null);
  assert.equal(p.cost.basis, null);
  assert.equal(p.cost_not_verified, true);
  // OK-quality SKU may show an implied margin, labelled as such
  await fin.post('/api/prices', { item_code: 'SXLSK', price_tier: 'STD', list_price_sen: 423, floor_price_sen: 400 });
  p = (await fin.get('/api/products/SXLSK')).data;
  assert.equal(p.cost.basis, 'implied');
  assert.equal(p.margin_pct, 47.3);
  // reconcile: 25 packets per carton -> RM4.87 per packet, verified
  const r = await fin.patch('/api/products/9.EC22', { uom_purchase: 'CTN', uom_selling: 'PKT', uom_factor: 25, verified_unit_cost_sen: 487 });
  assert.equal(r.status, 200);
  p = r.data.product;
  assert.equal(p.cost.basis, 'verified');
  assert.equal(p.cost_updated_by, 'fin');
  assert.equal(p.margin_pct, 6.3); // (520-487)/520
  const audit = (await fin.get('/api/audit?entity=products&entity_id=9.EC22')).data;
  assert.ok(audit.some(a => a.field === 'verified_unit_cost_sen' && a.new_value === '487' && a.who === 'fin'));
});

test('price history is append-only and attributable', async () => {
  const fin = await t.client('fin');
  await fin.post('/api/prices', { item_code: '70.JP9', price_tier: 'STD', list_price_sen: 2000, floor_price_sen: 1900, effective_from: '2026-03-01' });
  await fin.post('/api/prices', { item_code: '70.JP9', price_tier: 'STD', list_price_sen: 2100, floor_price_sen: 1950, effective_from: '2026-06-01' });
  const same = await fin.post('/api/prices', { item_code: '70.JP9', price_tier: 'STD', list_price_sen: 2100, floor_price_sen: 1950 });
  assert.equal(same.data.changed, false);
  const hist = (await fin.get('/api/prices/history?item_code=70.JP9')).data;
  assert.equal(hist.length, 2);
  assert.equal(hist[0].effective_to, null);
  assert.equal(hist[1].effective_to, '2026-06-01');
  assert.ok(hist.every(h => h.set_by === 'fin' && h.created_at));
  const march = (await fin.get('/api/prices/at?date=2026-03-15&item_code=70.JP9')).data;
  assert.equal(march[0].list_price_sen, 2000);
  assert.equal((await fin.post('/api/prices', { item_code: '70.JP9', price_tier: 'STD', list_price_sen: 100, floor_price_sen: 200 })).status, 400);
});

test('bulk edit by category derives list prices only where there is a cost basis', async () => {
  const fin = await t.client('fin');
  const r = await fin.post('/api/prices/bulk', { filter: { category: 'Plastic bags' }, action: 'set_target_margin', params: { target_margin_pct: 25 } });
  assert.ok(r.data.changed > 0);
  const d = await fin.post('/api/prices/bulk', { filter: { category: 'Plastic bags' }, action: 'derive_list_from_cost', params: { floor_discount_pct: 5 } });
  assert.ok(d.data.changed > 0);
  assert.ok((d.data.skipped_reasons.no_cost_basis || 0) >= 0);
  const suspectNoPrice = (await fin.get('/api/products?category=Plastic%20bags&quality=UOM_SUSPECT')).data.filter(p => p.cost.basis === null);
  for (const p of suspectNoPrice) assert.equal(p.prices.STD, undefined, `${p.item_code} should not get a derived price without cost`);
});

test('salesperson price lookup uses the customer tier with fallback to STD', async () => {
  const fin = await t.client('fin');
  await fin.patch('/api/customers/C0002', { price_tier: 'KEY' });
  await fin.post('/api/prices', { item_code: 'SXLSK', price_tier: 'KEY', list_price_sen: 410, floor_price_sen: 395 });
  const sp = await t.client('muthu', 'sk1234');
  const v = (await sp.get('/api/customers/C0002/visit')).data;
  assert.equal(v.tier, 'KEY');
  const snap = (await sp.get('/api/sync/snapshot')).data;
  assert.ok(snap.prices.some(p => p.item_code === 'SXLSK' && p.price_tier === 'KEY' && p.list_price_sen === 410));
  assert.ok(snap.customers.every(c => c.salesperson === 'MUTHU'));
  assert.ok(snap.products.length > 0 && snap.bundles.length > 0);
});

test('field price capture sync is idempotent and client-wins', async () => {
  const fin0 = await t.client('fin');
  await fin0.post('/api/prices', { item_code: 'SXLSK', price_tier: 'STD', list_price_sen: 423, floor_price_sen: 400 });
  const sp = await t.client('chong', 'sk1234');
  const id = randomUUID();
  const cap = { id, captured_at: '2026-09-01T02:00:00.000Z', customer_code: 'C0003', item_code: 'SXLSK', competitor_price_sen: 400, competitor_name: 'Competitor A', outcome: 'quoted', client_updated_at: '2026-09-01T02:00:00.000Z' };
  let r = await sp.post('/api/field-prices/batch', { captures: [cap] });
  assert.deepEqual(r.data.accepted, [id]);
  r = await sp.post('/api/field-prices/batch', { captures: [cap] }); // retry after lost ack
  assert.deepEqual(r.data.accepted, [id]);
  r = await sp.post('/api/field-prices/batch', { captures: [{ ...cap, outcome: 'lost', competitor_price_sen: 390, client_updated_at: '2026-09-01T03:00:00.000Z' }] });
  assert.deepEqual(r.data.accepted, [id]);
  const rows = (await sp.get('/api/field-prices?item_code=SXLSK')).data.filter(x => x.id === id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'lost');
  assert.equal(rows[0].competitor_price_sen, 390);
  assert.equal(rows[0].salesperson, 'CHONG');
  const bad = await sp.post('/api/field-prices/batch', { captures: [{ id: randomUUID(), item_code: 'NOPE', competitor_price_sen: 1 }] });
  assert.equal(bad.data.rejected.length, 1);
  // intelligence: our STD list 423 > max competitor 390 -> flagged
  const fin = await t.client('fin');
  const flagged = (await fin.get('/api/intel/summary?only=flagged')).data;
  assert.ok(flagged.some(x => x.item_code === 'SXLSK' && x.above_all_competitors));
});

test('market reference only for branded SKUs and always with a source', async () => {
  const fin = await t.client('fin');
  const branded = (await fin.get('/api/products')).data.find(p => p.is_branded);
  const notBranded = (await fin.get('/api/products')).data.find(p => !p.is_branded);
  assert.equal((await fin.post('/api/market-refs', { item_code: notBranded.item_code, source_name: 'X', source_url: 'https://example.com', price_sen: 100, unit: 'CTN' })).status, 400);
  assert.equal((await fin.post('/api/market-refs', { item_code: branded.item_code, source_name: 'X', source_url: 'not a url', price_sen: 100, unit: 'CTN' })).status, 400);
  const ok = await fin.post('/api/market-refs', { item_code: branded.item_code, source_name: 'Wholesaler A', source_url: 'https://example.com/p', price_sen: 615, unit: 'CTN' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.source_url, 'https://example.com/p');
});

test('import via API: check then commit, second commit is a no-op', async () => {
  const fin = await t.client('fin');
  const text = readSample('seed_bundles.csv');
  const chk = await fin.post('/api/import/check', { kind: 'auto', filename: 'seed_bundles.csv', text });
  assert.equal(chk.data.kind, 'bundles');
  assert.ok(chk.data.already_imported);
  const again = await fin.post('/api/import/commit', { kind: 'bundles', filename: 'seed_bundles.csv', text });
  assert.equal(again.data.skipped, true);
  const imports = (await fin.get('/api/imports')).data;
  assert.ok(imports.reconcile.total_sen > 0);
});

test('UOM queue and progress track the core SKUs', async () => {
  const fin = await t.client('fin');
  const prog = (await fin.get('/api/uom/progress')).data;
  assert.ok(prog.core_total > 0);
  assert.ok(prog.core_done >= 1); // 9.EC22 was verified above
  const q = (await fin.get('/api/uom/queue?scope=core_suspect&status=open')).data;
  assert.ok(q.every(p => p.is_core_80 === 1 && p.cost_data_quality === 'UOM_SUSPECT' && !p.done));
  const marked = await fin.patch('/api/products/' + q[0].item_code, { no_purchase_confirmed: true });
  assert.equal(marked.data.product.no_purchase_confirmed, 1);
  assert.equal((await fin.get('/api/uom/progress')).data.core_done, prog.core_done + 1);
});

test('exports contain cost for finance and are forbidden for salespeople', async () => {
  const fin = await t.client('fin');
  const csv = await fin.get('/api/export/products.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.data.includes('verified_unit_cost'));
  const sp = await t.client('ali', 'sk1234');
  assert.equal((await sp.get('/api/export/products.csv')).status, 403);
});
