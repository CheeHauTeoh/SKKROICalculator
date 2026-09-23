import { now, today } from './db.js';
import { audit, auditDiff } from './audit.js';
import { marginPct, priceFromMargin, mulSen } from './money.js';

/**
 * Cost basis for margin purposes.
 *  - verified_unit_cost_sen always wins.
 *  - Otherwise, only when cost_data_quality = 'OK' may the implied cost be used, labelled "implied".
 *  - Otherwise there is no cost basis: "成本待核实 / Cost not verified" and margin is suppressed.
 */
export function costBasis(p) {
  if (p.verified_unit_cost_sen !== null && p.verified_unit_cost_sen !== undefined) return { cost_sen: p.verified_unit_cost_sen, basis: 'verified' };
  if (p.cost_data_quality === 'OK' && p.implied_unit_cost_sen !== null && p.implied_unit_cost_sen !== undefined) return { cost_sen: p.implied_unit_cost_sen, basis: 'implied' };
  return { cost_sen: null, basis: null };
}

export function marginAt(p, priceSen) {
  const { cost_sen, basis } = costBasis(p);
  if (cost_sen === null || priceSen === null || priceSen === undefined) return { margin_pct: null, basis };
  return { margin_pct: marginPct(priceSen, cost_sen), basis };
}

export function currentPrices(db, item_code = null) {
  return item_code
    ? db.all('SELECT * FROM product_prices WHERE item_code = ? AND effective_to IS NULL ORDER BY price_tier', item_code)
    : db.all('SELECT * FROM product_prices WHERE effective_to IS NULL');
}

/** Price for a customer tier, falling back to the default tier. */
export function priceForTier(db, item_code, tier) {
  const def = db.setting('default_price_tier', 'STD');
  const rows = currentPrices(db, item_code);
  const hit = rows.find(r => r.price_tier === tier) || rows.find(r => r.price_tier === def);
  return hit ? { ...hit, fallback: hit.price_tier !== tier } : null;
}

/** Append a new price row (closing the current one). Returns the new row or null if unchanged. */
export function setPrice(db, { item_code, price_tier, list_price_sen, floor_price_sen, effective_from = null, who, note = null }) {
  if (!Number.isInteger(list_price_sen) || !Number.isInteger(floor_price_sen)) throw Object.assign(new Error('price_must_be_integer_sen'), { status: 400 });
  if (list_price_sen < 0 || floor_price_sen < 0) throw Object.assign(new Error('price_negative'), { status: 400 });
  if (floor_price_sen > list_price_sen) throw Object.assign(new Error('floor_above_list'), { status: 400 });
  if (!db.get('SELECT 1 FROM products WHERE item_code = ?', item_code)) throw Object.assign(new Error('unknown_product'), { status: 404 });
  if (!db.get('SELECT 1 FROM price_tiers WHERE code = ?', price_tier)) throw Object.assign(new Error('unknown_tier'), { status: 400 });
  const from = effective_from || today();
  const cur = db.get('SELECT * FROM product_prices WHERE item_code = ? AND price_tier = ? AND effective_to IS NULL', item_code, price_tier);
  if (cur && cur.list_price_sen === list_price_sen && cur.floor_price_sen === floor_price_sen) return null;
  return db.transaction(() => {
    if (cur) db.run('UPDATE product_prices SET effective_to = ? WHERE id = ?', from, cur.id);
    const r = db.run(`INSERT INTO product_prices(item_code, price_tier, list_price_sen, floor_price_sen, effective_from, effective_to, set_by, created_at, note)
                      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`, item_code, price_tier, list_price_sen, floor_price_sen, from, who, now(), note);
    audit(db, { who, action: 'set_price', entity: 'product_prices', entityId: `${item_code}/${price_tier}`, field: 'list_price_sen', oldValue: cur?.list_price_sen ?? null, newValue: list_price_sen });
    audit(db, { who, action: 'set_price', entity: 'product_prices', entityId: `${item_code}/${price_tier}`, field: 'floor_price_sen', oldValue: cur?.floor_price_sen ?? null, newValue: floor_price_sen });
    return db.get('SELECT * FROM product_prices WHERE id = ?', r.lastInsertRowid);
  });
}

