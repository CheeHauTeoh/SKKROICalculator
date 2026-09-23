import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Convert JS values to something SQLite can bind. */
export function bindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}
function bindAll(args) {
  return args.map(a => (a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Date)
    ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, bindable(v)]))
    : bindable(a)));
}

export class Db {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
    this._cache = new Map();
    this._txDepth = 0;
  }
  stmt(sql) {
    let s = this._cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this._cache.set(sql, s); }
    return s;
  }
  run(sql, ...args) { return this.stmt(sql).run(...bindAll(args)); }
  get(sql, ...args) { return this.stmt(sql).get(...bindAll(args)) ?? null; }
  all(sql, ...args) { return this.stmt(sql).all(...bindAll(args)); }
  exec(sql) { return this.raw.exec(sql); }
  transaction(fn) {
    if (this._txDepth > 0) { this._txDepth++; try { return fn(); } finally { this._txDepth--; } } // nested: join the outer transaction
    this.raw.exec('BEGIN IMMEDIATE');
    this._txDepth = 1;
    try { const r = fn(); this.raw.exec('COMMIT'); return r; }
    catch (e) { this.raw.exec('ROLLBACK'); throw e; }
    finally { this._txDepth = 0; }
  }
  setting(key, fallback = null) {
    const r = this.get('SELECT value FROM settings WHERE key = ?', key);
    return r ? r.value : fallback;
  }
  setSetting(key, value) {
    this.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }
  close() { this.raw.close(); }
}

export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
