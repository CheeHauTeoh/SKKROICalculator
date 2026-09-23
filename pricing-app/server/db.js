// Database wrapper with one synchronous API over two drivers:
//  * node:sqlite  (local server, CLI, tests)          -> new Db(path)
//  * sql.js WASM  (serverless, DB file lives in a blob) -> Db.fromSqlJs(SQL, bytes)
import { SCHEMA } from './schema.js';

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

// ---- driver: node:sqlite -----------------------------------------------------------------------
async function nodeSqliteDriver(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return {
    prepare(sql) { const s = raw.prepare(sql); return { run: (...a) => s.run(...a), get: (...a) => s.get(...a) ?? null, all: (...a) => s.all(...a) }; },
    exec: sql => raw.exec(sql),
    close: () => raw.close(),
    export: () => { throw new Error('export not supported on node:sqlite driver'); },
  };
}

// ---- driver: sql.js ------------------------------------------------------------------------------
function sqlJsDriver(SQL, bytes) {
  const raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
  raw.exec('PRAGMA foreign_keys = ON;');
  const bindArgs = args => {
    if (!args.length) return undefined;
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) return Object.fromEntries(Object.entries(args[0]).map(([k, v]) => ['$' + k, v]));
    return args;
  };
  const rows = (sql, args) => { const st = raw.prepare(sql); try { st.bind(bindArgs(args) ?? []); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } };
  return {
    prepare(sql) {
      return {
        run: (...a) => { raw.run(sql, bindArgs(a)); const changes = raw.getRowsModified(); const id = raw.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]; return { changes, lastInsertRowid: id }; },
        get: (...a) => rows(sql, a)[0] ?? null,
        all: (...a) => rows(sql, a),
      };
    },
    exec: sql => raw.exec(sql),
    close: () => raw.close(),
    // sql.js export() closes and reopens the database internally, which resets pragmas.
    export: () => { const b = raw.export(); raw.exec('PRAGMA foreign_keys = ON;'); return b; },
  };
}

export class Db {
  /** Private: use Db.open(path) or Db.fromSqlJs(SQL, bytes). */
  constructor(driver) {
    this.driver = driver;
    this.driver.exec(SCHEMA);
    this._cache = new Map();
    this._txDepth = 0;
  }
  static async open(path = ':memory:') { return new Db(await nodeSqliteDriver(path)); }
  static fromSqlJs(SQL, bytes = null) { return new Db(sqlJsDriver(SQL, bytes)); }
  stmt(sql) {
    let s = this._cache.get(sql);
    if (!s) { s = this.driver.prepare(sql); this._cache.set(sql, s); }
    return s;
  }
  run(sql, ...args) { return this.stmt(sql).run(...bindAll(args)); }
  get(sql, ...args) { return this.stmt(sql).get(...bindAll(args)) ?? null; }
  all(sql, ...args) { return this.stmt(sql).all(...bindAll(args)); }
  exec(sql) { return this.driver.exec(sql); }
  transaction(fn) {
    if (this._txDepth > 0) { this._txDepth++; try { return fn(); } finally { this._txDepth--; } } // nested: join the outer transaction
    this.driver.exec('BEGIN IMMEDIATE');
    this._txDepth = 1;
    try { const r = fn(); this.driver.exec('COMMIT'); return r; }
    catch (e) { this.driver.exec('ROLLBACK'); throw e; }
    finally { this._txDepth = 0; }
  }
  setting(key, fallback = null) {
    const r = this.get('SELECT value FROM settings WHERE key = ?', key);
    return r ? r.value : fallback;
  }
  setSetting(key, value) {
    this.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }
  /** Serialised database bytes (sql.js driver only). */
  export() { const b = this.driver.export(); this._cache.clear(); return b; }
  close() { this.driver.close(); }
}

export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
