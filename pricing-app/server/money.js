// Money is stored as integer sen. Nothing in this module goes through a float.

const CLEAN = /[^0-9.\-]/g;

/** Parse "1,234.567", "RM 12.30", "-0.5", 12.3 -> integer sen (rounded half-up on the 3rd decimal). Empty -> null. */
export function parseSen(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (s === '' || s === '-' || /^(na|n\/a|null|none|-)$/i.test(s)) return null;
  // Handle exponent notation from spreadsheets, e.g. "1.2e3", by expanding via BigInt-safe string math.
  if (/e/i.test(s)) s = expandExponent(s);
  s = s.replace(CLEAN, '');
  if (s === '' || s === '-' || s === '.' ) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  if (s.includes('-')) return null; // stray sign
  const [whole = '0', fracRaw = ''] = s.split('.');
  if (s.split('.').length > 2) return null;
  const frac = (fracRaw + '000').slice(0, 3);
  let sen = BigInt(whole || '0') * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) sen += 1n;
  const out = Number(neg ? -sen : sen);
  return Number.isSafeInteger(out) ? out : null;
}

function expandExponent(s) {
  const m = /^(-?)(\d*)(?:\.(\d*))?e([+-]?\d+)$/i.exec(s.replace(/[,\s]/g, ''));
  if (!m) return s;
  const [, sign, ip, fp = '', ex] = m;
  let digits = ip + fp;
  let point = ip.length + Number(ex);
  if (point <= 0) digits = '0'.repeat(1 - point) + digits, point = 1;
  if (point > digits.length) digits = digits + '0'.repeat(point - digits.length);
  return sign + digits.slice(0, point) + '.' + digits.slice(point);
}

/** integer sen -> "1,234.50" (no currency prefix). null -> ''. */
export function formatSen(sen, { grouping = true } = {}) {
  if (sen === null || sen === undefined || Number.isNaN(sen)) return '';
  const neg = sen < 0;
  const abs = Math.abs(Math.trunc(sen));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const w = grouping ? whole.toLocaleString('en-MY') : String(whole);
  return `${neg ? '-' : ''}${w}.${frac}`;
}

/** Divide sen by a quantity, returning integer sen (round half-up). null when qty is 0/absent. */
export function divideSen(sen, qty) {
  if (sen === null || sen === undefined || !qty || !Number.isFinite(qty)) return null;
  const q = Math.round(Number(qty) * 1_000_000); // qty to 6dp fixed-point
  if (q === 0) return null;
  const num = BigInt(Math.trunc(sen)) * 1_000_000n * 2n;
  const den = BigInt(q) * 2n;
  const res = (num + BigInt(q)) / den; // (2a + b) / 2b -> round half up
  return Number(res);
}

/** Multiply sen by a decimal factor (e.g. 1 - margin), rounding half-up to sen. */
export function mulSen(sen, factor) {
  if (sen === null || sen === undefined || !Number.isFinite(factor)) return null;
  const f = Math.round(factor * 1_000_000);
  const num = BigInt(Math.trunc(sen)) * BigInt(f) * 2n + 1_000_000n;
  return Number(num / 2_000_000n);
}

/** Margin % = (price - cost) / price * 100, to 1dp. null if either missing or price is 0. */
export function marginPct(priceSen, costSen) {
  if (priceSen === null || priceSen === undefined || costSen === null || costSen === undefined) return null;
  if (!priceSen) return null;
  return Math.round(((priceSen - costSen) / priceSen) * 1000) / 10;
}

/** list price from cost and target margin %: cost / (1 - m). */
export function priceFromMargin(costSen, marginPercent) {
  if (costSen === null || costSen === undefined || !Number.isFinite(marginPercent) || marginPercent >= 100) return null;
  return mulSen(costSen, 1 / (1 - marginPercent / 100));
}

export function parseNumber(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[,\s]/g, '').replace(/%$/, '');
  if (s === '' || /^(na|n\/a|null|none|-)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseBool(input) {
  if (input === null || input === undefined) return 0;
  const s = String(input).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 't', 'x', '✓'].includes(s) ? 1 : 0;
}
