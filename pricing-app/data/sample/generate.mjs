// Generates a SYNTHETIC sample dataset in the shape DATA_SPEC.md describes. Numbers are invented.
// Use it only to try the app. Real data goes in data/seed/ (see data/seed/README.md).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));

let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const r2 = n => (Math.round(n * 100) / 100).toFixed(2);
const csvq = s => `"${String(s).replace(/"/g, '""')}"`;

const cats = {
  'Plastic bags': ['Singlet bag', 'Rubbish bag', 'Garbage bag'], 'Disposables': ['Food container', 'Plate', 'Cup', 'Cutlery'],
  'Paper': ['Greaseproof paper', 'Paper bag', 'Tissue'], 'Beverages': ['Coffee', 'Tea', 'Creamer'], 'F&B consumables': ['Sauce', 'Cordial', 'Sugar'],
};
const brands = ['Seamaster', 'LYG', 'Good World', 'Nestle', 'Sadji', 'Rosmuni'];
const products = [
  // The three examples from DATA_SPEC section 3, with the same implied numbers.
  { item_code: '9.EC22', description: 'EC22A+LID', category: 'Disposables', subcategory: 'Food container', core: 1, branded: 0, sqty: 41200, sval: 200232, pqty: 1720, pval: 209496, pu: 'CTN', su: 'PKT' },
  { item_code: '70.JP9', description: 'JSP 9" plate', category: 'Disposables', subcategory: 'Plate', core: 1, branded: 0, sqty: 9800, sval: 189238, pqty: 3400, pval: 183464, pu: 'BALE', su: 'PKT' },
  { item_code: 'SXLSK', description: 'Rubbish bag XL', category: 'Plastic bags', subcategory: 'Rubbish bag', core: 1, branded: 0, sqty: 60100, sval: 254223, pqty: 58000, pval: 129340, pu: 'PKT', su: 'PKT' },
];
let n = 0;
for (const [cat, subs] of Object.entries(cats)) {
  for (const sub of subs) {
    for (let i = 1; i <= 4; i++) {
      n++;
      const branded = cat === 'Beverages' || (cat === 'F&B consumables' && rnd() < 0.6);
      const brand = branded ? pick(brands) : '';
      const core = n <= 40 ? 1 : (rnd() < 0.25 ? 1 : 0);
      const code = `${sub.slice(0, 2).toUpperCase()}${String(n).padStart(3, '0')}`;
      const sqty = Math.round(2000 + rnd() * 40000);
      const price = 1 + rnd() * 30;
      const sval = sqty * price;
      const kind = rnd();
      let pqty, pval, pu = 'PKT', su = 'PKT';
      if (kind < 0.55) { pqty = sqty * (0.9 + rnd() * 0.2); pval = pqty * price * (0.6 + rnd() * 0.3); } // OK
      else if (kind < 0.85) { const f = pick([12, 24, 50, 100]); pu = pick(['CTN', 'BALE']); pqty = Math.round(sqty / f); pval = sqty * price * (0.6 + rnd() * 0.3); } // UOM_SUSPECT
      else { pqty = ''; pval = ''; } // NO_PURCHASE_DATA
      products.push({ item_code: code, description: `${brand ? brand + ' ' : ''}${sub} ${i}${pu !== 'PKT' ? ' x' + (pu === 'CTN' ? 24 : 50) : ''}`, category: cat, subcategory: sub, core, branded: branded ? 1 : 0, brand, sqty, sval, pqty, pval, pu, su });
    }
  }
}


