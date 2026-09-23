import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../server/db.js';
import * as imp from '../server/importer.js';
import { seedSample, readSample } from './helpers.js';

test('header aliases and stripping of FY/currency decorations', () => {
  const { mapping, missing } = imp.detectMapping('products', ['Item Code', 'Description', 'FY2025 Sales Value (RM)', 'FY2025 Sales Qty', 'Purchase Value RM', 'is_core_80', 'cost_data_quality']);
  assert.equal(missing.length, 0);
  assert.equal(mapping.item_code, 'Item Code');
  assert.equal(mapping.fy_sales_value, 'FY2025 Sales Value (RM)');
  assert.equal(mapping.fy_sales_qty, 'FY2025 Sales Qty');
  assert.equal(mapping.fy_purchase_value, 'Purchase Value RM');
  assert.equal(imp.guessKind(['customer_code', 'item_code', 'peer_penetration_pct', 'estimated_annual_value']), 'crosssell');
  assert.equal(imp.guessKind(['bundle_id', 'customer_type', 'item_code', 'support_pct', 'lift']), 'bundles');
});

test('re-importing the same file twice changes nothing', () => {
  const db = new Db(':memory:');
  const first = seedSample(db);
  assert.equal(first.products.summary.inserted, 67);
  assert.equal(first.products.summary.updated, 0);
  const snapshotBefore = JSON.stringify(db.all('SELECT * FROM products ORDER BY item_code')) + JSON.stringify(db.all('SELECT * FROM customers ORDER BY customer_code')) + JSON.stringify(db.all('SELECT * FROM customer_products ORDER BY 1,2'));
  const second = seedSample(db);
  for (const k of Object.keys(second)) assert.equal(second[k].skipped, true, `${k} should be skipped as already imported`);
  // and even when forced, nothing changes
  const forced = imp.commit(db, { kind: 'products', text: readSample('seed_products.csv'), filename: 'seed_products.csv', who: 'test', force: true });
  assert.equal(forced.summary.inserted, 0); assert.equal(forced.summary.updated, 0); assert.equal(forced.summary.unchanged, 67);
  const snapshotAfter = JSON.stringify(db.all('SELECT * FROM products ORDER BY item_code')) + JSON.stringify(db.all('SELECT * FROM customers ORDER BY customer_code')) + JSON.stringify(db.all('SELECT * FROM customer_products ORDER BY 1,2'));
  assert.equal(snapshotAfter, snapshotBefore);
  assert.equal(db.get('SELECT COUNT(*) c FROM imports').c, 5);
});

test('import refreshes evidence but never overwrites human-entered fields', () => {
  const db = new Db(':memory:');
  seedSample(db);
  db.run(`UPDATE products SET uom_purchase = 'CTN', uom_selling = 'PKT', uom_factor = 25, verified_unit_cost_sen = 487, target_margin_pct = 20, cost_updated_by = 'yunjun' WHERE item_code = '9.EC22'`);
  const edited = readSample('seed_products.csv').replace('9.EC22,"EC22A+LID",Disposables', '9.EC22,"EC22A + LID (new desc)",Disposables');
  const r = imp.commit(db, { kind: 'products', text: edited, filename: 'seed_products_v2.csv', who: 'test' });
  assert.equal(r.summary.updated, 1);
  const p = db.get(`SELECT * FROM products WHERE item_code = '9.EC22'`);
  assert.equal(p.description, 'EC22A + LID (new desc)');
  assert.equal(p.uom_factor, 25);
  assert.equal(p.verified_unit_cost_sen, 487);
  assert.equal(p.target_margin_pct, 20);
  assert.equal(p.cost_updated_by, 'yunjun');
  assert.equal(p.cost_data_quality, 'UOM_SUSPECT');
  assert.equal(p.implied_unit_cost_sen, 12180);
});

test('quality flag is computed when the file does not carry it', () => {
  const db = new Db(':memory:');
  const text = 'item_code,description,sales_qty,sales_value,purchase_qty,purchase_value\nA,ok,100,1000,100,700\nB,suspect,100,1000,10,700\nC,nopurchase,100,1000,,\n';
  imp.commit(db, { kind: 'products', text, who: 'test' });
  assert.equal(db.get(`SELECT cost_data_quality q FROM products WHERE item_code='A'`).q, 'OK');
  assert.equal(db.get(`SELECT cost_data_quality q FROM products WHERE item_code='B'`).q, 'UOM_SUSPECT');
  assert.equal(db.get(`SELECT cost_data_quality q FROM products WHERE item_code='C'`).q, 'NO_PURCHASE_DATA');
  assert.equal(db.get(`SELECT implied_margin_pct m FROM products WHERE item_code='A'`).m, 30);
});

test('reconciliation total is the sum of the FY sales value column', () => {
  const db = new Db(':memory:');
  seedSample(db);
  const chk = imp.check(db, { kind: 'products', text: readSample('seed_products.csv') });
  assert.equal(imp.reconcileTotal(db).total_sen, chk.totals.fy_sales_value_sen);
});

test('customers: tier from rules unless overridden; salesperson logins created', () => {
  const db = new Db(':memory:');
  db.run(`INSERT INTO tier_rules VALUES ('Hypermarket', '*', 'KEY'), ('*', 'S', 'SML')`);
  seedSample(db);
  const hyper = db.all(`SELECT price_tier FROM customers WHERE customer_type = 'Hypermarket'`);
  assert.ok(hyper.length && hyper.every(c => c.price_tier === 'KEY'));
  const small = db.get(`SELECT price_tier FROM customers WHERE customer_type <> 'Hypermarket' AND size_tier = 'S'`);
  assert.equal(small.price_tier, 'SML');
  assert.equal(db.get(`SELECT COUNT(*) c FROM users WHERE role = 'salesperson'`).c, 3);
  db.run(`UPDATE customers SET price_tier = 'STD', price_tier_override = 1 WHERE customer_code = 'C0001'`);
  imp.commit(db, { kind: 'customers', text: readSample('seed_customers.csv'), who: 'test', force: true });
  assert.equal(db.get(`SELECT price_tier FROM customers WHERE customer_code = 'C0001'`).price_tier, 'STD');
});