export const PRODUCT_EDITABLE = ['description', 'category', 'subcategory', 'brand', 'is_core_80', 'is_branded', 'status',
  'uom_purchase', 'uom_selling', 'uom_factor', 'verified_unit_cost_sen', 'no_purchase_confirmed', 'target_margin_pct'];

export function updateProduct(db, item_code, patch, who) {
  const before = db.get('SELECT * FROM products WHERE item_code = ?', item_code);
  if (!before) throw Object.assign(new Error('unknown_product'), { status: 404 });
  const after = { ...before };
  for (const f of PRODUCT_EDITABLE) if (f in patch) after[f] = patch[f] === '' ? null : patch[f];
  for (const f of ['is_core_80', 'is_branded', 'no_purchase_confirmed']) after[f] = after[f] ? 1 : 0;
  if (after.uom_factor !== null && !(Number(after.uom_factor) > 0)) throw Object.assign(new Error('uom_factor_must_be_positive'), { status: 400 });
  if (after.verified_unit_cost_sen !== null && !Number.isInteger(after.verified_unit_cost_sen)) throw Object.assign(new Error('cost_must_be_integer_sen'), { status: 400 });
  if (after.target_margin_pct !== null && !(after.target_margin_pct >= 0 && after.target_margin_pct < 100)) throw Object.assign(new Error('target_margin_out_of_range'), { status: 400 });
  if (after.verified_unit_cost_sen !== before.verified_unit_cost_sen) { after.cost_updated_at = now(); after.cost_updated_by = who; }
  if (after.no_purchase_confirmed && after.verified_unit_cost_sen === null) { /* explicitly marked: fine */ }
  return db.transaction(() => {
    const changed = auditDiff(db, { who, entity: 'products', entityId: item_code, before, after, fields: [...PRODUCT_EDITABLE, 'cost_updated_by'] });
    if (!changed.length) return { changed: [], product: before };
    after.updated_at = now();
    const cols = Object.keys(after);
    db.run(`INSERT OR REPLACE INTO products (${cols.join(',')}) VALUES (${cols.map(c => '$' + c).join(',')})`, after);
    return { changed, product: db.get('SELECT * FROM products WHERE item_code = ?', item_code) };
  });
}

