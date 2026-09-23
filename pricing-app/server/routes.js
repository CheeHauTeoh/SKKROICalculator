// All API routes. Handlers return a JSON-serialisable value; the server applies role redaction
// to every response for users who cannot see cost (see redact.js), so no route can leak cost.

import { randomUUID } from 'node:crypto';
import { now, today } from './db.js';
import * as auth from './auth.js';
import { audit, auditDiff } from './audit.js';
import * as imp from './importer.js';
import * as pricing from './pricing.js';
import { divideSen, formatSen } from './money.js';
import { toCsv } from './csv.js';
import { resetBusinessData, seedFromTexts } from './seed.js';

const ALL = ['salesperson', 'finance', 'owner'];
const MGMT = ['finance', 'owner'];
const OWNER = ['owner'];

const err = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
const int = (v, name) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); if (!Number.isInteger(n)) throw err(`${name}_must_be_integer_sen`); return n; };
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const str = v => (v === null || v === undefined ? null : String(v).trim());
const who = ctx => ctx.user.username;
const csvResponse = (filename, rows, cols) => ({ __raw: { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` }, body: '﻿' + toCsv(rows, cols) } });

export function buildRoutes() {
  const routes = [];
  const add = (method, path, roles, handler) => routes.push({ method, roles, handler, ...compile(path) });

  // ---- health (public, no secrets) --------------------------------------------------------
  add('GET', '/api/health', null, ctx => ({
    ok: true, time: now(),
    users: ctx.db.get('SELECT COUNT(*) c FROM users').c, products: ctx.db.get('SELECT COUNT(*) c FROM products').c,
    bootstrap_password_source: ctx.db.setting('bootstrap_password_source', 'unknown'),
    owner_password_reset_at: ctx.db.setting('owner_password_reset_at'),
  }));

  // ---- auth -------------------------------------------------------------------------------
  add('POST', '/api/auth/login', null, ctx => {
    const r = auth.login(ctx.db, ctx.body.username, ctx.body.password);
    if (!r) throw err('invalid_credentials', 401);
    ctx.setCookie(r.token);
    return { user: r.user };
  });
  add('POST', '/api/auth/logout', ALL, ctx => { auth.logout(ctx.db, ctx.token); ctx.clearCookie(); return { ok: true }; });
  add('GET', '/api/auth/me', ALL, ctx => ({ user: ctx.user, pricing_visibility: ctx.canSeeCost ? 'full' : 'sales' }));
  add('POST', '/api/auth/change-password', ALL, ctx => {
    const u = ctx.db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!auth.verifyPassword(ctx.body.current_password, u.password_hash)) throw err('invalid_credentials', 401);
    auth.changePassword(ctx.db, ctx.user.id, ctx.body.new_password);
    audit(ctx.db, { who: who(ctx), action: 'change_password', entity: 'users', entityId: ctx.user.id });
    return { ok: true };
  });

  // ---- reference data ---------------------------------------------------------------------
  add('GET', '/api/tiers', ALL, ctx => ctx.db.all('SELECT * FROM price_tiers ORDER BY sort, code'));
  add('PUT', '/api/tiers', MGMT, ctx => {
    for (const t of ctx.body.tiers || []) {
      const code = String(t.code || '').toUpperCase().trim();
      if (!/^[A-Z0-9_]{1,12}$/.test(code)) throw err('bad_tier_code');
      const before = ctx.db.get('SELECT * FROM price_tiers WHERE code = ?', code);
      ctx.db.run(`INSERT INTO price_tiers(code, name_zh, name_en, sort) VALUES (?, ?, ?, ?)
                  ON CONFLICT(code) DO UPDATE SET name_zh = excluded.name_zh, name_en = excluded.name_en, sort = excluded.sort`,
        code, str(t.name_zh) || code, str(t.name_en) || code, Number(t.sort) || 0);
      audit(ctx.db, { who: who(ctx), action: before ? 'update' : 'create', entity: 'price_tiers', entityId: code, oldValue: before, newValue: t });
    }
    return ctx.db.all('SELECT * FROM price_tiers ORDER BY sort, code');
  });
  add('GET', '/api/tier-rules', MGMT, ctx => ({
    rules: ctx.db.all('SELECT * FROM tier_rules ORDER BY customer_type, size_tier'),
    matrix: ctx.db.all(`SELECT COALESCE(customer_type,'') customer_type, COALESCE(size_tier,'') size_tier, COUNT(*) customers,
                        SUM(COALESCE(fy_value_sen,0)) fy_value_sen, SUM(price_tier_override) overrides,
                        GROUP_CONCAT(DISTINCT price_tier) current_tiers
                        FROM customers GROUP BY 1, 2 ORDER BY fy_value_sen DESC`),
  }));
  add('PUT', '/api/tier-rules', MGMT, ctx => {
    const rules = (ctx.body.rules || []).map(r => ({ customer_type: str(r.customer_type) || '*', size_tier: str(r.size_tier) || '*', price_tier: String(r.price_tier || '').toUpperCase() }));
    const tiers = new Set(ctx.db.all('SELECT code FROM price_tiers').map(t => t.code));
    for (const r of rules) if (!tiers.has(r.price_tier)) throw err(`unknown_tier:${r.price_tier}`);
    const before = ctx.db.all('SELECT * FROM tier_rules');
    ctx.db.transaction(() => {
      ctx.db.run('DELETE FROM tier_rules');
      for (const r of rules) ctx.db.run('INSERT OR REPLACE INTO tier_rules(customer_type, size_tier, price_tier) VALUES (?, ?, ?)', r.customer_type, r.size_tier, r.price_tier);
      audit(ctx.db, { who: who(ctx), action: 'replace', entity: 'tier_rules', entityId: '*', oldValue: before, newValue: rules });
    });
    return { rules };
  });
  add('POST', '/api/tier-rules/apply', MGMT, ctx => {
    let changed = 0;
    ctx.db.transaction(() => {
      for (const c of ctx.db.all('SELECT * FROM customers WHERE price_tier_override = 0')) {
        const t = imp.resolveTier(ctx.db, c) || ctx.db.setting('default_price_tier', 'STD');
        if (t !== c.price_tier) {
          ctx.db.run('UPDATE customers SET price_tier = ?, updated_at = ? WHERE customer_code = ?', t, now(), c.customer_code);
          audit(ctx.db, { who: who(ctx), action: 'apply_tier_rules', entity: 'customers', entityId: c.customer_code, field: 'price_tier', oldValue: c.price_tier, newValue: t });
          changed++;
        }
      }
    });
    return { changed };
  });
  add('GET', '/api/categories', ALL, ctx => ctx.db.all(`SELECT category, COUNT(*) products, SUM(is_core_80) core, SUM(COALESCE(fy_sales_value_sen,0)) fy_sales_value_sen FROM products GROUP BY category ORDER BY 4 DESC`));
  add('GET', '/api/settings', MGMT, ctx => Object.fromEntries(ctx.db.all('SELECT key, value FROM settings').map(r => [r.key, r.value])));
  add('PUT', '/api/settings', OWNER, ctx => {
    const allowed = ['salesperson_can_see_cost', 'default_price_tier', 'fy_label', 'default_floor_discount_pct'];
    for (const [k, v] of Object.entries(ctx.body || {})) {
      if (!allowed.includes(k)) throw err(`setting_not_allowed:${k}`);
      const old = ctx.db.setting(k);
      if (String(v) !== old) { ctx.db.setSetting(k, v); audit(ctx.db, { who: who(ctx), action: 'setting', entity: 'settings', entityId: k, oldValue: old, newValue: v }); }
    }
    return Object.fromEntries(ctx.db.all('SELECT key, value FROM settings').map(r => [r.key, r.value]));
  });

  // ---- products & prices ------------------------------------------------------------------
  add('GET', '/api/products', ALL, ctx => {
    const q = ctx.query.q ? `%${ctx.query.q}%` : null;
    const where = ['1=1'], args = [];
    if (q) { where.push('(item_code LIKE ? OR description LIKE ?)'); args.push(q, q); }
    if (ctx.query.core === '1') where.push('is_core_80 = 1');
    if (ctx.query.category) { where.push('category = ?'); args.push(ctx.query.category); }
    if (ctx.query.quality) { where.push('cost_data_quality = ?'); args.push(ctx.query.quality); }
    if (ctx.query.status) { where.push('status = ?'); args.push(ctx.query.status); }
    const limit = Math.min(Number(ctx.query.limit) || 2000, 5000);
    const rows = ctx.db.all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY is_core_80 DESC, COALESCE(fy_sales_value_sen,0) DESC, item_code LIMIT ?`, ...args, limit);
    const prices = groupPrices(pricing.currentPrices(ctx.db));
    return rows.map(p => decorate(ctx.db, p, prices.get(p.item_code) || {}));
  });
  add('GET', '/api/products/:code', ALL, ctx => {
    const p = ctx.db.get('SELECT * FROM products WHERE item_code = ?', ctx.params.code);
    if (!p) throw err('unknown_product', 404);
    const cur = groupPrices(pricing.currentPrices(ctx.db, p.item_code)).get(p.item_code) || {};
    return {
      ...decorate(ctx.db, p, cur),
      price_history: ctx.db.all('SELECT * FROM product_prices WHERE item_code = ? ORDER BY effective_from DESC, id DESC', p.item_code),
      field_prices: ctx.db.all(`SELECT f.*, c.customer_name FROM field_prices f LEFT JOIN customers c ON c.customer_code = f.customer_code
                                WHERE f.item_code = ? AND f.deleted = 0 ORDER BY f.captured_at DESC LIMIT 200`, p.item_code),
      market_refs: ctx.db.all('SELECT * FROM market_refs WHERE item_code = ? ORDER BY captured_at DESC', p.item_code),
      top_customers: ctx.db.all(`SELECT cp.customer_code, c.customer_name, c.price_tier, cp.fy_qty, cp.fy_value_sen FROM customer_products cp
                                 LEFT JOIN customers c ON c.customer_code = cp.customer_code WHERE cp.item_code = ? ORDER BY cp.fy_value_sen DESC LIMIT 15`, p.item_code),
    };
  });
  add('PATCH', '/api/products/:code', MGMT, ctx => {
    const patch = {};
    const b = ctx.body || {};
    for (const f of ['description', 'category', 'subcategory', 'brand', 'status', 'uom_purchase', 'uom_selling']) if (f in b) patch[f] = str(b[f]);
    for (const f of ['is_core_80', 'is_branded', 'no_purchase_confirmed']) if (f in b) patch[f] = b[f] ? 1 : 0;
    if ('uom_factor' in b) patch.uom_factor = num(b.uom_factor);
    if ('target_margin_pct' in b) patch.target_margin_pct = num(b.target_margin_pct);
    if ('verified_unit_cost_sen' in b) patch.verified_unit_cost_sen = int(b.verified_unit_cost_sen, 'verified_unit_cost_sen');
    const r = pricing.updateProduct(ctx.db, ctx.params.code, patch, who(ctx));
    const cur = groupPrices(pricing.currentPrices(ctx.db, ctx.params.code)).get(ctx.params.code) || {};
    return { changed: r.changed, product: decorate(ctx.db, r.product, cur) };
  });
  add('POST', '/api/prices', MGMT, ctx => {
    const b = ctx.body || {};
    const row = pricing.setPrice(ctx.db, { item_code: str(b.item_code), price_tier: String(b.price_tier || '').toUpperCase(), list_price_sen: int(b.list_price_sen, 'list_price_sen'),
      floor_price_sen: int(b.floor_price_sen, 'floor_price_sen'), effective_from: str(b.effective_from) || null, who: who(ctx), note: str(b.note) });
    return { changed: !!row, price: row };
  });
  add('POST', '/api/prices/bulk', MGMT, ctx => pricing.bulk(ctx.db, { ...ctx.body, who: who(ctx) }));
  add('GET', '/api/prices/history', MGMT, ctx => ctx.db.all(`SELECT pp.*, p.description FROM product_prices pp JOIN products p ON p.item_code = pp.item_code
      WHERE (? IS NULL OR pp.item_code = ?) ORDER BY pp.created_at DESC LIMIT 500`, ctx.query.item_code || null, ctx.query.item_code || null));
  add('GET', '/api/prices/at', MGMT, ctx => {
    // "What were we charging on <date>?"
    const d = ctx.query.date || today();
    return ctx.db.all(`SELECT pp.*, p.description FROM product_prices pp JOIN products p ON p.item_code = pp.item_code
      WHERE pp.effective_from <= ? AND (pp.effective_to IS NULL OR pp.effective_to > ?) AND (? IS NULL OR pp.item_code = ?) ORDER BY pp.item_code, pp.price_tier`, d, d, ctx.query.item_code || null, ctx.query.item_code || null);
  });

  // ---- UOM reconciliation (milestone 1) ---------------------------------------------------
  add('GET', '/api/uom/progress', MGMT, ctx => pricing.uomProgress(ctx.db));
  add('GET', '/api/uom/queue', MGMT, ctx => {
    const scope = ctx.query.scope || 'core_suspect';
    const where = ['1=1'], args = [];
    if (scope.startsWith('core')) where.push('is_core_80 = 1');
    if (scope.endsWith('suspect')) where.push("cost_data_quality = 'UOM_SUSPECT'");
    if (scope.endsWith('nopurchase')) where.push("cost_data_quality = 'NO_PURCHASE_DATA'");
    if (scope.endsWith('ok')) where.push("cost_data_quality = 'OK'");
    if (ctx.query.status === 'open') where.push('verified_unit_cost_sen IS NULL AND no_purchase_confirmed = 0');
    if (ctx.query.status === 'done') where.push('(verified_unit_cost_sen IS NOT NULL OR no_purchase_confirmed = 1)');
    if (ctx.query.q) { where.push('(item_code LIKE ? OR description LIKE ?)'); args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`); }
    return ctx.db.all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY COALESCE(fy_sales_value_sen,0) DESC LIMIT 2000`, ...args).map(p => ({
      ...p, suggested_cost_sen: p.uom_factor ? divideSen(p.implied_unit_cost_sen, p.uom_factor) : null,
      done: p.verified_unit_cost_sen !== null || p.no_purchase_confirmed === 1,
    }));
  });

  // ---- customers & visit prep -------------------------------------------------------------
  add('GET', '/api/customers', ALL, ctx => {
    const where = ['1=1'], args = [];
    if (ctx.query.q) { where.push('(customer_code LIKE ? OR customer_name LIKE ?)'); args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`); }
    if (ctx.query.salesperson) { where.push('salesperson = ?'); args.push(ctx.query.salesperson); }
    return ctx.db.all(`SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY COALESCE(fy_value_sen,0) DESC LIMIT 2000`, ...args);
  });
  add('GET', '/api/customers/:code/visit', ALL, ctx => visitPrep(ctx.db, ctx.params.code));
  add('PATCH', '/api/customers/:code', MGMT, ctx => {
    const before = ctx.db.get('SELECT * FROM customers WHERE customer_code = ?', ctx.params.code);
    if (!before) throw err('unknown_customer', 404);
    const after = { ...before };
    if ('price_tier' in ctx.body) {
      const t = String(ctx.body.price_tier || '').toUpperCase();
      if (!ctx.db.get('SELECT 1 FROM price_tiers WHERE code = ?', t)) throw err('unknown_tier');
      after.price_tier = t; after.price_tier_override = ctx.body.price_tier_override === false ? 0 : 1;
    }
    if ('price_tier_override' in ctx.body && !ctx.body.price_tier_override) { after.price_tier_override = 0; after.price_tier = imp.resolveTier(ctx.db, after) || ctx.db.setting('default_price_tier', 'STD'); }
    for (const f of ['customer_type', 'size_tier', 'salesperson', 'status']) if (f in ctx.body) after[f] = str(ctx.body[f]);
    const changed = auditDiff(ctx.db, { who: who(ctx), entity: 'customers', entityId: before.customer_code, before, after, fields: ['price_tier', 'price_tier_override', 'customer_type', 'size_tier', 'salesperson', 'status'] });
    if (changed.length) ctx.db.run(`UPDATE customers SET price_tier = ?, price_tier_override = ?, customer_type = ?, size_tier = ?, salesperson = ?, status = ?, updated_at = ? WHERE customer_code = ?`,
      after.price_tier, after.price_tier_override, after.customer_type, after.size_tier, after.salesperson, after.status, now(), before.customer_code);
    return { changed, customer: ctx.db.get('SELECT * FROM customers WHERE customer_code = ?', before.customer_code) };
  });

  // ---- offline snapshot -------------------------------------------------------------------
  add('GET', '/api/sync/snapshot', ALL, ctx => snapshot(ctx));

  // ---- field intelligence -----------------------------------------------------------------
  add('POST', '/api/field-prices/batch', ALL, ctx => {
    const captures = Array.isArray(ctx.body?.captures) ? ctx.body.captures : [];
    const accepted = [], rejected = [];
    const mine = ctx.user.salesperson_code || ctx.user.username;
    ctx.db.transaction(() => {
      for (const c of captures) {
        try {
          const id = /^[0-9a-f-]{36}$/i.test(c.id || '') ? c.id.toLowerCase() : null;
          if (!id) throw err('bad_id');
          const item = str(c.item_code);
          if (!item || !ctx.db.get('SELECT 1 FROM products WHERE item_code = ?', item)) throw err('unknown_product');
          const outcome = ['won', 'lost', 'quoted'].includes(c.outcome) ? c.outcome : 'quoted';
          const our = int(c.our_price_sen, 'our_price_sen'), comp = int(c.competitor_price_sen, 'competitor_price_sen');
          if (our === null && comp === null) throw err('no_price');
          const salesperson = ctx.user.role === 'salesperson' ? mine : (str(c.salesperson) || mine);
          const existing = ctx.db.get('SELECT * FROM field_prices WHERE id = ?', id);
          if (existing && ctx.user.role === 'salesperson' && existing.salesperson !== mine) throw err('not_yours', 403);
          const row = { id, captured_at: str(c.captured_at) || now(), salesperson, customer_code: str(c.customer_code) || null, item_code: item, our_price_sen: our,
            competitor_price_sen: comp, competitor_name: str(c.competitor_name) || null, outcome, note: str(c.note) || null,
            client_updated_at: str(c.client_updated_at) || now(), synced_at: now(), deleted: c.deleted ? 1 : 0 };
          // client wins: the latest client_updated_at overwrites
          if (!existing || (row.client_updated_at >= (existing.client_updated_at || ''))) {
            const cols = Object.keys(row);
            ctx.db.run(`INSERT OR REPLACE INTO field_prices (${cols.join(',')}) VALUES (${cols.map(k => '$' + k).join(',')})`, row);
          }
          accepted.push(id);
        } catch (e) { rejected.push({ id: c.id, error: e.message }); }
      }
    });
    return { accepted, rejected, server_time: now() };
  });
  add('GET', '/api/field-prices', ALL, ctx => {
    const where = ['f.deleted = 0'], args = [];
    if (ctx.user.role === 'salesperson') { where.push('f.salesperson = ?'); args.push(ctx.user.salesperson_code || ctx.user.username); }
    if (ctx.query.item_code) { where.push('f.item_code = ?'); args.push(ctx.query.item_code); }
    if (ctx.query.customer_code) { where.push('f.customer_code = ?'); args.push(ctx.query.customer_code); }
    return ctx.db.all(`SELECT f.*, p.description, c.customer_name FROM field_prices f LEFT JOIN products p ON p.item_code = f.item_code
                       LEFT JOIN customers c ON c.customer_code = f.customer_code WHERE ${where.join(' AND ')} ORDER BY f.captured_at DESC LIMIT ?`, ...args, Math.min(Number(ctx.query.limit) || 300, 2000));
  });

  // ---- market reference (branded only) ----------------------------------------------------
  add('POST', '/api/market-refs', MGMT, ctx => {
    const b = ctx.body || {};
    const p = ctx.db.get('SELECT * FROM products WHERE item_code = ?', str(b.item_code));
    if (!p) throw err('unknown_product', 404);
    if (!p.is_branded) throw err('market_reference_only_for_branded_skus');
    if (!str(b.source_name) || !/^https?:\/\//.test(String(b.source_url || ''))) throw err('source_name_and_url_required');
    const price = int(b.price_sen, 'price_sen');
    if (price === null) throw err('price_required');
    const r = ctx.db.run('INSERT INTO market_refs(item_code, source_name, source_url, price_sen, unit, captured_at, captured_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.item_code, str(b.source_name), str(b.source_url), price, str(b.unit) || p.uom_selling || '', str(b.captured_at) || today(), who(ctx));
    audit(ctx.db, { who: who(ctx), action: 'create', entity: 'market_refs', entityId: r.lastInsertRowid, newValue: b });
    return ctx.db.get('SELECT * FROM market_refs WHERE id = ?', r.lastInsertRowid);
  });
  add('DELETE', '/api/market-refs/:id', MGMT, ctx => {
    const before = ctx.db.get('SELECT * FROM market_refs WHERE id = ?', Number(ctx.params.id));
    if (!before) throw err('not_found', 404);
    ctx.db.run('DELETE FROM market_refs WHERE id = ?', before.id);
    audit(ctx.db, { who: who(ctx), action: 'delete', entity: 'market_refs', entityId: before.id, oldValue: before });
    return { ok: true };
  });

  // ---- price intelligence -----------------------------------------------------------------
  add('GET', '/api/intel/summary', MGMT, ctx => intelSummary(ctx.db, ctx.query));

  // ---- import -----------------------------------------------------------------------------
  add('POST', '/api/import/check', MGMT, ctx => { const { _rows, ...r } = imp.check(ctx.db, { kind: ctx.body.kind, text: ctx.body.text, filename: ctx.body.filename }); return r; });
  add('POST', '/api/import/commit', MGMT, ctx => imp.commit(ctx.db, { kind: ctx.body.kind, text: ctx.body.text, filename: ctx.body.filename, who: who(ctx), force: !!ctx.body.force }));
  add('GET', '/api/imports', MGMT, ctx => ({ imports: ctx.db.all('SELECT * FROM imports ORDER BY imported_at DESC LIMIT 100').map(r => ({ ...r, summary: safeJson(r.summary) })), reconcile: imp.reconcileTotal(ctx.db) }));

  // ---- audit ------------------------------------------------------------------------------
  add('GET', '/api/audit', MGMT, ctx => {
    const where = ['1=1'], args = [];
    if (ctx.query.entity) { where.push('entity = ?'); args.push(ctx.query.entity); }
    if (ctx.query.entity_id) { where.push('entity_id = ?'); args.push(ctx.query.entity_id); }
    if (ctx.query.who) { where.push('who = ?'); args.push(ctx.query.who); }
    return ctx.db.all(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...args, Math.min(Number(ctx.query.limit) || 200, 2000));
  });

  // ---- users (owner) ----------------------------------------------------------------------
  add('GET', '/api/users', OWNER, ctx => ctx.db.all('SELECT id, username, display_name, role, salesperson_code, must_change_password, active, created_at FROM users ORDER BY role, username'));
  add('POST', '/api/users', OWNER, ctx => {
    const b = ctx.body || {};
    const username = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(username)) throw err('bad_username');
    if (!auth.ROLES.includes(b.role)) throw err('bad_role');
    if (String(b.password || '').length < 6) throw err('password_too_short');
    const r = ctx.db.run(`INSERT INTO users(username, display_name, role, salesperson_code, password_hash, must_change_password, active, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
      username, str(b.display_name) || username, b.role, str(b.salesperson_code) || null, auth.hashPassword(b.password), now());
    audit(ctx.db, { who: who(ctx), action: 'create', entity: 'users', entityId: r.lastInsertRowid, newValue: { username, role: b.role } });
    return ctx.db.get('SELECT id, username, display_name, role, salesperson_code, active FROM users WHERE id = ?', r.lastInsertRowid);
  });
  add('PATCH', '/api/users/:id', OWNER, ctx => {
    const u = ctx.db.get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u) throw err('not_found', 404);
    const b = ctx.body || {};
    const after = { ...u };
    if ('display_name' in b) after.display_name = str(b.display_name) || u.display_name;
    if ('role' in b) { if (!auth.ROLES.includes(b.role)) throw err('bad_role'); after.role = b.role; }
    if ('salesperson_code' in b) after.salesperson_code = str(b.salesperson_code) || null;
    if ('active' in b) after.active = b.active ? 1 : 0;
    if (u.id === ctx.user.id && (after.role !== 'owner' || !after.active)) throw err('cannot_demote_self');
    auditDiff(ctx.db, { who: who(ctx), entity: 'users', entityId: u.id, before: u, after, fields: ['display_name', 'role', 'salesperson_code', 'active'] });
    ctx.db.run('UPDATE users SET display_name = ?, role = ?, salesperson_code = ?, active = ? WHERE id = ?', after.display_name, after.role, after.salesperson_code, after.active, u.id);
    if (b.password) { auth.changePassword(ctx.db, u.id, b.password); ctx.db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', u.id); audit(ctx.db, { who: who(ctx), action: 'reset_password', entity: 'users', entityId: u.id }); }
    return ctx.db.get('SELECT id, username, display_name, role, salesperson_code, must_change_password, active FROM users WHERE id = ?', u.id);
  });

  // ---- owner: wipe business data (keeps logins and settings), optionally reload the sample ----
  add('POST', '/api/admin/reset', OWNER, async ctx => {
    const u = ctx.db.get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!auth.verifyPassword(ctx.body?.password, u.password_hash)) throw err('invalid_credentials', 401);
    if (ctx.body?.confirm !== 'RESET') throw err('confirm_required');
    resetBusinessData(ctx.db);
    let seeded = null;
    if (ctx.body?.seed_sample && ctx.sampleTexts) seeded = seedFromTexts(ctx.db, await ctx.sampleTexts(), { who: who(ctx) });
    audit(ctx.db, { who: who(ctx), action: 'reset_business_data', entity: 'db', entityId: '*', newValue: { seed_sample: !!ctx.body?.seed_sample } });
    return { ok: true, seeded };
  });

  // ---- exports (management only; these contain cost) --------------------------------------
  add('GET', '/api/export/products.csv', MGMT, ctx => {
    const prices = groupPrices(pricing.currentPrices(ctx.db));
    const tiers = ctx.db.all('SELECT code FROM price_tiers ORDER BY sort').map(t => t.code);
    const rows = ctx.db.all('SELECT * FROM products ORDER BY is_core_80 DESC, item_code').map(p => {
      const d = decorate(ctx.db, p, prices.get(p.item_code) || {});
      const o = { item_code: p.item_code, description: p.description, category: p.category, subcategory: p.subcategory, is_core_80: p.is_core_80, is_branded: p.is_branded,
        uom_purchase: p.uom_purchase, uom_selling: p.uom_selling, uom_factor: p.uom_factor, cost_data_quality: p.cost_data_quality,
        implied_unit_cost: formatSen(p.implied_unit_cost_sen, { grouping: false }), implied_unit_price: formatSen(p.implied_unit_price_sen, { grouping: false }),
        verified_unit_cost: formatSen(p.verified_unit_cost_sen, { grouping: false }), cost_basis: d.cost.basis, target_margin_pct: p.target_margin_pct,
        fy_sales_qty: p.fy_sales_qty, fy_sales_value: formatSen(p.fy_sales_value_sen, { grouping: false }) };
      for (const t of tiers) { o[`list_${t}`] = formatSen(d.prices[t]?.list_price_sen, { grouping: false }); o[`floor_${t}`] = formatSen(d.prices[t]?.floor_price_sen, { grouping: false }); }
      o.margin_at_list_pct = d.margin_pct;
      return o;
    });
    return csvResponse(`products_${today()}.csv`, rows);
  });
  add('GET', '/api/export/field-prices.csv', MGMT, ctx => csvResponse(`field_prices_${today()}.csv`,
    ctx.db.all(`SELECT f.id, f.captured_at, f.salesperson, f.customer_code, c.customer_name, f.item_code, p.description, f.our_price_sen, f.competitor_price_sen, f.competitor_name, f.outcome, f.note
                FROM field_prices f LEFT JOIN customers c ON c.customer_code = f.customer_code LEFT JOIN products p ON p.item_code = f.item_code WHERE f.deleted = 0 ORDER BY f.captured_at DESC`)
      .map(r => ({ ...r, our_price: formatSen(r.our_price_sen, { grouping: false }), competitor_price: formatSen(r.competitor_price_sen, { grouping: false }), our_price_sen: undefined, competitor_price_sen: undefined }))));
  add('GET', '/api/export/audit.csv', MGMT, ctx => csvResponse(`audit_${today()}.csv`, ctx.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 20000')));

  return routes;
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function compile(path) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^\\/]+)'; }) + '$');
  return { re, keys };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

