import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../server/csv.js';

test('parseCsv handles quotes, BOM and CRLF', () => {
  const { headers, rows } = parseCsv('﻿item_code,description\r\n70.JP9,"JSP 9"" plate"\r\nA1,"has, comma"\r\n\r\n');
  assert.deepEqual(headers, ['item_code', 'description']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].description, 'JSP 9" plate');
  assert.equal(rows[1].description, 'has, comma');
});

test('toCsv round-trips', () => {
  const text = toCsv([{ a: 'x,y', b: 'q"q' }, { a: '1', b: '' }]);
  const { rows } = parseCsv(text);
  assert.deepEqual(rows, [{ a: 'x,y', b: 'q"q' }, { a: '1', b: '' }]);
});
