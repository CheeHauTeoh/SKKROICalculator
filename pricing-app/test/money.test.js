import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSen, formatSen, divideSen, mulSen, marginPct, priceFromMargin } from '../server/money.js';

test('parseSen parses strings without floats', () => {
  assert.equal(parseSen('1,234.56'), 123456);
  assert.equal(parseSen('RM 12.30'), 1230);
  assert.equal(parseSen('0.1'), 10);
  assert.equal(parseSen('0.005'), 1);     // half-up on third decimal
  assert.equal(parseSen('0.004'), 0);
  assert.equal(parseSen('-2.5'), -250);
  assert.equal(parseSen(''), null);
  assert.equal(parseSen('n/a'), null);
  assert.equal(parseSen('1.2e3'), 120000);
  assert.equal(parseSen(4.86), 486);
  assert.equal(parseSen('27521859'), 2752185900);
});

test('formatSen', () => {
  assert.equal(formatSen(123456), '1,234.56');
  assert.equal(formatSen(5), '0.05');
  assert.equal(formatSen(-250), '-2.50');
  assert.equal(formatSen(null), '');
});

test('divideSen / mulSen / margin', () => {
  assert.equal(divideSen(20949600, 1720), 12180);    // RM209,496 / 1720 ctn = RM121.80
  assert.equal(divideSen(20023200, 41200), 486);     // RM200,232 / 41,200 pkt = RM4.86
  assert.equal(divideSen(1000, 0), null);
  assert.equal(divideSen(12180, 25), 487);           // carton cost / 25 pkts -> RM4.87 (rounded)
  assert.equal(mulSen(10000, 0.95), 9500);
  assert.equal(marginPct(486, 12180), -2406.2);
  assert.equal(marginPct(423, 223), 47.3);
  assert.equal(marginPct(0, 100), null);
  assert.equal(priceFromMargin(300, 25), 400);
  assert.equal(priceFromMargin(300, 100), null);
});