function groupPrices(rows) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r.item_code)) m.set(r.item_code, {}); m.get(r.item_code)[r.price_tier] = r; }
  return m;
}

/** Product + current prices + cost basis + margin at default-tier list price. Sensitive keys are stripped later for salespeople. */
function decorate(db, p, prices) {
  const def = db.setting('default_price_tier', 'STD');
  const cost = pricing.costBasis(p);
  const std = prices[def];
  const { margin_pct } = pricing.marginAt(p, std ? std.list_price_sen : null);
  const floorMargin = pricing.marginAt(p, std ? std.floor_price_sen : null).margin_pct;
  return { ...p, prices, cost, margin_pct, floor_margin_pct: floorMargin, cost_verified: cost.basis === 'verified', cost_not_verified: cost.basis === null };
}

function visitPrep(db, code) {
  const customer = db.get('SELECT * FROM customers WHERE customer_code = ?', code);
  if (!customer) throw err('unknown_customer', 404);
  const tier = customer.price_tier || db.setting('default_price_tier', 'STD');
  const priceFor = item => pricing.priceForTier(db, item, tier);
  const regular = db.all(`SELECT cp.item_code, p.description, p.category, cp.fy_qty, cp.fy_value_sen FROM customer_products cp JOIN products p ON p.item_code = cp.item_code
                          WHERE cp.customer_code = ? ORDER BY cp.fy_value_sen DESC LIMIT 40`, code).map(r => ({ ...r, price: priceFor(r.item_code) }));
  const own = new Set(regular.map(r => r.item_code));
  const gaps = db.all(`SELECT g.item_code, p.description, p.category, g.peer_penetration_pct, g.estimated_annual_value_sen FROM crosssell_gaps g JOIN products p ON p.item_code = g.item_code
                       WHERE g.customer_code = ? ORDER BY g.estimated_annual_value_sen DESC LIMIT 20`, code).map(r => ({ ...r, price: priceFor(r.item_code) }));
  const bundles = db.all(`SELECT b.bundle_id, b.item_code, p.description, p.category, b.support_pct, b.lift, b.median_annual_value_sen FROM bundles b JOIN products p ON p.item_code = b.item_code
                          WHERE b.customer_type = ? ORDER BY b.lift DESC, b.support_pct DESC LIMIT 40`, customer.customer_type || '').filter(b => !own.has(b.item_code)).map(r => ({ ...r, price: priceFor(r.item_code) }));
  const recent = db.all('SELECT * FROM field_prices WHERE customer_code = ? AND deleted = 0 ORDER BY captured_at DESC LIMIT 10', code);
  return { customer, tier, regular, gaps, bundles, recent_captures: recent };
}

