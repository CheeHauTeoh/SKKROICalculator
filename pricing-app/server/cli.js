// CLI: seed <dir> | check <file> [kind] | reconcile
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createApp } from './app.js';
import * as imp from './importer.js';
import { formatSen } from './money.js';

const [cmd, ...args] = process.argv.slice(2);
const EXPECTED_TOTAL_SEN = 2_752_185_900; // RM27,521,859 per DATA_SPEC section 9

// Files are imported in dependency order. Names are matched loosely (seed_products.csv, products.csv, ...).
const ORDER = [
  ['products', /product/i], ['customers', /customer(?!_product)/i], ['sales', /(customer_products|sales)/i],
  ['purchases', /purchase/i], ['bundles', /bundle/i], ['crosssell', /cross/i],
];

function seed(dir) {
  if (!dir || !existsSync(dir)) { console.error(`seed: directory not found: ${dir}`); process.exit(2); }
  const app = createApp();
  const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv'));
  if (!files.length) { console.error(`seed: no .csv files in ${dir}`); process.exit(2); }
  const used = new Set();
  for (const [kind, re] of ORDER) {
    for (const f of files.filter(f => re.test(f) && !used.has(f))) {
      const text = readFileSync(join(dir, f), 'utf8');
      const chk = imp.check(app.db, { kind, text, filename: f });
      if (chk.missing.length) { console.log(`[${kind}] ${f}: SKIPPED, missing required columns ${chk.missing.join(', ')} (headers: ${chk.headers.join(' | ')})`); continue; }
      used.add(f);
      const r = imp.commit(app.db, { kind, text, filename: f, who: 'cli' });
      console.log(`[${kind}] ${f}: ${r.skipped ? 'already imported (no changes)' : JSON.stringify(r.summary)}`);
      if (chk.unmapped.length) console.log(`   unmapped columns ignored: ${chk.unmapped.join(', ')}`);
      if (chk.warning_count) console.log(`   ${chk.warning_count} warnings, first: ${chk.warnings[0]}`);
    }
  }
  for (const f of files.filter(f => !used.has(f))) console.log(`[?] ${f}: not recognised by name; use "check" to see what it maps to`);
  reconcile(app);
  app.close();
}

function reconcile(app) {
  const r = imp.reconcileTotal(app.db);
  const ok = r.total_sen === EXPECTED_TOTAL_SEN;
  console.log(`Products: ${r.products} (core: ${r.core}). FY sales value in product table: RM ${formatSen(r.total_sen)} ` +
    `${ok ? '== RM 27,521,859 ✔' : `(spec expects RM 27,521,859; difference RM ${formatSen(r.total_sen - EXPECTED_TOTAL_SEN)})`}`);
}

function check(file, kind = 'auto') {
  const app = createApp({ dbPath: ':memory:' });
  const text = readFileSync(file, 'utf8');
  const { _rows, preview, ...r } = imp.check(app.db, { kind, text, filename: basename(file) });
  console.log(JSON.stringify({ ...r, preview }, null, 2));
  app.close();
}

switch (cmd) {
  case 'seed': seed(args[0]); break;
  case 'check': check(args[0], args[1]); break;
  case 'reconcile': { const app = createApp(); reconcile(app); app.close(); break; }
  default: console.log('usage: node server/cli.js seed <dir> | check <file.csv> [kind] | reconcile'); process.exit(1);
}
