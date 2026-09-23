import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import * as imp from '../server/importer.js';
import { hashPassword } from '../server/auth.js';
import { now } from '../server/db.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLE = join(here, '..', 'data', 'sample');
export const readSample = f => readFileSync(join(SAMPLE, f), 'utf8');

export function seedSample(db) {
  const out = {};
  for (const [kind, file] of [['products', 'seed_products.csv'], ['customers', 'seed_customers.csv'], ['sales', 'seed_customer_products.csv'], ['bundles', 'seed_bundles.csv'], ['crosssell', 'seed_crosssell.csv']])
    out[kind] = imp.commit(db, { kind, text: readSample(file), filename: file, who: 'test' });
  return out;
}

export function addUser(db, username, role, salesperson_code = null, password = 'secret123') {
  db.run(`INSERT INTO users(username, display_name, role, salesperson_code, password_hash, must_change_password, active, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
    username, username, role, salesperson_code, hashPassword(password), now());
}

export async function startApp() {
  const app = createApp({ dbPath: ':memory:' });
  seedSample(app.db);
  addUser(app.db, 'fin', 'finance');
  addUser(app.db, 'boss', 'owner');
  // salesperson users were created by the customers import (ali, chong, muthu) with the default password
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = async (username, password = 'secret123') => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!r.ok) throw new Error(`login failed for ${username}: ${r.status}`);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data };
    };
    return { get: p => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: p => call('DELETE', p, {}) };
  };
  return { app, base, client, close: () => app.close() };
}

/** Collect every key in a JSON value (deep). */
export function allKeys(v, acc = new Set()) {
  if (Array.isArray(v)) v.forEach(x => allKeys(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); allKeys(x, acc); }
  return acc;
}
