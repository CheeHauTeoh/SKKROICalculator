// CLI: seed <dir> | check <file> [kind] | reconcile
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createApp } from './app.js';
import * as imp from './importer.js';
import { seedFromTexts } from './seed.js';
import { formatSen } from './money.js';

const [cmd, ...args] = process.argv.slice(2);
const EXPECTED_TOTAL_SEN = 2_752_185_900; // RM27,521,859 per DATA_SPEC section 9

async function seed(dir) {
  if (!dir || !existsSync(dir)) { console.error(`seed: directory not found: ${dir}`); process.exit(2); }
  const app = await createApp();
  const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv'));
  if (!files.length) { console.error(`seed: no .csv files in ${dir}`); process.exit(2); }
  seedFromTexts(app.db, Object.fromEntries(files.map(f => [f, readFileSync(join(dir, f), 'utf8')])), { who: 'cli', log: console.log });
  reconcile(app);
  app.close();
}

function reconcile(app) {
  const r = imp.reconcileTotal(app.db);
  const ok = r.total_sen === EXPECTED_TOTAL_SEN;
  console.log(`Products: ${r.products} (core: ${r.core}). FY sales value in product table: RM ${formatSen(r.total_sen)} ` +
    `${ok ? '== RM 27,521,859 ✔' : `(spec expects RM 27,521,859; difference RM ${formatSen(r.total_sen - EXPECTED_TOTAL_SEN)})`}`);
}

async function check(file, kind = 'auto') {
  const app = await createApp({ dbPath: ':memory:' });
  const text = readFileSync(file, 'utf8');
  const { _rows, preview, ...r } = imp.check(app.db, { kind, text, filename: basename(file) });
  console.log(JSON.stringify({ ...r, preview }, null, 2));
  app.close();
}

switch (cmd) {
  case 'seed': await seed(args[0]); break;
  case 'check': await check(args[0], args[1]); break;
  case 'reconcile': { const app = await createApp(); reconcile(app); app.close(); break; }
  default: console.log('usage: node server/cli.js seed <dir> | check <file.csv> [kind] | reconcile'); process.exit(1);
}
