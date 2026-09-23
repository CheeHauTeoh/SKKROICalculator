// Netlify Function: the whole API on WASM SQLite, with the database file persisted in Netlify Blobs.
//
// Model: one blob holds the SQLite file. Reads use a per-instance cache keyed by the blob's etag.
// Writes take a short lock blob, reload the latest file if it changed, apply the request, then write
// the file back. Last-writer-wins is still possible if the lock expires (15 s) mid-request, so this is
// a pilot-grade setup for ~10 internal users, not a high-concurrency one. See README "Hosting".
import { getStore, getDeployStore } from '@netlify/blobs';
import initSqlJs from 'sql.js';
import { createRuntime, apiPath } from './core.mjs';
import { WASM_B64, SAMPLE } from './generated.js';

let SQL = null;
const sqlJs = async () => (SQL ||= await initSqlJs({ wasmBinary: Buffer.from(WASM_B64, 'base64') }));
const runtimes = new Map(); // one per store scope

function runtimeFor(context) {
  const prod = !context?.deploy?.context || context.deploy.context === 'production';
  const key = prod ? 'prod' : `deploy:${context.deploy.id}`;
  if (!runtimes.has(key)) {
    const store = prod ? getStore({ name: 'skk-pricing', consistency: 'strong' }) : getDeployStore({ name: 'skk-pricing', consistency: 'strong' });
    runtimes.set(key, createRuntime({ store, sqlJs, env: k => Netlify.env.get(k), sample: SAMPLE }));
  }
  return runtimes.get(key);
}

export default async (req, context) => {
  const url = new URL(req.url);
  const info = { method: req.method, path: apiPath(url.pathname), query: Object.fromEntries(url.searchParams), cookie: req.headers.get('cookie') || '',
    authorization: req.headers.get('authorization') || '', bodyText: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await req.text() : '' };
  try {
    const r = await runtimeFor(context).handle(info);
    return new Response(r.body, { status: r.status, headers: r.headers });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message }), { status: e.status || 500, headers: { 'Content-Type': 'application/json' } });
  }
};
