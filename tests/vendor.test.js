/**
 * Tests for the vendored Tier-2 asset — zero dependencies, plain node.
 *
 *     node tests/vendor.test.js
 *
 * The skill injects `assets/amzx.min.js` into a live page when the userscript is absent. Two
 * things can go wrong and neither announces itself: the asset drifts out of sync with `src/`, so
 * a fixed bug quietly comes back; or the comment-stripping transform mangles the file, so it
 * fails inside a page rather than here. Both are checked below.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const { build, SRC, OUT } = require('../bin/vendor.js');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) passed++;
  else failures.push(label + (detail ? '\n    ' + detail : ''));
}

ok('vendored asset exists', fs.existsSync(OUT), 'run: node bin/vendor.js');
if (!fs.existsSync(OUT)) { console.error('FAIL: asset missing'); process.exit(1); }

const source = fs.readFileSync(SRC, 'utf8');
const vendored = fs.readFileSync(OUT, 'utf8');

ok('vendored asset is in sync with src/', vendored === build(source),
   'src/ changed without rebuilding. Run: node bin/vendor.js');

// The transform must not break the file. Evaluating it is the only test that proves that.
const sandbox = { window: {}, console };
vm.createContext(sandbox);
let evalError = null;
try { vm.runInContext(vendored, sandbox, { filename: OUT }); } catch (e) { evalError = e; }
ok('vendored asset evaluates without throwing', !evalError, evalError && evalError.message);
ok('vendored asset publishes window.__amzx', !!sandbox.window.__amzx);

if (sandbox.window.__amzx) {
  const srcBox = { window: {}, console };
  vm.createContext(srcBox);
  vm.runInContext(source, srcBox, { filename: SRC });

  ok('version matches src', sandbox.window.__amzx.version === srcBox.window.__amzx.version,
     'vendored ' + sandbox.window.__amzx.version + ' vs src ' + srcBox.window.__amzx.version);

  const a = Object.keys(sandbox.window.__amzx).sort().join(',');
  const b = Object.keys(srcBox.window.__amzx).sort().join(',');
  ok('API surface matches src', a === b, a + '\n    vs\n    ' + b);

  // Spot-check that stripping did not eat a parser. These are the two that silently
  // corrupted real numbers before they were pinned.
  const i = sandbox.window.__amzx._internals;
  ok('num() survives stripping', i.num('(22.2K)') === 22200);
  ok('money() survives stripping', i.money('$18.29$18.29') === 18.29);
}

// The point of vendoring is a smaller injection payload; if it ever grows past the source,
// the transform has broken rather than helped.
ok('vendored asset is smaller than source', Buffer.byteLength(vendored) < Buffer.byteLength(source),
   Buffer.byteLength(vendored) + ' vs ' + Buffer.byteLength(source));

if (failures.length) {
  console.error('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
  for (const f of failures) console.error('  x ' + f + '\n');
  process.exit(1);
}
console.log('All ' + passed + ' vendor tests passed. '
  + 'Asset ' + (Buffer.byteLength(vendored) / 1024).toFixed(1) + ' KB '
  + '(source ' + (Buffer.byteLength(source) / 1024).toFixed(1) + ' KB).');
