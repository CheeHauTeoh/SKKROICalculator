// Transport-agnostic API core plus a Node http adapter.
//   createApi(db, opts)  -> { dispatch(req) }   req = { method, path, query, cookie, authorization, bodyText }
//   createApp(opts)      -> Node server for local hosting (node:sqlite)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './db.js';
import * as auth from './auth.js';
import { buildRoutes } from './routes.js';
import { redactFor } from './redact.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');
export const MAX_BODY = 25 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Build the API dispatcher. Returns plain {status, headers, body} objects so any HTTP runtime can adapt it. */
export function createApi(db, { secureCookies = false, sampleTexts = null } = {}) {
  const routes = buildRoutes();
  async function dispatch({ method, path, query = {}, cookie = '', authorization = '', bodyText = '' }) {
    try {
      const route = routes.find(r => r.method === method && r.re.test(path));
      if (!route) {
        if (routes.some(r => r.re.test(path))) throw Object.assign(new Error('method_not_allowed'), { status: 405 });
        throw Object.assign(new Error('not_found'), { status: 404 });
      }
      const cookies = auth.parseCookies(cookie);
      const token = cookies[auth.COOKIE] || (authorization.startsWith('Bearer ') ? authorization.slice(7) : null);
      const user = auth.userFromToken(db, token);
      if (route.roles) {
        if (!user) throw Object.assign(new Error('unauthenticated'), { status: 401 });
        if (!route.roles.includes(user.role)) throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      const m = route.re.exec(path);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = null;
      if (MUTATING.has(method)) {
        if (!bodyText) body = {};
        else { try { body = JSON.parse(bodyText); } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); } }
      }
      const headers = {};
      const ctx = {
        db, user, token, params, body, query, sampleTexts,
        canSeeCost: auth.canSeeCost(db, user),
        setCookie: t => { headers['Set-Cookie'] = `${auth.COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secureCookies ? '; Secure' : ''}`; },
        clearCookie: () => { headers['Set-Cookie'] = `${auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; },
      };
      const out = await route.handler(ctx);
      if (out && out.__raw) {
        const { status = 200, headers: h = {}, body: raw } = out.__raw;
        return { status, headers: { 'Cache-Control': 'no-store', ...headers, ...h }, body: raw };
      }
      // Role redaction is applied here, to every JSON response, so it cannot be forgotten in a route.
      return json(200, redactFor(db, user, out), headers);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return json(status, { error: e.message, ...(e.check ? { check: e.check } : {}), ...(e.headers ? { headers: e.headers } : {}) });
    }
  }
  return { dispatch, routes };
}

function json(status, payload, headers = {}) {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }, body: JSON.stringify(payload ?? null) };
}

/** Local Node server: static files from public/ with SPA fallback, API via createApi. */
export async function createApp({ dbPath = process.env.DB_PATH || join(here, '..', 'data', 'pricing.sqlite'), secureCookies = process.env.SECURE_COOKIES === '1', log = () => {} } = {}) {
  const db = await Db.open(dbPath);
  const bootstrapPassword = auth.bootstrap(db, { adminPassword: process.env.ADMIN_PASSWORD });
  const api = createApi(db, { secureCookies, sampleTexts: async () => { const { readdirSync, readFileSync } = await import('node:fs'); const dir = join(here, '..', 'data', 'sample'); return Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => [f, readFileSync(join(dir, f), 'utf8')])); } });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const started = Date.now();
    try {
      if (url.pathname.startsWith('/api/')) {
        const bodyText = MUTATING.has(req.method) ? await readBody(req) : '';
        const r = await api.dispatch({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), cookie: req.headers.cookie || '', authorization: req.headers.authorization || '', bodyText });
        res.writeHead(r.status, { ...r.headers, 'Content-Length': Buffer.byteLength(r.body) });
        res.end(r.body);
      } else await handleStatic(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      const body = JSON.stringify({ error: e.message });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body);
    } finally { log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`); }
  }

  async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\/\\])+/, '');
    if (path === '/' || path === '\\') path = '/index.html';
    let file = join(PUBLIC, path);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    let s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { file = join(PUBLIC, 'index.html'); s = await stat(file); } // SPA fallback
    const ext = extname(file);
    const noCache = file.endsWith('index.html') || file.endsWith('sw.js');
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600', 'Content-Length': s.size,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(await readFile(file));
  }

  const server = createServer(handle);
  return { db, api, server, handle, bootstrapPassword, close: () => { server.close(); db.close(); } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('payload_too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