function snapshot(ctx) {
  const db = ctx.db;
  const sp = ctx.user.role === 'salesperson' ? (ctx.user.salesperson_code || ctx.user.username) : null;
  const custWhere = sp ? 'WHERE salesperson = ? OR ? IS NULL' : 'WHERE 1=1';
  const custArgs = sp ? [sp, sp] : [];
  const customers = db.all(`SELECT customer_code, customer_name, agent_code, salesperson, customer_type, buying_breadth, size_tier, price_tier, status, fy_value_sen FROM customers ${custWhere} ORDER BY COALESCE(fy_value_sen,0) DESC`, ...custArgs);
  const codes = customers.map(c => c.customer_code);
  const inList = codes.length ? `(${codes.map(() => '?').join(',')})` : '(NULL)';
  return {
    version: now(),
    user: ctx.user,
    settings: { default_price_tier: db.setting('default_price_tier', 'STD'), fy_label: db.setting('fy_label', 'FY2025') },
    tiers: db.all('SELECT * FROM price_tiers ORDER BY sort, code'),
    products: db.all(`SELECT item_code, description, category, subcategory, brand, is_core_80, is_branded, uom_selling, status FROM products WHERE status = 'active' ORDER BY is_core_80 DESC, item_code`),
    prices: db.all('SELECT item_code, price_tier, list_price_sen, floor_price_sen, effective_from FROM product_prices WHERE effective_to IS NULL'),
    customers,
    customer_products: db.all(`SELECT customer_code, item_code, fy_qty, fy_value_sen FROM (
        SELECT cp.*, ROW_NUMBER() OVER (PARTITION BY customer_code ORDER BY fy_value_sen DESC) rn FROM customer_products cp WHERE customer_code IN ${inList}) WHERE rn <= 40`, ...codes),
    crosssell: db.all(`SELECT customer_code, item_code, peer_penetration_pct, estimated_annual_value_sen FROM crosssell_gaps WHERE customer_code IN ${inList}`, ...codes),
    bundles: db.all('SELECT bundle_id, customer_type, item_code, support_pct, lift, median_annual_value_sen FROM bundles'),
    all_customers_count: db.get('SELECT COUNT(*) c FROM customers').c,
  };
}

