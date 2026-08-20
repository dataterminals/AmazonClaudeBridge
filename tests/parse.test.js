/**
 * Parser tests for amazon-claude-bridge.user.js — zero dependencies, plain node.
 *
 *     node tests/parse.test.js
 *
 * These cover the pure string/number parsers, not the selectors. Selectors can only be
 * checked against the live site (see docs/API.md — `__amzx.health()`); everything here is
 * DOM-free and therefore worth pinning, because every case below is a real defect that was
 * caught by running the extractor against amazon.com on 2026-08-20 rather than by reading it.
 *
 * The userscript is an IIFE that publishes onto `window`, so we stub a bare window, eval the
 * file, and reach in through the documented `_internals` handle.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'amazon-claude-bridge.user.js');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

const amzx = sandbox.window.__amzx;
if (!amzx) {
  console.error('FAIL: the script did not publish window.__amzx at all.');
  process.exit(1);
}
const { clean, clip, money, num, currency, compact, asinFrom, txtOf, unitPrice } = amzx._internals;

let passed = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

/* ---------------------------------------------------------------- num() ---
 * The one that mattered. Search results render review counts abbreviated, so a
 * strip-the-non-digits reading of "(22.2K)" yields 222 — wrong by ~100x, and wrong
 * *silently*, which is the dangerous part. Live values, captured 2026-08-20.
 */
eq('num abbreviated thousands', num('(22.2K)'), 22200);
eq('num abbreviated, big', num('(147.1K)'), 147100);
eq('num abbreviated millions', num('1.4M'), 1400000);
eq('num lowercase suffix', num('22.2k'), 22200);
eq('num comma-grouped (product page form)', num('(147,109)'), 147109);
eq('num with trailing words', num('1,234 ratings'), 1234);
eq('num plain', num('12 people found this helpful'), 12);
eq('num no digits', num('One person found this helpful'), null);
eq('num empty', num(''), null);
eq('num null', num(null), null);

/* -------------------------------------------------------------- money() --- */
eq('money simple', money('$9.99'), 9.99);
eq('money grouped', money('$1,234.56'), 1234.56);
eq('money with prefix', money('US$12.34'), 12.34);
eq('money decimal comma', money('12,34 EUR'), 12.34);
eq('money grouped decimal comma', money('1.234,56'), 1234.56);
eq('money no number', money('Currently unavailable'), null);
eq('money null', money(null), null);

/* ----------------------------------------------------------- currency() --- */
eq('currency usd', currency('$9.99'), 'USD');
eq('currency gbp', currency('£9.99'), 'GBP');
eq('currency eur', currency('9,99€'), 'EUR');
eq('currency unknown', currency('9.99'), null);

/* --------------------------------------------------------- unitPrice() ---
 * "($0.83$0.83 / feet)" — the offscreen span and the visible span both land in
 * textContent, so the figure arrives doubled. Verified live on B07DC5PPFV.
 */
eq('unit price de-duplicated', unitPrice('($0.83$0.83 / feet)'), '$0.83 / feet');
eq('unit price already clean', unitPrice('($0.83 / feet)'), '$0.83 / feet');
eq('unit price count units', unitPrice('($4.50$4.50 / Count)'), '$4.50 / Count');
eq('unit price empty', unitPrice(''), null);
eq('unit price null', unitPrice(null), null);

/* ------------------------------------------------------------- clean() --- */
eq('clean collapses whitespace', clean('  a\n\t  b  '), 'a b');
eq('clean strips zero-width', clean('An​ker­'), 'Anker');
eq('clean empty becomes null', clean('   '), null);
eq('clean null', clean(null), null);

/* -------------------------------------------------------------- clip() --- */
eq('clip truncates with ellipsis', clip('abcdefghij', 5), 'abcd…');
eq('clip leaves short strings', clip('abc', 5), 'abc');

/* ----------------------------------------------------------- asinFrom() --- */
eq('asin from /dp/ with query', asinFrom('https://www.amazon.com/dp/B07DC5PPFV?th=1'), 'B07DC5PPFV');
eq('asin from /gp/product/', asinFrom('/gp/product/B07SMNZK8H'), 'B07SMNZK8H');
eq('asin from /product-reviews/', asinFrom('/product-reviews/B0H5RJBPFR/?sortBy=recent'), 'B0H5RJBPFR');
eq('asin from long slug url', asinFrom('https://www.amazon.com/Anker-USB-Cable/dp/B07DC5PPFV/ref=sr_1_3'), 'B07DC5PPFV');
eq('asin absent on search page', asinFrom('https://www.amazon.com/s?k=usb+c+cable'), null);
eq('asin null input', asinFrom(null), null);

/* ----------------------------------------------------------- compact() ---
 * Compactness is the whole reason this library exists, so prove the pruning is recursive.
 */
eq('compact drops nulls', compact({ a: 1, b: null }), { a: 1 });
eq('compact drops empty objects', compact({ a: 1, b: {} }), { a: 1 });
eq('compact drops empty arrays', compact({ a: 1, b: [] }), { a: 1 });
eq('compact prunes recursively', compact({ a: { b: { c: null } }, d: 2 }), { d: 2 });
eq('compact keeps false', compact({ a: false }), { a: false });
eq('compact keeps zero', compact({ a: 0 }), { a: 0 });
eq('compact filters array holes', compact([1, null, 2]), [1, 2]);
eq('compact all-empty becomes null', compact({ a: null, b: [] }), null);

/* -------------------------------------------------------------- txtOf() ---
 * #acBadge_feature_div contains a <style> block on products with no badge, so raw
 * textContent returns CSS — which reads as a present value and fabricates a badge.
 */
const withStyle = {
  textContent: 'REAL .mvt-ac-badge-rectangle { border-radius:4px }',
  querySelector: () => ({}),
  cloneNode: () => ({ textContent: 'REAL', querySelectorAll: () => [] }),
};
eq('txtOf strips style payloads', txtOf(withStyle), 'REAL');

const plain = { textContent: '  Anker  ', querySelector: () => null };
eq('txtOf passes plain nodes through', txtOf(plain), 'Anker');
eq('txtOf null element', txtOf(null), null);

/* ------------------------------------------------------- surface check --- */
for (const fn of ['page', 'product', 'search', 'reviews', 'offers',
                  'full', 'health', 'text']) {
  eq(`API exposes ${fn}()`, typeof amzx[fn], 'function');
}
eq('API reports a version', typeof amzx.version, 'string');
eq('SEL registry is published for maintenance', typeof amzx.SEL.product.title, 'object');

/* --------------------------------------------------------------- report --- */
if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`All ${passed} parser tests passed.`);
