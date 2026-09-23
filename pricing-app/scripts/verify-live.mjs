// End-to-end check of a deployed instance: static shell, function boot, login, offline snapshot,
// capture sync, and the salesperson cost-visibility rule. Usage: node scripts/verify-live.mjs https://host
const base = (process.argv[2] || process.env.BASE_URL || '').replace(/\/$/, '');
if (!base) { console.error('usage: node scripts/verify-live.mjs https://host'); process.exit(2); }
const SENSITIVE = /(cost|margin|purchase|uom_factor|uom_purchase|no_purchase|cost_data_quality)/i;
const keys = (v, acc = new Set()) => { if (Array.isArray(v)) v.forEach(x => keys(x, acc)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keys(x, acc); } return acc; };
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
async function call(method, path, { body, cookie } = {}) {
  const t0 = Date.now();
  const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, ms: Date.now() - t0, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const home = await call('GET', '/');
check('GET / serves the app shell', home.status === 200 && home.text.includes('<title>SK Keong'), `${home.status} ${home.ms}ms`);
const sw = await call('GET', '/sw.js');
check('GET /sw.js served', sw.status === 200 && sw.text.includes('skk-v'), `${sw.status}`);
const me = await call('GET', '/api/auth/me');
check('function boots and answers JSON (unauthenticated)', me.status === 401 && me.json?.error === 'unauthenticated', `${me.status} ${me.ms}ms ${me.text.slice(0, 80)}`);
const bad = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'definitely-wrong' } });
check('wrong password rejected', bad.status === 401, `${bad.status}`);
const login = await call('POST', '/api/auth/login', { body: { username: 'ali', password: 'sk1234' } });
check('sample salesperson login', login.status === 200 && login.cookie.startsWith('skk_sid='), `${login.status} ${login.ms}ms ${login.text.slice(0, 80)}`);
const cookie = login.cookie;
const snap = await call('GET', '/api/sync/snapshot', { cookie });
check('offline snapshot has products, prices tiers, customers', snap.status === 200 && snap.json?.products?.length > 0 && snap.json?.customers?.length > 0, `${snap.status} products=${snap.json?.products?.length} customers=${snap.json?.customers?.length} ${snap.ms}ms`);
check('snapshot scoped to the salesperson', snap.json?.customers?.every(c => c.salesperson === 'ALI'));
check('snapshot leaks no cost/margin keys', [...keys(snap.json || {})].filter(k => SENSITIVE.test(k)).length === 0);
const prod = await call('GET', '/api/products/9.EC22', { cookie });
check('product detail for salesperson has no cost keys', prod.status === 200 && [...keys(prod.json)].filter(k => SENSITIVE.test(k)).length === 0, `${prod.status}`);
check('export forbidden for salesperson', (await call('GET', '/api/export/products.csv', { cookie })).status === 403);
const id = crypto.randomUUID();
const cap = await call('POST', '/api/field-prices/batch', { cookie, body: { captures: [{ id, item_code: '9.EC22', customer_code: 'C0003', competitor_price_sen: 555, competitor_name: 'verify-live', outcome: 'quoted', note: 'automated live verification' }] } });
check('capture accepted (write path + lock + blob save)', cap.status === 200 && cap.json?.accepted?.includes(id), `${cap.status} ${cap.ms}ms ${cap.text.slice(0, 120)}`);
const again = await call('POST', '/api/field-prices/batch', { cookie, body: { captures: [{ id, item_code: '9.EC22', customer_code: 'C0003', competitor_price_sen: 555, competitor_name: 'verify-live', outcome: 'quoted' }] } });
check('retry of the same capture is idempotent', again.status === 200 && again.json?.accepted?.includes(id));
const list = await call('GET', `/api/field-prices?item_code=9.EC22`, { cookie });
check('capture persisted and readable', list.status === 200 && list.json?.filter(x => x.id === id).length === 1, `${list.status} rows=${list.json?.length}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nALL LIVE CHECKS PASSED');
process.exit(failures ? 1 : 0);
