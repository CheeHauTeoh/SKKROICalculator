// CSV import for seed files and UBS exports.
//
// Principles:
//  * Idempotent: re-importing the same file changes nothing (tracked by sha256 + merge-by-key).
//  * Evidence vs. truth: imports refresh imported evidence (sales/purchase totals, implied unit
//    figures, quality flag) and descriptive fields. They never overwrite human-entered fields
//    (uom_*, verified cost, target margin, tier override) once those are set, and never touch
//    product_prices, field_prices, market_refs or audit_log.
//  * Money is parsed as integer sen from the text; quantities as numbers.

import { createHash } from 'node:crypto';
import { parseCsv } from './csv.js';
import { parseSen, parseNumber, parseBool, divideSen, marginPct } from './money.js';
import { now } from './db.js';
import { ensureSalespersonUser } from './auth.js';
import { audit } from './audit.js';

export const QUALITY = ['OK', 'UOM_SUSPECT', 'NO_PURCHASE_DATA'];

const A = (...xs) => xs; // alias list helper

export const KINDS = {
  products: {
    label: 'seed_products / product master',
    required: ['item_code'],
    fields: {
      item_code: A('item_code', 'itemcode', 'item', 'code', 'sku', 'stock_code', 'item_no', 'product_code', 'stockcode'),
      description: A('description', 'desc', 'item_name', 'name', 'product_name', 'item_description'),
      category: A('category', 'cat', 'group', 'product_group'),
      subcategory: A('subcategory', 'sub_category', 'subcat', 'sub_group'),
      brand: A('brand', 'brand_name'),
      is_core_80: A('is_core_80', 'core_80', 'is_core', 'core', 'core80', 'is_core80'),
      is_branded: A('is_branded', 'branded', 'brand_flag'),
      status: A('status', 'active'),
      uom_purchase: A('uom_purchase', 'purchase_uom', 'buy_uom', 'uom_buy', 'purchase_unit'),
      uom_selling: A('uom_selling', 'selling_uom', 'sell_uom', 'uom_sell', 'selling_unit', 'sales_uom'),
      uom_factor: A('uom_factor', 'factor', 'conversion_factor', 'pack_size', 'units_per_purchase_unit'),
      uom_purchase_hint: A('uom_purchase_hint', 'purchase_uom_raw', 'purchase_unit_raw', 'purchase_uom_text'),
      uom_selling_hint: A('uom_selling_hint', 'selling_uom_raw', 'sales_uom_raw', 'uom', 'unit', 'selling_uom_text'),
      fy_sales_qty: A('fy_sales_qty', 'sales_qty', 'fy_qty', 'qty_sold', 'sales_quantity', 'qty_sales', 'sold_qty', 'total_qty'),
      fy_sales_value: A('fy_sales_value', 'sales_value', 'fy_value', 'value_sold', 'total_sales', 'sales_amount', 'sales_rm', 'total_value', 'value', 'revenue', 'fy_sales'),
      fy_purchase_qty: A('fy_purchase_qty', 'purchase_qty', 'qty_purchased', 'purchase_quantity', 'qty_purchase', 'bought_qty'),
      fy_purchase_value: A('fy_purchase_value', 'purchase_value', 'value_purchased', 'purchase_amount', 'purchase_rm', 'total_purchases', 'fy_purchases', 'cost_value'),
      implied_unit_cost: A('implied_unit_cost', 'unit_cost', 'implied_cost', 'avg_unit_cost', 'avg_cost'),
      implied_unit_price: A('implied_unit_price', 'unit_price', 'implied_price', 'avg_unit_price', 'avg_price', 'avg_selling_price'),
      implied_margin_pct: A('implied_margin_pct', 'implied_margin', 'margin_pct', 'margin', 'gross_margin_pct', 'gm_pct'),
      cost_data_quality: A('cost_data_quality', 'quality', 'data_quality', 'cost_quality', 'quality_flag'),
      target_margin_pct: A('target_margin_pct', 'target_margin'),
      verified_unit_cost: A('verified_unit_cost', 'verified_cost'),
    },
  },
  customers: {
    label: 'seed_customers / customer master',
    required: ['customer_code'],
    fields: {
      customer_code: A('customer_code', 'cust_code', 'customer', 'account', 'account_code', 'code', 'debtor_code', 'customer_id'),
      customer_name: A('customer_name', 'name', 'cust_name', 'customer_desc', 'company', 'debtor_name'),
      agent_code: A('agent_code', 'agent'),
      salesperson: A('salesperson', 'sales_person', 'salesman', 'rep', 'sales_rep', 'sales'),
      customer_type: A('customer_type', 'type', 'cust_type', 'segment', 'channel'),
      buying_breadth: A('buying_breadth', 'breadth', 'sku_count', 'n_skus', 'skus'),
      size_tier: A('size_tier', 'size', 'tier_size', 'size_band'),
      price_tier: A('price_tier', 'tier', 'pricing_tier', 'price_level'),
      status: A('status', 'active'),
      fy_value: A('fy_value', 'fy_sales_value', 'annual_value', 'sales_value', 'total_value', 'value', 'revenue', 'fy_sales'),
    },
  },
  bundles: {
    label: 'seed_bundles / basket analysis by customer type',
    required: ['bundle_id', 'customer_type', 'item_code'],
    fields: {
      bundle_id: A('bundle_id', 'bundle', 'id', 'rule_id', 'basket_id'),
      customer_type: A('customer_type', 'type', 'segment', 'cust_type'),
      item_code: A('item_code', 'item', 'sku', 'code', 'product_code'),
      support_pct: A('support_pct', 'support', 'support_percent', 'penetration_pct'),
      lift: A('lift'),
      median_annual_value: A('median_annual_value', 'median_value', 'median_annual', 'median_rm'),
    },
  },
  crosssell: {
    label: 'seed_crosssell / gaps per customer',
    required: ['customer_code', 'item_code'],
    fields: {
      customer_code: A('customer_code', 'customer', 'cust_code', 'account'),
      item_code: A('item_code', 'item', 'sku', 'code', 'product_code'),
      peer_penetration_pct: A('peer_penetration_pct', 'peer_penetration', 'penetration_pct', 'penetration', 'peer_pct'),
      estimated_annual_value: A('estimated_annual_value', 'est_annual_value', 'estimated_value', 'est_value', 'opportunity_value', 'value'),
    },
  },
  sales: {
    label: 'UBS sales export (item x customer)',
    required: ['item_code', 'customer_code'],
    fields: {
      item_code: A('item_code', 'item', 'sku', 'code', 'stock_code', 'product_code', 'itemcode'),
      customer_code: A('customer_code', 'customer', 'cust_code', 'account', 'debtor_code', 'debtor'),
      description: A('description', 'desc', 'item_name', 'item_description'),
      customer_name: A('customer_name', 'debtor_name', 'name'),
      qty: A('qty', 'quantity', 'fy_qty', 'sales_qty', 'qty_sold'),
      value: A('value', 'amount', 'fy_value', 'sales_value', 'net_amount', 'total', 'sales_rm', 'amount_rm'),
      uom: A('uom', 'unit'),
      date: A('date', 'doc_date', 'invoice_date', 'trans_date'),
    },
  },
  purchases: {
    label: 'UBS purchase export (item)',
    required: ['item_code'],
    fields: {
      item_code: A('item_code', 'item', 'sku', 'code', 'stock_code', 'product_code', 'itemcode'),
      description: A('description', 'desc', 'item_name', 'item_description'),
      supplier: A('supplier', 'creditor', 'vendor', 'supplier_code'),
      qty: A('qty', 'quantity', 'purchase_qty', 'qty_purchased'),
      value: A('value', 'amount', 'purchase_value', 'cost', 'net_amount', 'total', 'amount_rm'),
      uom: A('uom', 'unit'),
      date: A('date', 'doc_date', 'invoice_date', 'trans_date'),
    },
  },
};

