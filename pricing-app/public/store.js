// Offline data layer for the salesperson screens.
//  * snapshot: products / current prices / customers / regular items / gaps / bundles cached in IndexedDB.
//    Server wins: every refresh replaces the cache wholesale.
//  * outbox: competitor-price captures queued locally and pushed with client-generated ids.
//    Client wins: the server upserts by id, so retries never duplicate.
import * as idb from './idb.js';
import { get, post, ApiError } from './api.js';

const listeners = new Set();
export const state = { online: navigator.onLine, syncing: false, lastSync: null, pending: 0, snapshotVersion: null, user: null, error: null };
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => fn(state));

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));

export async function init() {
  state.lastSync = (await idb.get('meta', 'lastSync')) || null;
  state.snapshotVersion = (await idb.get('meta', 'version')) || null;
  state.user = (await idb.get('meta', 'user')) || null;
  state.pending = await idb.count('outbox');
  window.addEventListener('online', () => { state.online = true; emit(); syncAll(); });
  window.addEventListener('offline', () => { state.online = false; emit(); });
  setInterval(() => { if (state.online) flushOutbox(); }, 60_000);
  setInterval(() => { if (state.online) refreshSnapshot(); }, 15 * 60_000);
  emit();
}

export async function refreshSnapshot() {
  if (!state.online || state.syncing) return false;
  state.syncing = true; emit();
  try {
    const s = await get('/api/sync/snapshot');
    const byCustomer = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return [...m.entries()]; };
    await idb.replaceAll('products', s.products.map(p => [p.item_code, p]));
    await idb.replaceAll('prices', s.prices.map(p => [`${p.item_code}|${p.price_tier}`, p]));
    await idb.replaceAll('customers', s.customers.map(c => [c.customer_code, c]));
    await idb.replaceAll('customer_products', byCustomer(s.customer_products, 'customer_code'));
    await idb.replaceAll('crosssell', byCustomer(s.crosssell, 'customer_code'));
    await idb.replaceAll('bundles', byCustomer(s.bundles, 'customer_type'));
    await idb.put('meta', 'tiers', s.tiers); await idb.put('meta', 'settings', s.settings); await idb.put('meta', 'user', s.user);
    await idb.put('meta', 'version', s.version); await idb.put('meta', 'lastSync', new Date().toISOString());
    state.user = s.user; state.snapshotVersion = s.version; state.lastSync = new Date().toISOString(); state.error = null;
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) state.error = 'unauthenticated'; else state.error = e.message;
    return false;
  } finally { state.syncing = false; emit(); }
}

export async function flushOutbox() {
  if (!state.online) return;
  const entries = await idb.getAll('outbox');
  if (!entries.length) return;
  try {
    const r = await post('/api/field-prices/batch', { captures: entries });
    for (const id of r.accepted) await idb.del('outbox', id);
    for (const rej of r.rejected) { // keep unknown_product etc. out of the queue but remember the failure
      const c = entries.find(e => e.id === rej.id);
      if (c) { c.sync_error = rej.error; await idb.put('captures', c.id, c); }
      await idb.del('outbox', rej.id);
    }
    state.pending = await idb.count('outbox'); state.error = null;
  } catch (e) { state.error = e.message; }
  emit();
}

export const syncAll = async () => { await flushOutbox(); await refreshSnapshot(); };

/** Queue a capture. Returns the stored row. Works fully offline. */
export async function queueCapture(input) {
  const nowIso = new Date().toISOString();
  const row = { id: input.id || uuid(), captured_at: input.captured_at || nowIso, customer_code: input.customer_code || null, item_code: input.item_code,
    our_price_sen: input.our_price_sen ?? null, competitor_price_sen: input.competitor_price_sen ?? null, competitor_name: input.competitor_name || null,
    outcome: input.outcome || 'quoted', note: input.note || null, client_updated_at: nowIso, deleted: !!input.deleted };
  await idb.put('outbox', row.id, row);
  await idb.put('captures', row.id, row);
  state.pending = await idb.count('outbox'); emit();
  if (state.online) flushOutbox();
  return row;
}
export const localCaptures = async () => (await idb.getAll('captures')).sort((a, b) => b.captured_at.localeCompare(a.captured_at));

// ---- reads (cache) ----------------------------------------------------------------------------
export const products = () => idb.getAll('products');
export const customers = () => idb.getAll('customers');
export const customer = code => idb.get('customers', code);
export const product = code => idb.get('products', code);
export const settings = async () => (await idb.get('meta', 'settings')) || { default_price_tier: 'STD' };
export const tiers = async () => (await idb.get('meta', 'tiers')) || [];
export const regularItems = async code => (await idb.get('customer_products', code)) || [];
export const gapsFor = async code => (await idb.get('crosssell', code)) || [];
export const bundlesFor = async type => (await idb.get('bundles', type)) || [];

let priceIndex = null, priceVersion = null;
async function prices() {
  if (priceIndex && priceVersion === state.snapshotVersion) return priceIndex;
  const rows = await idb.getAll('prices');
  priceIndex = new Map(rows.map(r => [`${r.item_code}|${r.price_tier}`, r])); priceVersion = state.snapshotVersion;
  return priceIndex;
}
/** Price for a tier with fallback to the default tier. */
export async function priceFor(item_code, tier) {
  const idx = await prices(); const def = (await settings()).default_price_tier || 'STD';
  const hit = idx.get(`${item_code}|${tier}`) || idx.get(`${item_code}|${def}`);
  return hit ? { ...hit, fallback: hit.price_tier !== tier } : null;
}

/** Search products by code prefix / description substring. Core SKUs first. */
export function searchProducts(all, q, limit = 30) {
  const s = q.trim().toLowerCase();
  if (!s) return all.filter(p => p.is_core_80).slice(0, limit);
  const terms = s.split(/\s+/);
  const score = p => {
    const code = p.item_code.toLowerCase(), desc = (p.description || '').toLowerCase();
    if (code === s) return 100;
    if (code.startsWith(s)) return 80;
    if (!terms.every(t => code.includes(t) || desc.includes(t))) return 0;
    return (desc.startsWith(s) ? 60 : 40) + (p.is_core_80 ? 5 : 0);
  };
  return all.map(p => [score(p), p]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}
export async function clearAll() { for (const s of ['meta', 'products', 'prices', 'customers', 'customer_products', 'crosssell', 'bundles', 'captures']) await idb.clear(s); }