function intelSummary(db, query) {
  const def = db.setting('default_price_tier', 'STD');
  const prices = groupPrices(pricing.currentPrices(db));
  const fp = new Map(db.all(`SELECT item_code, COUNT(*) n, MIN(competitor_price_sen) min_sen, MAX(competitor_price_sen) max_sen, AVG(competitor_price_sen) avg_sen,
                               MAX(captured_at) last_at, SUM(outcome = 'won') won, SUM(outcome = 'lost') lost
                               FROM field_prices WHERE deleted = 0 AND competitor_price_sen IS NOT NULL GROUP BY item_code`).map(r => [r.item_code, r]));
  const mr = new Map();
  for (const r of db.all('SELECT * FROM market_refs ORDER BY captured_at DESC')) if (!mr.has(r.item_code)) mr.set(r.item_code, r);
  const where = ['1=1'], args = [];
  if (query.core === '1') where.push('is_core_80 = 1');
  if (query.category) { where.push('category = ?'); args.push(query.category); }
  const rows = db.all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY is_core_80 DESC, COALESCE(fy_sales_value_sen,0) DESC`, ...args).map(p => {
    const d = decorate(db, p, prices.get(p.item_code) || {});
    const f = fp.get(p.item_code) || null;
    const m = mr.get(p.item_code) || null;
    const std = d.prices[def] || null;
    const above_all_competitors = !!(f && std && std.list_price_sen > f.max_sen);
    const floor_above_all_competitors = !!(f && std && std.floor_price_sen > f.max_sen);
    return { item_code: p.item_code, description: p.description, category: p.category, is_core_80: p.is_core_80, is_branded: p.is_branded, fy_sales_value_sen: p.fy_sales_value_sen,
      list_price_sen: std?.list_price_sen ?? null, floor_price_sen: std?.floor_price_sen ?? null, cost: d.cost, margin_pct: d.margin_pct,
      field: f ? { ...f, avg_sen: Math.round(f.avg_sen) } : null, market: m, above_all_competitors, floor_above_all_competitors };
  });
  if (query.only === 'flagged') return rows.filter(r => r.above_all_competitors);
  if (query.only === 'captured') return rows.filter(r => r.field || r.market);
  return rows;
}

export { visitPrep, snapshot, decorate };
export const newId = () => randomUUID();
