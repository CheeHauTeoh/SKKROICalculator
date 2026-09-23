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

test('re-importing the same file twice changes nothing', async () => {
  const db = await Db.open(':memory:');
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

test('import refreshes evidence but never overwrites human-entered fields', async () => {
  const db = await Db.open(':memory:');
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

test('quality flag is computed when the file does not carry it', async () => {
  const db = await Db.open(':memory:');
  const text = 'item_code,description,sales_qty,sales_value,purchase_qty,purchase_value\nA,ok,100,1000,100,700\nB,suspect,100,1000,10,700\nC,nopurchase,100,1000,,\n';
  imp.commit(db, { kind: 'products', text, who: 'test' });
  assert.equal(db.get(`SELECT cost_data_quality q FROM products WHERE item_code='A'`).q, 'OK');
  assert.equal(db.get(`SELECT cost_data_quality q FROM products WHERE item_code='B'`).q, 'UOM_SUSPECT');
  assert.equal(db.get(`SELECT cost_data_quality q FROM products WHERE item_code='C'`).q, 'NO_PURCHASE_DATA');
  assert.equal(db.get(`SELECT implied_margin_pct m FROM products WHERE item_code='A'`).m, 30);
});

test('reconciliation total is the sum of the FY sales value column', async () => {
  const db = await Db.open(':memory:');
  seedSample(db);
  const chk = imp.check(db, { kind: 'products', text: readSample('seed_products.csv') });
  assert.equal(imp.reconcileTotal(db).total_sen, chk.totals.fy_sales_value_sen);
});

test('customers: tier from rules unless overridden; salesperson logins created', async () => {
  const db = await Db.open(':memory:');
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

test('price list import: wide and long formats, append-only, idempotent', async () => {
  const db = await Db.open(':memory:');
  seedSample(db);
  const wide = 'item_code 货号,list_STD 目录价,floor_STD 底价,list_KEY,floor_KEY,effective_from\n9.EC22,6.10,5.80,5.95,5.70,2026-10-01\nSXLSK,4.23,,,,\nNOPE,1,1,,,\n';
  const r = imp.commit(db, { kind: 'auto', text: wide, filename: 'prices.csv', who: 'fin' });
  assert.equal(r.kind, 'prices');
  assert.equal(r.summary.changed, 3);
  assert.equal(r.summary.skipped_reasons.unknown_product, 1);
  assert.equal(db.get(`SELECT list_price_sen l, floor_price_sen f FROM product_prices WHERE item_code='9.EC22' AND price_tier='KEY' AND effective_to IS NULL`).l, 595);
  assert.equal(db.get(`SELECT floor_price_sen f FROM product_prices WHERE item_code='SXLSK' AND price_tier='STD' AND effective_to IS NULL`).f, 423); // floor defaults to list
  const again = imp.commit(db, { kind: 'prices', text: wide, filename: 'prices.csv', who: 'fin', force: true });
  assert.equal(again.summary.changed, 0);
  const long = 'item_code,price_tier,list_price,floor_price\n9.EC22,STD,6.20,5.90\n';
  imp.commit(db, { kind: 'prices', text: long, who: 'fin' });
  assert.equal(db.all(`SELECT * FROM product_prices WHERE item_code='9.EC22' AND price_tier='STD'`).length, 2);
});

test('users import creates logins with default password and never changes existing passwords', async () => {
  const db = await Db.open(':memory:');
  const text = 'username,display_name,role,salesperson_code,password\nyunjun,Yun Jun Ooi,finance,,\nali,Ali,salesperson,ALI,ali-first\n';
  const r = imp.commit(db, { kind: 'users', text, who: 'owner' });
  assert.equal(r.summary.inserted, 2);
  const before = db.get(`SELECT password_hash h FROM users WHERE username='ali'`).h;
  const r2 = imp.commit(db, { kind: 'users', text: text.replace('Ali,', 'Ali B,'), who: 'owner' });
  assert.equal(r2.summary.updated, 1);
  assert.equal(db.get(`SELECT password_hash h FROM users WHERE username='ali'`).h, before);
  assert.equal(db.get(`SELECT role FROM users WHERE username='yunjun'`).role, 'finance');
});

test('customer import honours an explicit price_tier_override column', async () => {
  const db = await Db.open(':memory:');
  seedSample(db);
  imp.commit(db, { kind: 'customers', text: 'customer_code,price_tier,price_tier_override\nC0001,KEY,Y\nC0002,KEY,\n', who: 'fin' });
  assert.deepEqual({ ...db.get(`SELECT price_tier t, price_tier_override o FROM customers WHERE customer_code='C0001'`) }, { t: 'KEY', o: 1 });
  assert.deepEqual({ ...db.get(`SELECT price_tier t, price_tier_override o FROM customers WHERE customer_code='C0002'`) }, { t: 'KEY', o: 0 });
  // rules leave the override alone
  db.run(`INSERT INTO tier_rules VALUES ('*','*','SML')`);
  imp.commit(db, { kind: 'customers', text: readSample('seed_customers.csv'), who: 'fin', force: true });
  assert.equal(db.get(`SELECT price_tier t FROM customers WHERE customer_code='C0001'`).t, 'KEY');
  assert.equal(db.get(`SELECT price_tier t FROM customers WHERE customer_code='C0002'`).t, 'SML');
});

test('UOM worksheet import applies human entries through the audited product update, and later rounds overwrite', async () => {
  const db = await Db.open(':memory:');
  seedSample(db);
  const sheet = 'item_code 货号,description,implied_unit_cost 推算,uom_purchase 采购单位,uom_selling,uom_factor 换算系数,suggested_cost,verified_unit_cost 核实成本 (RM),no_purchase_confirmed 确认无采购,notes\n9.EC22,EC22A+LID,121.80,CTN,PKT,25,4.87,4.87,,checked invoice\n70.JP9,JSP,53.96,,,,,,,\nSI001,Singlet,,,,,,,Y,old stock\n';
  const chk = imp.check(db, { kind: 'auto', text: sheet });
  assert.equal(chk.kind, 'uom');
  const r = imp.commit(db, { kind: 'auto', text: sheet, filename: 'uom.csv', who: 'yunjun' });
  assert.equal(r.summary.changed, 2);
  const p = db.get(`SELECT * FROM products WHERE item_code = '9.EC22'`);
  assert.equal(p.uom_factor, 25); assert.equal(p.verified_unit_cost_sen, 487); assert.equal(p.cost_updated_by, 'yunjun');
  assert.equal(db.get(`SELECT no_purchase_confirmed n FROM products WHERE item_code = 'SI001'`).n, 1);
  assert.ok(db.get(`SELECT COUNT(*) c FROM audit_log WHERE entity = 'products' AND entity_id = '9.EC22' AND field = 'verified_unit_cost_sen'`).c === 1);
  // round two corrects the factor: overwrite, unlike the products import
  imp.commit(db, { kind: 'uom', text: 'item_code,uom_factor,verified_unit_cost\n9.EC22,24,5.08\n', who: 'yunjun' });
  assert.equal(db.get(`SELECT uom_factor f, verified_unit_cost_sen c FROM products WHERE item_code = '9.EC22'`).c, 508);
});
