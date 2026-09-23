// Exercises the serverless runtime (sql.js driver + blob persistence + write lock) against an
// in-memory fake of the Netlify Blobs store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { createRuntime, apiPath, KEY } from '../netlify/functions/api/core.mjs';
import { SENSITIVE_KEY } from '../server/redact.js';
import { allKeys, SAMPLE as SAMPLE_DIR } from './helpers.js';

function fakeStore() {
  const m = new Map(); let n = 0;
  const wrap = v => (v instanceof Uint8Array ? v.slice() : v);
  return {
    writes: 0,
    async get(k, o) { const e = m.get(k); if (!e) return null; if (o?.type === 'json') return JSON.parse(e.v); if (o?.type === 'arrayBuffer') return e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength); return e.v; },
    async getMetadata(k) { const e = m.get(k); return e ? { etag: e.etag, metadata: {} } : null; },
    async set(k, v) { this.writes++; m.set(k, { v: wrap(v), etag: String(++n) }); },
    async setJSON(k, v) { m.set(k, { v: JSON.stringify(v), etag: String(++n) }); },
    async delete(k) { m.delete(k); },
    size() { return m.get(KEY)?.v.byteLength ?? 0; },
  };
}
const sample = Object.fromEntries(readdirSync(SAMPLE_DIR).filter(f => f.endsWith('.csv')).map(f => [f, readFileSync(join(SAMPLE_DIR, f), 'utf8')]));
const sqlJs = (() => { let p; return () => (p ||= initSqlJs()); })();
const env = { ADMIN_PASSWORD: 'boss12345', SEED_SAMPLE: '1', LOCK_SETTLE_MS: '1' };
const mk = store => createRuntime({ store, sqlJs, env: k => env[k], sample });
const call = (rt, method, path, { cookie = '', body } = {}) => rt.handle({ method, path: new URL('http://x' + path).pathname, query: Object.fromEntries(new URL('http://x' + path).searchParams), cookie, authorization: '', bodyText: body ? JSON.stringify(body) : '' }).then(r => ({ ...r, json: r.headers['Content-Type']?.includes('json') ? JSON.parse(r.body) : r.body }));
const cookieOf = r => (r.headers['Set-Cookie'] || '').split(';')[0];

test('apiPath normalises both entry points', () => {
  assert.equal(apiPath('/api/products'), '/api/products');
  assert.equal(apiPath('/.netlify/functions/api/products'), '/api/products');
});

test('first request bootstraps, seeds the sample and persists the file; later instances read it back', async () => {
  const store = fakeStore();
  const rt = mk(store);
  const login = await call(rt, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'boss12345' } });
  assert.equal(login.status, 200);
  const cookie = cookieOf(login);
  assert.ok(cookie.startsWith('skk_sid='));
  assert.ok(store.size() > 50_000);
  const products = await call(rt, 'GET', '/api/products?core=1', { cookie });
  assert.equal(products.status, 200); assert.ok(products.json.length > 40);
  // a second runtime (cold instance) sees the same data, including the session
  const rt2 = mk(store);
  const me = await call(rt2, 'GET', '/api/auth/me', { cookie });
  assert.equal(me.status, 200); assert.equal(me.json.user.username, 'owner');
});

test('writes persist across instances, are serialised by the lock, and reads never leak cost to salespeople', async () => {
  const store = fakeStore();
  const rtA = mk(store), rtB = mk(store);
  const owner = cookieOf(await call(rtA, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'boss12345' } }));
  const w = store.writes;
  const r = await call(rtA, 'POST', '/api/prices', { cookie: owner, body: { item_code: '9.EC22', price_tier: 'STD', list_price_sen: 610, floor_price_sen: 580 } });
  assert.equal(r.status, 200); assert.equal(store.writes, w + 1);
  // instance B, which has never seen this write, reads it because the etag changed
  const p = await call(rtB, 'GET', '/api/products/9.EC22', { cookie: owner });
  assert.equal(p.json.prices.STD.list_price_sen, 610);
  // two concurrent captures from two instances both land
  const ali = cookieOf(await call(rtB, 'POST', '/api/auth/login', { body: { username: 'ali', password: 'sk1234' } }));
  const ids = [randomUUID(), randomUUID()];
  await Promise.all([
    call(rtA, 'POST', '/api/field-prices/batch', { cookie: ali, body: { captures: [{ id: ids[0], item_code: '9.EC22', competitor_price_sen: 550 }] } }),
    call(rtB, 'POST', '/api/field-prices/batch', { cookie: ali, body: { captures: [{ id: ids[1], item_code: '9.EC22', competitor_price_sen: 560 }] } }),
  ]);
  const rtC = mk(store);
  const fps = await call(rtC, 'GET', '/api/field-prices?item_code=9.EC22', { cookie: owner });
  assert.deepEqual(fps.json.map(x => x.id).sort(), ids.slice().sort());
  const snap = await call(rtC, 'GET', '/api/sync/snapshot', { cookie: ali });
  const leaked = [...allKeys(snap.json)].filter(k => SENSITIVE_KEY.test(k));
  assert.deepEqual(leaked, []);
  assert.equal((await call(rtC, 'GET', '/api/export/products.csv', { cookie: ali })).status, 403);
});

test('owner reset wipes business data but keeps logins, and can reload the sample', async () => {
  const store = fakeStore();
  const rt = mk(store);
  const owner = cookieOf(await call(rt, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'boss12345' } }));
  assert.equal((await call(rt, 'POST', '/api/admin/reset', { cookie: owner, body: { password: 'wrong', confirm: 'RESET' } })).status, 401);
  const r = await call(rt, 'POST', '/api/admin/reset', { cookie: owner, body: { password: 'boss12345', confirm: 'RESET' } });
  assert.equal(r.status, 200);
  assert.equal((await call(rt, 'GET', '/api/products', { cookie: owner })).json.length, 0);
  assert.equal((await call(rt, 'GET', '/api/auth/me', { cookie: owner })).status, 200);
  const r2 = await call(rt, 'POST', '/api/admin/reset', { cookie: owner, body: { password: 'boss12345', confirm: 'RESET', seed_sample: true } });
  assert.ok(r2.json.seeded.length >= 5);
  assert.equal((await call(rt, 'GET', '/api/products', { cookie: owner })).json.length, 67);
});

test('OWNER_PASSWORD_RESET recovers the owner login once per value; health reports the password source', async () => {
  const store = fakeStore();
  const rt = mk(store);
  const h = await call(rt, 'GET', '/api/health');
  assert.equal(h.status, 200); assert.equal(h.json.bootstrap_password_source, 'env'); assert.equal(h.json.owner_password_reset_at, null);
  env.OWNER_PASSWORD_RESET = 'recovered1';
  const rt2 = mk(store); // cold instance picks it up
  assert.equal((await call(rt2, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'boss12345' } })).status, 401);
  const ok = await call(rt2, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'recovered1' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.user.must_change_password, true);
  assert.ok((await call(rt2, 'GET', '/api/health')).json.owner_password_reset_at);
  // owner changes the password; a redeploy with the same env value must not undo it
  const cookie = cookieOf(ok);
  assert.equal((await call(rt2, 'POST', '/api/auth/change-password', { cookie, body: { current_password: 'recovered1', new_password: 'mine-now-1' } })).status, 200);
  const rt3 = mk(store);
  assert.equal((await call(rt3, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'recovered1' } })).status, 401);
  assert.equal((await call(rt3, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'mine-now-1' } })).status, 200);
  delete env.OWNER_PASSWORD_RESET;
});