export function normalizeHeader(h) {
  return String(h).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function stripDecor(h) {
  // "fy2025_sales_value_rm" -> "sales_value"; "total_sales_value_rm" -> "sales_value"
  return h.replace(/^(fy\d*_|total_)/, '').replace(/_(rm|myr|sen)$/, '').replace(/^(fy\d*_)/, '');
}

/** Map canonical field -> actual CSV header for a kind. */
export function detectMapping(kind, headers) {
  const spec = KINDS[kind];
  if (!spec) throw Object.assign(new Error(`unknown import kind: ${kind}`), { status: 400 });
  const norm = headers.map(h => ({ raw: h, n: normalizeHeader(h), s: stripDecor(normalizeHeader(h)) }));
  const mapping = {};
  const used = new Set();
  const pick = (field, pred) => {
    if (mapping[field]) return;
    const hit = norm.find(h => !used.has(h.raw) && pred(h));
    if (hit) { mapping[field] = hit.raw; used.add(hit.raw); }
  };
  // pass 1: exact alias; pass 2: alias after stripping fy/total prefixes and currency suffix
  for (const [field, aliases] of Object.entries(spec.fields)) pick(field, h => h.n === field || aliases.includes(h.n));
  for (const [field, aliases] of Object.entries(spec.fields)) pick(field, h => h.s === field || aliases.includes(h.s));
  const missing = spec.required.filter(f => !mapping[f]);
  const unmapped = headers.filter(h => !used.has(h));
  return { mapping, missing, unmapped };
}

/** Guess the kind from headers (used when the caller does not say). */
export function guessKind(headers) {
  let best = null;
  for (const kind of Object.keys(KINDS)) {
    const { mapping, missing } = detectMapping(kind, headers);
    const score = Object.keys(mapping).length - missing.length * 10;
    if (!best || score > best.score) best = { kind, score, missing };
  }
  return best && best.missing.length === 0 ? best.kind : null;
}

export function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

// ---------------------------------------------------------------------------------------------
// Row canonicalisation
// ---------------------------------------------------------------------------------------------

function canonRows(kind, csv, mapping) {
  const has = f => Boolean(mapping[f]);
  const get = (r, f) => (has(f) ? r[mapping[f]] : undefined);
  const warnings = [];
  const rows = [];
  csv.rows.forEach((r, i) => {
    const line = i + 2;
    const o = { _line: line };
    switch (kind) {
      case 'products': {
        o.item_code = (get(r, 'item_code') || '').trim();
        if (!o.item_code) { warnings.push(`line ${line}: empty item_code, skipped`); return; }
        for (const f of ['description', 'category', 'subcategory', 'brand', 'status', 'uom_purchase', 'uom_selling', 'uom_purchase_hint', 'uom_selling_hint', 'cost_data_quality'])
          if (has(f)) o[f] = (get(r, f) || '').trim();
        for (const f of ['is_core_80', 'is_branded']) if (has(f)) o[f] = parseBool(get(r, f));
        for (const f of ['uom_factor', 'fy_sales_qty', 'fy_purchase_qty', 'implied_margin_pct', 'target_margin_pct']) if (has(f)) o[f] = parseNumber(get(r, f));
        for (const f of ['fy_sales_value', 'fy_purchase_value', 'implied_unit_cost', 'implied_unit_price', 'verified_unit_cost']) if (has(f)) o[f + '_sen'] = parseSen(get(r, f));
        if (has('cost_data_quality')) {
          const q = (o.cost_data_quality || '').toUpperCase().replace(/[\s-]+/g, '_');
          if (q && !QUALITY.includes(q)) { warnings.push(`line ${line}: unknown cost_data_quality "${o.cost_data_quality}", recomputed`); delete o.cost_data_quality; }
          else o.cost_data_quality = q || undefined;
        }
        if (o.status !== undefined) o.status = o.status ? (/^(0|inactive|n|no|false)$/i.test(o.status) ? 'inactive' : 'active') : undefined;
        break;
      }
      case 'customers': {
        o.customer_code = (get(r, 'customer_code') || '').trim();
        if (!o.customer_code) { warnings.push(`line ${line}: empty customer_code, skipped`); return; }
        for (const f of ['customer_name', 'agent_code', 'salesperson', 'customer_type', 'buying_breadth', 'size_tier', 'price_tier', 'status'])
          if (has(f)) o[f] = (get(r, f) || '').trim();
        if (has('fy_value')) o.fy_value_sen = parseSen(get(r, 'fy_value'));
        if (o.status !== undefined) o.status = o.status ? (/^(0|inactive|n|no|false|dormant)$/i.test(o.status) ? 'inactive' : 'active') : undefined;
        break;
      }
      case 'bundles': {
        o.bundle_id = (get(r, 'bundle_id') || '').trim();
        o.customer_type = (get(r, 'customer_type') || '').trim();
        o.item_code = (get(r, 'item_code') || '').trim();
        if (!o.bundle_id || !o.item_code) { warnings.push(`line ${line}: missing bundle_id/item_code, skipped`); return; }
        o.support_pct = parseNumber(get(r, 'support_pct'));
        o.lift = parseNumber(get(r, 'lift'));
        o.median_annual_value_sen = parseSen(get(r, 'median_annual_value'));
        break;
      }
      case 'crosssell': {
        o.customer_code = (get(r, 'customer_code') || '').trim();
        o.item_code = (get(r, 'item_code') || '').trim();
        if (!o.customer_code || !o.item_code) { warnings.push(`line ${line}: missing customer_code/item_code, skipped`); return; }
        o.peer_penetration_pct = parseNumber(get(r, 'peer_penetration_pct'));
        o.estimated_annual_value_sen = parseSen(get(r, 'estimated_annual_value'));
        break;
      }
      case 'sales':
      case 'purchases': {
        o.item_code = (get(r, 'item_code') || '').trim();
        if (!o.item_code) { warnings.push(`line ${line}: empty item_code, skipped`); return; }
        if (kind === 'sales') {
          o.customer_code = (get(r, 'customer_code') || '').trim();
          if (!o.customer_code) { warnings.push(`line ${line}: empty customer_code, skipped`); return; }
          if (has('customer_name')) o.customer_name = (get(r, 'customer_name') || '').trim();
        }
        if (has('description')) o.description = (get(r, 'description') || '').trim();
        if (has('uom')) o.uom = (get(r, 'uom') || '').trim();
        o.qty = parseNumber(get(r, 'qty')) ?? 0;
        o.value_sen = parseSen(get(r, 'value')) ?? 0;
        break;
      }
    }
    rows.push(o);
  });
  if (kind === 'products' || kind === 'customers') {
    const key = kind === 'products' ? 'item_code' : 'customer_code';
    const seen = new Map();
    for (const r of rows) {
      if (seen.has(r[key])) warnings.push(`line ${r._line}: duplicate ${key} ${r[key]} (last row wins)`);
      seen.set(r[key], r);
    }
    return { rows: [...seen.values()], warnings };
  }
  return { rows, warnings };
}

// ---------------------------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------------------------

/** Recompute implied unit cost/price/margin and quality flag from the evidence columns. */
export function recomputeImplied(p, { keepProvidedQuality = false } = {}) {
  // Evidence first: derive from qty/value whenever both exist; provided implied columns only fill gaps.
  const cost = divideSen(p.fy_purchase_value_sen, p.fy_purchase_qty) ?? p.implied_unit_cost_sen ?? null;
  const price = divideSen(p.fy_sales_value_sen, p.fy_sales_qty) ?? p.implied_unit_price_sen ?? null;
  const margin = marginPct(price, cost) ?? (p.implied_margin_pct === null || p.implied_margin_pct === undefined ? null : Math.round(p.implied_margin_pct * 10) / 10);
  let quality = keepProvidedQuality && QUALITY.includes(p.cost_data_quality) ? p.cost_data_quality : null;
  if (!quality) {
    const hasPurchase = (p.fy_purchase_value_sen ?? 0) > 0 || cost !== null;
    if (!hasPurchase) quality = 'NO_PURCHASE_DATA';
    else if (margin !== null && margin >= 2 && margin <= 60) quality = 'OK';
    else quality = 'UOM_SUSPECT';
  }
  return { ...p, implied_unit_cost_sen: cost, implied_unit_price_sen: price, implied_margin_pct: margin, cost_data_quality: quality };
}

const PRODUCT_COLS = ['item_code', 'description', 'category', 'subcategory', 'brand', 'is_core_80', 'is_branded', 'status',
  'uom_purchase', 'uom_selling', 'uom_factor', 'verified_unit_cost_sen', 'cost_updated_at', 'cost_updated_by', 'no_purchase_confirmed', 'target_margin_pct',
  'fy_label', 'fy_sales_qty', 'fy_sales_value_sen', 'fy_purchase_qty', 'fy_purchase_value_sen',
  'implied_unit_cost_sen', 'implied_unit_price_sen', 'implied_margin_pct', 'cost_data_quality', 'uom_purchase_hint', 'uom_selling_hint', 'updated_at'];

function emptyProduct(item_code) {
  return { item_code, description: '', category: '', subcategory: '', brand: null, is_core_80: 0, is_branded: 0, status: 'active',
    uom_purchase: null, uom_selling: null, uom_factor: null, verified_unit_cost_sen: null, cost_updated_at: null, cost_updated_by: null,
    no_purchase_confirmed: 0, target_margin_pct: null, fy_label: null, fy_sales_qty: null, fy_sales_value_sen: null, fy_purchase_qty: null,
    fy_purchase_value_sen: null, implied_unit_cost_sen: null, implied_unit_price_sen: null, implied_margin_pct: null,
    cost_data_quality: 'NO_PURCHASE_DATA', uom_purchase_hint: null, uom_selling_hint: null, updated_at: null };
}

function sameRow(a, b, cols) {
  return cols.every(c => (a[c] ?? null) === (b[c] ?? null));
}

function writeProduct(db, merged) {
  const cols = PRODUCT_COLS;
  db.run(`INSERT OR REPLACE INTO products (${cols.join(',')}) VALUES (${cols.map(c => '$' + c).join(',')})`,
    Object.fromEntries(cols.map(c => [c, merged[c] ?? null])));
}

/** Merge an incoming products row into the existing row following the evidence/truth rules. */
export function mergeProduct(existing, inc, fyLabel) {
  const cur = existing || emptyProduct(inc.item_code);
  const out = { ...cur };
  const isNew = !existing;
  // descriptive: from file when present and non-empty
  for (const f of ['description', 'category', 'subcategory', 'brand', 'status']) if (inc[f] !== undefined && inc[f] !== '') out[f] = inc[f];
  for (const f of ['is_core_80', 'is_branded']) if (inc[f] !== undefined) out[f] = inc[f];
  // human-entered: only fill when empty
  for (const f of ['uom_purchase', 'uom_selling']) if (!cur[f] && inc[f]) out[f] = inc[f];
  if (cur.uom_factor === null && inc.uom_factor !== undefined && inc.uom_factor !== null) out.uom_factor = inc.uom_factor;
  if (cur.target_margin_pct === null && inc.target_margin_pct !== undefined && inc.target_margin_pct !== null) out.target_margin_pct = inc.target_margin_pct;
  if (cur.verified_unit_cost_sen === null && inc.verified_unit_cost_sen !== undefined && inc.verified_unit_cost_sen !== null) {
    out.verified_unit_cost_sen = inc.verified_unit_cost_sen; out.cost_updated_at = now(); out.cost_updated_by = 'import';
  }
  // evidence: from file when the column exists
  for (const f of ['fy_sales_qty', 'fy_sales_value_sen', 'fy_purchase_qty', 'fy_purchase_value_sen', 'uom_purchase_hint', 'uom_selling_hint'])
    if (inc[f] !== undefined) out[f] = inc[f] === '' ? null : inc[f];
  const providedImplied = {};
  for (const f of ['implied_unit_cost_sen', 'implied_unit_price_sen', 'implied_margin_pct']) providedImplied[f] = inc[f] !== undefined ? inc[f] : null;
  const evidenceCols = ['fy_sales_qty', 'fy_sales_value_sen', 'fy_purchase_qty', 'fy_purchase_value_sen'];
  const evidenceChanged = isNew || evidenceCols.some(f => (cur[f] ?? null) !== (out[f] ?? null)) || Object.values(providedImplied).some(v => v !== null);
  if (evidenceChanged) {
    const rec = recomputeImplied({ ...out, ...providedImplied, cost_data_quality: inc.cost_data_quality ?? null }, { keepProvidedQuality: inc.cost_data_quality !== undefined });
    Object.assign(out, rec);
  } else if (inc.cost_data_quality !== undefined && inc.cost_data_quality) {
    out.cost_data_quality = inc.cost_data_quality;
  }
  if (fyLabel) out.fy_label = fyLabel;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public API: check (dry run) and commit
// ---------------------------------------------------------------------------------------------

export function check(db, { kind, text, filename = null }) {
  const csv = parseCsv(text);
  if (!csv.headers.length) throw Object.assign(new Error('empty_file'), { status: 400 });
  const resolvedKind = kind && kind !== 'auto' ? kind : guessKind(csv.headers);
  if (!resolvedKind) throw Object.assign(new Error('could_not_detect_kind'), { status: 400, headers: csv.headers });
  const { mapping, missing, unmapped } = detectMapping(resolvedKind, csv.headers);
  const { rows, warnings } = canonRows(resolvedKind, csv, mapping);
  const sha = sha256(text);
  const prior = db.get('SELECT id, imported_at, imported_by FROM imports WHERE kind = ? AND sha256 = ?', resolvedKind, sha);
  const totals = {};
  if (resolvedKind === 'products') {
    totals.fy_sales_value_sen = rows.reduce((s, r) => s + (r.fy_sales_value_sen ?? 0), 0);
    totals.fy_purchase_value_sen = rows.reduce((s, r) => s + (r.fy_purchase_value_sen ?? 0), 0);
    totals.core_count = rows.filter(r => r.is_core_80).length;
    totals.branded_count = rows.filter(r => r.is_branded).length;
  } else if (resolvedKind === 'sales' || resolvedKind === 'purchases') {
    totals.value_sen = rows.reduce((s, r) => s + (r.value_sen ?? 0), 0);
    totals.qty = rows.reduce((s, r) => s + (r.qty ?? 0), 0);
    totals.items = new Set(rows.map(r => r.item_code)).size;
    if (resolvedKind === 'sales') totals.customers = new Set(rows.map(r => r.customer_code)).size;
  } else if (resolvedKind === 'customers') {
    totals.fy_value_sen = rows.reduce((s, r) => s + (r.fy_value_sen ?? 0), 0);
    totals.salespeople = [...new Set(rows.map(r => r.salesperson).filter(Boolean))];
  }
  return {
    kind: resolvedKind, label: KINDS[resolvedKind].label, filename, sha256: sha, headers: csv.headers, mapping, missing, unmapped,
    row_count: rows.length, preview: rows.slice(0, 5).map(({ _line, ...r }) => r), warnings: warnings.slice(0, 50), warning_count: warnings.length, totals,
    already_imported: prior ? { imported_at: prior.imported_at, imported_by: prior.imported_by } : null,
    _rows: rows,
  };
}

export function commit(db, { kind, text, filename = null, who = 'system', force = false, createUsers = true }) {
  const chk = check(db, { kind, text, filename });
  if (chk.missing.length) throw Object.assign(new Error(`missing required columns: ${chk.missing.join(', ')}`), { status: 400, check: chk });
  if (chk.already_imported && !force) {
    return { kind: chk.kind, skipped: true, reason: 'already_imported', already_imported: chk.already_imported, summary: { inserted: 0, updated: 0, unchanged: chk.row_count } };
  }
  const rows = chk._rows;
  const fyLabel = db.setting('fy_label', 'FY2025');
  const summary = db.transaction(() => {
    let s;
    switch (chk.kind) {
      case 'products': s = commitProducts(db, rows, fyLabel); break;
      case 'customers': s = commitCustomers(db, rows, { createUsers }); break;
      case 'bundles': s = replaceTable(db, 'bundles', rows, ['bundle_id', 'customer_type', 'item_code', 'support_pct', 'lift', 'median_annual_value_sen']); break;
      case 'crosssell': s = replaceTable(db, 'crosssell_gaps', rows, ['customer_code', 'item_code', 'peer_penetration_pct', 'estimated_annual_value_sen']); break;
      case 'sales': s = commitSales(db, rows, fyLabel); break;
      case 'purchases': s = commitPurchases(db, rows, fyLabel); break;
    }
    db.run(`INSERT INTO imports(kind, filename, sha256, imported_at, imported_by, row_count, summary) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, sha256) DO UPDATE SET imported_at = excluded.imported_at, imported_by = excluded.imported_by, summary = excluded.summary`,
      chk.kind, filename, chk.sha256, now(), who, rows.length, JSON.stringify(s));
    audit(db, { who, action: 'import', entity: 'import', entityId: chk.kind, field: filename, newValue: s });
    return s;
  });
  const { _rows, ...rest } = chk;
  return { ...rest, skipped: false, summary };
}

function commitProducts(db, rows, fyLabel) {
  let inserted = 0, updated = 0, unchanged = 0;
  for (const inc of rows) {
    const existing = db.get('SELECT * FROM products WHERE item_code = ?', inc.item_code);
    const merged = mergeProduct(existing, inc, fyLabel);
    if (existing && sameRow(existing, merged, PRODUCT_COLS.filter(c => c !== 'updated_at'))) { unchanged++; continue; }
    merged.updated_at = now();
    writeProduct(db, merged);
    existing ? updated++ : inserted++;
  }
  return { inserted, updated, unchanged };
}

const CUSTOMER_COLS = ['customer_code', 'customer_name', 'agent_code', 'salesperson', 'customer_type', 'buying_breadth', 'size_tier', 'price_tier', 'price_tier_override', 'status', 'fy_value_sen', 'updated_at'];

export function resolveTier(db, { customer_type, size_tier }) {
  const t = customer_type || '', s = size_tier || '';
  const r = db.get(`SELECT price_tier FROM tier_rules WHERE (customer_type = ? OR customer_type = '*') AND (size_tier = ? OR size_tier = '*')
                    ORDER BY (customer_type = '*') * 2 + (size_tier = '*') LIMIT 1`, t, s);
  return r ? r.price_tier : null;
}

export function mergeCustomer(db, existing, inc, tiers) {
  const cur = existing || { customer_code: inc.customer_code, customer_name: '', agent_code: null, salesperson: null, customer_type: null, buying_breadth: null,
    size_tier: null, price_tier: null, price_tier_override: 0, status: 'active', fy_value_sen: null, updated_at: null };
  const out = { ...cur };
  for (const f of ['customer_name', 'agent_code', 'salesperson', 'customer_type', 'buying_breadth', 'size_tier', 'status']) if (inc[f] !== undefined && inc[f] !== '') out[f] = inc[f];
  if (inc.fy_value_sen !== undefined) out.fy_value_sen = inc.fy_value_sen;
  if (!cur.price_tier_override) {
    const fileTier = inc.price_tier && tiers.has(inc.price_tier.toUpperCase()) ? inc.price_tier.toUpperCase() : null;
    out.price_tier = fileTier || resolveTier(db, out) || cur.price_tier || db.setting('default_price_tier', 'STD');
  }
  return out;
}

function commitCustomers(db, rows, { createUsers }) {
  const tiers = new Set(db.all('SELECT code FROM price_tiers').map(r => r.code));
  let inserted = 0, updated = 0, unchanged = 0, users = 0;
  for (const inc of rows) {
    const existing = db.get('SELECT * FROM customers WHERE customer_code = ?', inc.customer_code);
    const merged = mergeCustomer(db, existing, inc, tiers);
    if (createUsers && merged.salesperson && ensureSalespersonUser(db, merged.salesperson)) users++;
    if (existing && sameRow(existing, merged, CUSTOMER_COLS.filter(c => c !== 'updated_at'))) { unchanged++; continue; }
    merged.updated_at = now();
    db.run(`INSERT OR REPLACE INTO customers (${CUSTOMER_COLS.join(',')}) VALUES (${CUSTOMER_COLS.map(c => '$' + c).join(',')})`,
      Object.fromEntries(CUSTOMER_COLS.map(c => [c, merged[c] ?? null])));
    existing ? updated++ : inserted++;
  }
  return { inserted, updated, unchanged, salesperson_users_created: users };
}

function replaceTable(db, table, rows, cols) {
  const before = db.get(`SELECT COUNT(*) c FROM ${table}`).c;
  db.run(`DELETE FROM ${table}`);
  const ins = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => '$' + c).join(',')})`;
  for (const r of rows) db.run(ins, Object.fromEntries(cols.map(c => [c, r[c] ?? null])));
  const after = db.get(`SELECT COUNT(*) c FROM ${table}`).c;
  return { replaced: true, rows_before: before, rows_after: after };
}

function aggregate(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const a = m.get(k) || { ...r, qty: 0, value_sen: 0 };
    a.qty += r.qty || 0; a.value_sen += r.value_sen || 0;
    if (r.uom && !a.uom) a.uom = r.uom;
    m.set(k, a);
  }
  return m;
}

function ensureProductStub(db, item_code, description) {
  const p = db.get('SELECT item_code FROM products WHERE item_code = ?', item_code);
  if (p) return false;
  writeProduct(db, { ...emptyProduct(item_code), description: description || '', updated_at: now() });
  return true;
}

function commitSales(db, rows, fyLabel) {
  const byPair = aggregate(rows, r => `${r.customer_code}\u0000${r.item_code}`);
  const byItem = aggregate(rows, r => r.item_code);
  const byCustomer = aggregate(rows, r => r.customer_code);
  let stubs = 0, custStubs = 0;
  db.run('DELETE FROM customer_products');
  for (const a of byPair.values()) {
    if (ensureProductStub(db, a.item_code, a.description)) stubs++;
    if (!db.get('SELECT 1 FROM customers WHERE customer_code = ?', a.customer_code)) {
      db.run(`INSERT INTO customers(customer_code, customer_name, price_tier, status, updated_at) VALUES (?, ?, ?, 'active', ?)`,
        a.customer_code, a.customer_name || '', db.setting('default_price_tier', 'STD'), now());
      custStubs++;
    }
    db.run('INSERT INTO customer_products(customer_code, item_code, fy_qty, fy_value_sen) VALUES (?, ?, ?, ?)', a.customer_code, a.item_code, a.qty, a.value_sen);
  }
  for (const a of byCustomer.values()) db.run('UPDATE customers SET fy_value_sen = ? WHERE customer_code = ?', a.value_sen, a.customer_code);
  let updated = 0, unchanged = 0;
  for (const a of byItem.values()) {
    const p = db.get('SELECT * FROM products WHERE item_code = ?', a.item_code);
    const merged = recomputeImplied({ ...p, fy_sales_qty: a.qty, fy_sales_value_sen: a.value_sen, uom_selling_hint: a.uom || p.uom_selling_hint,
      implied_unit_cost_sen: null, implied_unit_price_sen: null, implied_margin_pct: null, fy_label: fyLabel });
    if (sameRow(p, merged, PRODUCT_COLS.filter(c => c !== 'updated_at'))) { unchanged++; continue; }
    merged.updated_at = now(); writeProduct(db, merged); updated++;
  }
  return { pairs: byPair.size, products_updated: updated, products_unchanged: unchanged, product_stubs: stubs, customer_stubs: custStubs };
}

function commitPurchases(db, rows, fyLabel) {
  const byItem = aggregate(rows, r => r.item_code);
  let stubs = 0, updated = 0, unchanged = 0;
  for (const a of byItem.values()) {
    if (ensureProductStub(db, a.item_code, a.description)) stubs++;
    const p = db.get('SELECT * FROM products WHERE item_code = ?', a.item_code);
    const merged = recomputeImplied({ ...p, fy_purchase_qty: a.qty, fy_purchase_value_sen: a.value_sen, uom_purchase_hint: a.uom || p.uom_purchase_hint,
      implied_unit_cost_sen: null, implied_unit_price_sen: null, implied_margin_pct: null, fy_label: fyLabel });
    if (sameRow(p, merged, PRODUCT_COLS.filter(c => c !== 'updated_at'))) { unchanged++; continue; }
    merged.updated_at = now(); writeProduct(db, merged); updated++;
  }
  return { products_updated: updated, products_unchanged: unchanged, product_stubs: stubs };
}

/** Sum of FY sales value across the product table, for the RM27,521,859 reconciliation check. */
export function reconcileTotal(db) {
  return db.get('SELECT COALESCE(SUM(fy_sales_value_sen), 0) total_sen, COUNT(*) products, SUM(is_core_80) core FROM products');
}