/** Bulk operations over a product filter. Every resulting change is audited via setPrice/updateProduct. */
export function bulk(db, { filter = {}, action, params = {}, who }) {
  const where = ['1=1'], args = [];
  if (filter.category) { where.push('category = ?'); args.push(filter.category); }
  if (filter.core) where.push('is_core_80 = 1');
  if (filter.item_codes?.length) { where.push(`item_code IN (${filter.item_codes.map(() => '?').join(',')})`); args.push(...filter.item_codes); }
  const products = db.all(`SELECT * FROM products WHERE ${where.join(' AND ')}`, ...args);
  const tier = params.price_tier || db.setting('default_price_tier', 'STD');
  let changed = 0, skipped = 0;
  const skippedReasons = {};
  const skip = reason => { skipped++; skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; };
  db.transaction(() => {
    for (const p of products) {
      switch (action) {
        case 'set_target_margin': {
          const r = updateProduct(db, p.item_code, { target_margin_pct: Number(params.target_margin_pct) }, who);
          r.changed.length ? changed++ : skip('unchanged');
          break;
        }
        case 'derive_list_from_cost': {
          // list = cost / (1 - target margin); floor = list * (1 - floor discount %). Only with a cost basis.
          const { cost_sen, basis } = costBasis(p);
          if (cost_sen === null) { skip('no_cost_basis'); break; }
          if (params.verified_only && basis !== 'verified') { skip('cost_not_verified'); break; }
          const m = p.target_margin_pct ?? (params.target_margin_pct !== undefined ? Number(params.target_margin_pct) : null);
          if (m === null) { skip('no_target_margin'); break; }
          const list = priceFromMargin(cost_sen, m);
          const disc = Number(params.floor_discount_pct ?? db.setting('default_floor_discount_pct', '5'));
          const floor = mulSen(list, 1 - disc / 100);
          setPrice(db, { item_code: p.item_code, price_tier: tier, list_price_sen: list, floor_price_sen: floor, who, note: `bulk derive m=${m}% basis=${basis}` }) ? changed++ : skip('unchanged');
          break;
        }
        case 'set_floor_pct': {
          const cur = db.get('SELECT * FROM product_prices WHERE item_code = ? AND price_tier = ? AND effective_to IS NULL', p.item_code, tier);
          if (!cur) { skip('no_list_price'); break; }
          const floor = mulSen(cur.list_price_sen, 1 - Number(params.floor_discount_pct) / 100);
          setPrice(db, { item_code: p.item_code, price_tier: tier, list_price_sen: cur.list_price_sen, floor_price_sen: floor, who, note: `bulk floor ${params.floor_discount_pct}%` }) ? changed++ : skip('unchanged');
          break;
        }
        case 'adjust_pct': {
          const cur = db.get('SELECT * FROM product_prices WHERE item_code = ? AND price_tier = ? AND effective_to IS NULL', p.item_code, tier);
          if (!cur) { skip('no_list_price'); break; }
          const f = 1 + Number(params.pct) / 100;
          setPrice(db, { item_code: p.item_code, price_tier: tier, list_price_sen: mulSen(cur.list_price_sen, f), floor_price_sen: mulSen(cur.floor_price_sen, f), who, note: `bulk adjust ${params.pct}%` }) ? changed++ : skip('unchanged');
          break;
        }
        case 'copy_tier': {
          // derive another tier from the default tier by a percentage (e.g. KEY = STD - 3%)
          const src = db.get('SELECT * FROM product_prices WHERE item_code = ? AND price_tier = ? AND effective_to IS NULL', p.item_code, params.from_tier || db.setting('default_price_tier', 'STD'));
          if (!src) { skip('no_source_price'); break; }
          const f = 1 + Number(params.pct || 0) / 100;
          setPrice(db, { item_code: p.item_code, price_tier: params.to_tier, list_price_sen: mulSen(src.list_price_sen, f), floor_price_sen: mulSen(src.floor_price_sen, f), who, note: `bulk copy ${src.price_tier}->${params.to_tier} ${params.pct || 0}%` }) ? changed++ : skip('unchanged');
          break;
        }
        default: throw Object.assign(new Error('unknown_bulk_action'), { status: 400 });
      }
    }
  });
  return { matched: products.length, changed, skipped, skipped_reasons: skippedReasons };
}

/** Progress against the milestone-1 target: core SKUs reconciled. */
export function uomProgress(db) {
  const core = db.all('SELECT * FROM products WHERE is_core_80 = 1');
  const isDone = p => p.verified_unit_cost_sen !== null || p.no_purchase_confirmed === 1;
  const suspect = core.filter(p => p.cost_data_quality === 'UOM_SUSPECT');
  return {
    core_total: core.length,
    core_done: core.filter(isDone).length,
    core_with_factor: core.filter(p => p.uom_factor !== null).length,
    suspect_total: suspect.length,
    suspect_done: suspect.filter(isDone).length,
    by_quality: Object.fromEntries(['OK', 'UOM_SUSPECT', 'NO_PURCHASE_DATA'].map(q => [q, { total: core.filter(p => p.cost_data_quality === q).length, done: core.filter(p => p.cost_data_quality === q && isDone(p)).length }])),
    all_total: db.get('SELECT COUNT(*) c FROM products').c,
    all_done: db.get('SELECT COUNT(*) c FROM products WHERE verified_unit_cost_sen IS NOT NULL OR no_purchase_confirmed = 1').c,
  };
}