const types = ['Kedai runcit', 'Restaurant', 'Hypermarket', 'Hawker', 'Wholesaler'];
const sizes = ['S', 'M', 'L'];
const sps = ['ALI', 'CHONG', 'MUTHU'];
const customers = [];
for (let i = 1; i <= 36; i++) {
  const type = pick(types); const size = pick(sizes);
  customers.push({ customer_code: `C${String(i).padStart(4, '0')}`, customer_name: `${type} ${['Kota Bharu', 'Pasir Mas', 'Tumpat', 'Bachok', 'Machang'][i % 5]} ${i}`, agent_code: `A${(i % 3) + 1}`, salesperson: sps[i % 3], customer_type: type, buying_breadth: pick(['narrow', 'medium', 'wide']), size_tier: size, price_tier: '', status: 'active' });
}
// customer_products (sales rows): each customer buys 8-20 items
const cp = [];
for (const c of customers) {
  const k = 8 + Math.floor(rnd() * 12);
  const chosen = new Set();
  while (chosen.size < k) chosen.add(pick(products));
  let total = 0;
  for (const p of chosen) { const qty = Math.round(50 + rnd() * 1500); const val = qty * (p.sval / p.sqty) * (0.95 + rnd() * 0.1); total += val; cp.push([c.customer_code, p.item_code, qty, r2(val)]); }
  c.fy_value = r2(total);
}
writeFileSync(join(here, 'seed_customers.csv'), ['customer_code,customer_name,agent_code,salesperson,customer_type,buying_breadth,size_tier,price_tier,status,fy_value',
  ...customers.map(c => [c.customer_code, csvq(c.customer_name), c.agent_code, c.salesperson, csvq(c.customer_type), c.buying_breadth, c.size_tier, c.price_tier, c.status, c.fy_value].join(','))].join('\n') + '\n');
// Make each product's FY sales evidence equal the sum of its customer rows (as a real UBS export would).
for (const p of products) { const mine = cp.filter(r => r[1] === p.item_code); if (mine.length) { p.sqty = mine.reduce((a, r) => a + r[2], 0); p.sval = mine.reduce((a, r) => a + Number(r[3]), 0); } }
const prodCsv = ['item_code,description,category,subcategory,brand,is_core_80,is_branded,uom_purchase_hint,uom_selling_hint,fy_sales_qty,fy_sales_value,fy_purchase_qty,fy_purchase_value,implied_unit_cost,implied_unit_price,implied_margin_pct,cost_data_quality'];
for (const p of products) {
  const cost = p.pqty ? p.pval / p.pqty : '';
  const price = p.sval / p.sqty;
  const margin = cost === '' ? '' : ((price - cost) / price) * 100;
  const q = cost === '' ? 'NO_PURCHASE_DATA' : margin >= 2 && margin <= 60 ? 'OK' : 'UOM_SUSPECT';
  prodCsv.push([p.item_code, csvq(p.description), p.category, p.subcategory, p.brand || '', p.core, p.branded, p.pu, p.su, p.sqty, r2(p.sval), p.pqty === '' ? '' : Math.round(p.pqty), p.pval === '' ? '' : r2(p.pval), cost === '' ? '' : r2(cost), r2(price), margin === '' ? '' : r2(margin), q].join(','));
}
writeFileSync(join(here, 'seed_products.csv'), prodCsv.join('\n') + '\n');
writeFileSync(join(here, 'seed_customer_products.csv'), ['customer_code,item_code,fy_qty,fy_value', ...cp.map(r => r.join(','))].join('\n') + '\n');

const bundles = ['bundle_id,customer_type,item_code,support_pct,lift,median_annual_value'];
for (const t of types) for (let b = 1; b <= 3; b++) { const items = new Set(); while (items.size < 3) items.add(pick(products.slice(0, 40)).item_code); for (const it of items) bundles.push([`${t.replace(/\s/g, '')}-B${b}`, csvq(t), it, r2(30 + rnd() * 60), r2(1.2 + rnd() * 2), r2(500 + rnd() * 8000)].join(',')); }
writeFileSync(join(here, 'seed_bundles.csv'), bundles.join('\n') + '\n');

const gaps = ['customer_code,item_code,peer_penetration_pct,estimated_annual_value'];
for (const c of customers) { const own = new Set(cp.filter(r => r[0] === c.customer_code).map(r => r[1])); let g = 0; for (const p of products.slice(0, 40)) if (!own.has(p.item_code) && rnd() < 0.2 && g < 6) { g++; gaps.push([c.customer_code, p.item_code, r2(40 + rnd() * 55), r2(300 + rnd() * 6000)].join(',')); } }
writeFileSync(join(here, 'seed_crosssell.csv'), gaps.join('\n') + '\n');
console.log(`sample: ${products.length} products, ${customers.length} customers, ${cp.length} customer-product rows, ${bundles.length - 1} bundle rows, ${gaps.length - 1} gap rows`);
