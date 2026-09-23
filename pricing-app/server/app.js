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
const MAX_BODY = 25 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export function createApp({ dbPath = process.env.DB_PATH || join(here, '..', 'data', 'pricing.sqlite'), secureCookies = process.env.SECURE_COOKIES === '1', log = () => {} } = {}) {
  const db = new Db(dbPath);
  const bootstrapPassword = auth.bootstrap(db, { adminPassword: process.env.ADMIN_PASSWORD });
  const routes = buildRoutes();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const started = Date.now();
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      sendJson(res, status, { error: e.message, ...(e.check ? { check: e.check } : {}), ...(e.headers ? { headers: e.headers } : {}) });
    } finally { log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`); }
  }

  async function handleApi(req, res, url) {
    const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!route) { if (routes.some(r => r.re.test(url.pathname))) throw Object.assign(new Error('method_not_allowed'), { status: 405 }); throw Object.assign(new Error('not_found'), { status: 404 }); }
    const cookies = auth.parseCookies(req.headers.cookie);
    const token = cookies[auth.COOKIE] || bearer(req);
    const user = auth.userFromToken(db, token);
    if (route.roles) {
      if (!user) throw Object.assign(new Error('unauthenticated'), { status: 401 });
      if (!route.roles.includes(user.role)) throw Object.assign(new Error('forbidden'), { status: 403 });
    }
    const m = route.re.exec(url.pathname);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req) : null;
    const ctx = {
      db, user, token, params, body, query: Object.fromEntries(url.searchParams), req, res,
      canSeeCost: auth.canSeeCost(db, user),
      setCookie: t => res.setHeader('Set-Cookie', `${auth.COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secureCookies ? '; Secure' : ''}`),
      clearCookie: () => res.setHeader('Set-Cookie', `${auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`),
    };
    const out = await route.handler(ctx);
    if (out && out.__raw) {
      const { status = 200, headers = {}, body: raw } = out.__raw;
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      res.end(raw);
      return;
    }
    // Role redaction is applied here, to every JSON response, so it cannot be forgotten in a route.
    sendJson(res, 200, redactFor(db, user, out));
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
    const noCache = ['/index.html', '/sw.js'].includes(path) || file.endsWith('index.html') || file.endsWith('sw.js');
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600', 'Content-Length': s.size,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(await readFile(file));
  }

  const server = createServer(handle);
  return { db, server, handle, bootstrapPassword, close: () => { server.close(); db.close(); } };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('payload_too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad_json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
