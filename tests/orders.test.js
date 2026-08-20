/**
 * Tests for bin/orders.js — zero dependencies, plain node.
 *
 *     node tests/orders.test.js
 *
 * The CSV cases are not theoretical. Amazon's export quotes product names containing commas,
 * embeds literal newlines inside gift messages, ships a UTF-8 BOM that corrupts the first
 * header name, and writes "Not Available" where a value is missing. Each of those silently
 * shears rows apart or poisons an aggregate rather than throwing, which is why they are pinned
 * here rather than left to be noticed later in a spend total that looks plausible.
 */
'use strict';

const assert = require('assert');
const { parseCsv, mapColumns, normalise, toDate, toNum, val, isCancelled } =
  require('../bin/orders.js');

let passed = 0;
const failures = [];
function eq(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); passed++; }
  catch { failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`); }
}

/* ----------------------------------------------------------------- CSV --- */

eq('csv basic', parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
eq('csv crlf', parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
eq('csv strips BOM from first header',
  parseCsv('﻿Order ID,ASIN\n111,B01')[0], ['Order ID', 'ASIN']);
eq('csv quoted comma inside a product name',
  parseCsv('name,qty\n"Anker USB-C Cable, 2-Pack",1')[1], ['Anker USB-C Cable, 2-Pack', '1']);
eq('csv escaped double quote',
  parseCsv('name\n"He said ""hi"""')[1], ['He said "hi"']);
eq('csv newline inside a quoted field',
  parseCsv('a,b\n"line1\nline2",x')[1], ['line1\nline2', 'x']);
eq('csv empty trailing field', parseCsv('a,b\n1,')[1], ['1', '']);
eq('csv ignores blank trailing line', parseCsv('a,b\n1,2\n\n').length, 2);

/* ------------------------------------------------------------- columns --- */

const HEADER = ['Website', 'Order ID', 'Order Date', 'Currency', 'Unit Price', 'Total Owed',
                'ASIN', 'Product Condition', 'Quantity', 'Order Status', 'Product Name',
                'Shipping Address'];
const m = mapColumns(HEADER);
eq('maps Order ID', m.orderId, 1);
eq('maps Order Date', m.date, 2);
eq('maps ASIN', m.asin, 6);
eq('maps Product Name', m.name, 10);
eq('maps Total Owed', m.total, 5);
// Amazon renames columns between exports; matching must survive that.
const m2 = mapColumns(['Order ID', 'Shipment Date', 'ASIN/ISBN', 'Title', 'Item Quantity',
                       'Purchase Price Per Unit', 'Item Total', 'Shipment Status']);
eq('maps renamed date column', m2.date, 1);
eq('maps ASIN/ISBN', m2.asin, 2);
eq('maps Title as name', m2.name, 3);
eq('maps Purchase Price Per Unit', m2.unitPrice, 5);

/* ------------------------------------------------------------ scalars --- */

eq('date from ISO timestamp', toDate('2024-03-05T08:22:31Z'), '2024-03-05');
eq('date from US locale', toDate('3/5/2024'), '2024-03-05');
eq('date pads single digits', toDate('12/7/2023'), '2023-12-07');
eq('date from Not Available', toDate('Not Available'), null);
eq('date from garbage', toDate('sometime'), null);

eq('num plain', toNum('12.99'), 12.99);
eq('num with currency symbol', toNum('$12.99'), 12.99);
eq('num negative refund', toNum('-4.50'), -4.5);
eq('num Not Available', toNum('Not Available'), null);
eq('num empty', toNum(''), null);

eq('val blanks Not Available', val('Not Available'), null);
eq('val blanks Not Applicable', val('Not Applicable'), null);
eq('val blanks empty', val('   '), null);
eq('val keeps real text', val(' Anker '), 'Anker');

eq('cancelled detected', isCancelled('Cancelled'), true);
eq('cancelled lowercase', isCancelled('order cancelled'), true);
eq('shipped is not cancelled', isCancelled('Shipped'), false);
eq('null status is not cancelled', isCancelled(null), false);

/* ----------------------------------------------------------- normalise --- */

const CSV = [
  'Website,Order ID,Order Date,Currency,Unit Price,Total Owed,ASIN,Product Condition,Quantity,Order Status,Product Name,Shipping Address',
  'Amazon.com,111-1,2024-03-05T08:22:31Z,USD,12.99,12.99,B07DC5PPFV,New,1,Shipped,"Anker USB-C Cable, 2-Pack",123 Fake St',
  'Amazon.com,111-2,2025-01-10T10:00:00Z,USD,14.99,14.99,B07DC5PPFV,New,1,Shipped,"Anker USB-C Cable, 2-Pack",123 Fake St',
  'Amazon.com,111-3,2025-02-01T10:00:00Z,USD,99.00,99.00,B0CHFS9K14,New,1,Cancelled,Samsung T9 2TB,123 Fake St',
  'Amazon.com,111-4,Not Available,USD,Not Available,7.50,B0765LJWFZ,New,2,Shipped,Widget,123 Fake St',
].join('\n');

const n = normalise(parseCsv(CSV), 'test.csv');
eq('normalise row count', n.orders.length, 4);
eq('normalise parses date', n.orders[0].date, '2024-03-05');
eq('normalise upper-cases ASIN', n.orders[0].asin, 'B07DC5PPFV');
eq('normalise keeps quoted name intact', n.orders[0].name, 'Anker USB-C Cable, 2-Pack');
eq('normalise flags cancelled', n.orders[2].cancelled, true);
eq('normalise leaves shipped unflagged', n.orders[0].cancelled, undefined);
eq('normalise nulls Not Available price', n.orders[3].unitPrice, null);
eq('normalise nulls Not Available date', n.orders[3].date, null);
eq('normalise keeps quantity', n.orders[3].qty, 2);
// Address must never be carried into the store, even though the column is present.
eq('normalise does not read the address column',
  JSON.stringify(n.orders[0]).includes('Fake St'), false);

const empty = normalise(parseCsv('Some Other Export\nfoo'), 'other.csv');
eq('normalise rejects a non-order file', empty.orders.length, 0);
eq('normalise warns on a non-order file', typeof empty.warn, 'string');

/* --------------------------------------------------------------- report --- */

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`All ${passed} order tests passed.`);
