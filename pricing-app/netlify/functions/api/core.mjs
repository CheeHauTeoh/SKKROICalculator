// Runtime core for the Netlify function, with the blob store, sql.js loader and env injected so it
// can be unit-tested against an in-memory store.
import { Db } from '../../../server/db.js';
import { createApi, MUTATING } from '../../../server/app.js';
import * as auth from '../../../server/auth.js';
import { seedFromTexts } from '../../../server/seed.js';

export const KEY = 'pricing.sqlite', LOCK = 'lock';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createRuntime({ store, sqlJs, env, sample = {} }) {
  let cache = { etag: null, db: null, api: null };

  async function loadDb() {
    const meta = await store.getMetadata(KEY);
    if (meta && cache.db && cache.etag === meta.etag) return cache;
    const S = await sqlJs();
    let db;
    if (meta) db = Db.fromSqlJs(S, new Uint8Array(await store.get(KEY, { type: 'arrayBuffer' })));
    else {
      db = Db.fromSqlJs(S);
      auth.bootstrap(db, { adminPassword: env('ADMIN_PASSWORD') });
      if (env('SEED_SAMPLE') === '1') seedFromTexts(db, sample, { who: 'seed' });
      await store.set(KEY, db.export());
    }
    cache = { etag: (await store.getMetadata(KEY))?.etag ?? null, db, api: createApi(db, { secureCookies: true, sampleTexts: async () => sample }) };
    return cache;
  }

  async function saveDb() {
    await store.set(KEY, cache.db.export());
    cache.etag = (await store.getMetadata(KEY))?.etag ?? null;
  }

  async function withLock(fn) {
    const token = crypto.randomUUID(); const deadline = Date.now() + 8000;
    for (;;) {
      const cur = await store.get(LOCK, { type: 'json' });
      if (!cur || cur.expires < Date.now()) {
        await store.setJSON(LOCK, { token, expires: Date.now() + 15000 });
        await sleep(env('LOCK_SETTLE_MS') ? Number(env('LOCK_SETTLE_MS')) : 60);
        if ((await store.get(LOCK, { type: 'json' }))?.token === token) break;
      }
      if (Date.now() > deadline) throw Object.assign(new Error('busy'), { status: 503 });
      await sleep(150 + Math.random() * 200);
    }
    try { return await fn(); } finally { await store.delete(LOCK).catch(() => {}); }
  }

  /** info: { method, path, query, cookie, authorization, bodyText } -> { status, headers, body } */
  async function handle(info) {
    if (!MUTATING.has(info.method)) { const { api } = await loadDb(); return api.dispatch(info); }
    return withLock(async () => {
      const { api } = await loadDb();
      const r = await api.dispatch(info);
      if (r.status < 500) await saveDb();
      return r;
    });
  }
  return { handle, loadDb, saveDb, withLock };
}

/** Normalise the request path whether the function is reached via the redirect or its default URL. */
export function apiPath(pathname) {
  let path = pathname.replace(/^\/\.netlify\/functions\/api/, '');
  if (!path.startsWith('/api/')) path = '/api' + (path.startsWith('/') ? path : '/' + path);
  return path;
}
