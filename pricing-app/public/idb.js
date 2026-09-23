// Tiny IndexedDB wrapper. Stores: meta, products, prices, customers, customer_products, crosssell, bundles, outbox.
const NAME = 'skk-pricing', VERSION = 1;
let dbp = null;
export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['meta', 'products', 'prices', 'customers', 'customer_products', 'crosssell', 'bundles', 'outbox', 'captures']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const tx = async (store, mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store); const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
};
export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const getAll = store => tx(store, 'readonly', s => s.getAll());
export const put = (store, key, value) => tx(store, 'readwrite', s => s.put(value, key));
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const clear = store => tx(store, 'readwrite', s => s.clear());
export const replaceAll = (store, entries) => tx(store, 'readwrite', s => { s.clear(); for (const [k, v] of entries) s.put(v, k); });
export const count = store => tx(store, 'readonly', s => s.count());
