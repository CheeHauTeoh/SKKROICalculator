// Seed helpers shared by the CLI and the serverless runtime.
import * as imp from './importer.js';

// Files are imported in dependency order. Names are matched loosely (seed_products.csv, products.csv, ...).
export const ORDER = [
  ['products', /(?<!customer_)products?/i], ['customers', /customer(?!_product)/i], ['sales', /(customer_products|sales)/i],
  ['purchases', /purchase/i], ['bundles', /bundle/i], ['crosssell', /cross/i],
];

/** texts: { filename: csvText }. Returns [{kind, file, result|skipped_reason}] in import order. */
export function seedFromTexts(db, texts, { who = 'seed', log = () => {} } = {}) {
  const files = Object.keys(texts).filter(f => f.toLowerCase().endsWith('.csv'));
  const used = new Set(); const out = [];
  for (const [kind, re] of ORDER) {
    for (const f of files.filter(f => re.test(f) && !used.has(f))) {
      const chk = imp.check(db, { kind, text: texts[f], filename: f });
      if (chk.missing.length) { out.push({ kind, file: f, skipped_reason: `missing ${chk.missing.join(', ')}` }); log(`[${kind}] ${f}: SKIPPED, missing required columns ${chk.missing.join(', ')} (headers: ${chk.headers.join(' | ')})`); continue; }
      used.add(f);
      const r = imp.commit(db, { kind, text: texts[f], filename: f, who });
      out.push({ kind, file: f, result: r.skipped ? 'already imported' : r.summary, unmapped: chk.unmapped, warnings: chk.warning_count });
      log(`[${kind}] ${f}: ${r.skipped ? 'already imported (no changes)' : JSON.stringify(r.summary)}`);
      if (chk.unmapped.length) log(`   unmapped columns ignored: ${chk.unmapped.join(', ')}`);
      if (chk.warning_count) log(`   ${chk.warning_count} warnings, first: ${chk.warnings[0]}`);
    }
  }
  for (const f of files.filter(f => !used.has(f))) { out.push({ file: f, skipped_reason: 'not recognised by name' }); log(`[?] ${f}: not recognised by name; use "check" to see what it maps to`); }
  return out;
}

/** Wipe business data (products, prices, customers, captures, audit, imports). Users and settings are kept. */
export function resetBusinessData(db) {
  db.transaction(() => {
    for (const t of ['market_refs', 'product_prices', 'field_prices', 'crosssell_gaps', 'bundles', 'customer_products', 'customers', 'products', 'audit_log', 'imports', 'tier_rules'])
      db.run(`DELETE FROM ${t}`);
  });
}
