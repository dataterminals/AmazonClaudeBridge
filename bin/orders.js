#!/usr/bin/env node
'use strict';
/**
 * orders.js — ingest and query Amazon's "Request My Data" order-history export.
 *
 *   node bin/orders.js ingest <path-to-export.zip | dir | csv>
 *   node bin/orders.js asin   B07DC5PPFV
 *   node bin/orders.js search "usb c"
 *   node bin/orders.js stats
 *
 * WHY THIS EXISTS. Amazon's own order search is bad, and scraping order pages is worse — they
 * are a React app with per-deploy class hashes, and it is the one Amazon dataset available
 * officially. The export is a one-time request, arrives as CSV, and needs no maintenance ever
 * again. It answers the questions the live site cannot: have I bought this before, what did I
 * pay, how often do I rebuy it.
 *
 * ZERO DEPENDENCIES, by the same reasoning as OCRClaudeBridge: a tool that only runs after
 * `npm install` succeeds is a tool that stops running.
 *
 * PRIVACY. Everything written lands in store/, which is gitignored. This repo is public and
 * the data is a complete purchase history with addresses attached. Do not move the output
 * into the repo proper, do not paste rows into commits or issues, and drop the address and
 * payment columns on the way in — see PII_DROP below. They are not needed to answer any
 * question this tool exists to answer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STORE = process.env.AMZX_STORE || path.join(ROOT, 'store');

/* ------------------------------------------------------------------ CSV --- */

/**
 * RFC 4180 parser. Amazon's export quotes fields containing commas and, in gift messages and
 * product names, literal newlines — so a split(',') / split('\n') approach silently shears
 * rows apart and every count downstream is wrong. This is small enough to own.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // Strip a UTF-8 BOM; Amazon ships one and it corrupts the first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || '').trim());
}

/* -------------------------------------------------------------- columns --- */

// Matched loosely against lower-cased headers, because Amazon renames these between exports
// and a hard-coded header list turns a schema tweak into an empty result set.
const FIELD_ALIASES = {
  orderId:   ['order id', 'orderid'],
  date:      ['order date', 'orderdate', 'shipment date'],
  asin:      ['asin', 'asin/isbn'],
  name:      ['product name', 'title', 'item name'],
  qty:       ['quantity', 'item quantity'],
  unitPrice: ['unit price', 'purchase price per unit'],
  total:     ['total owed', 'item total', 'total charged', 'shipment item subtotal'],
  status:    ['order status', 'shipment status'],
  currency:  ['currency', 'currency code'],
  condition: ['product condition'],
  website:   ['website', 'marketplace'],
};

// Columns deliberately never read. Cuts the blast radius if store/ ever leaks.
const PII_DROP = ['shipping address', 'billing address', 'payment instrument type',
                  'gift recipient contact details', 'gift sender name', 'gift message',
                  'carrier name & tracking number', 'item serial number'];

function mapColumns(header) {
  const lower = header.map((h) => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let idx = lower.findIndex((h) => aliases.includes(h));
    if (idx === -1) idx = lower.findIndex((h) => aliases.some((a) => h.includes(a)));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

/* ------------------------------------------------------------ normalise --- */

// Amazon writes "Not Available" / "Not Applicable" where a value is missing. Left as-is these
// become string values that compare truthy and quietly poison every aggregate.
const BLANK = /^(not available|not applicable|n\/a|none|)$/i;
const val = (v) => {
  const s = String(v == null ? '' : v).trim();
  return BLANK.test(s) ? null : s;
};

const toNum = (v) => {
  const s = val(v);
  if (!s) return null;
  const m = s.replace(/[^\d.-]/g, '');
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : null;
};

// Exports carry ISO timestamps in some years and locale dates in others.
const toDate = (v) => {
  const s = val(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const isCancelled = (status) => /cancel/i.test(status || '');

function normalise(rows, sourceName) {
  if (!rows.length) return { orders: [], warn: `${sourceName}: file is empty` };
  const map = mapColumns(rows[0]);
  if (map.asin === undefined && map.name === undefined) {
    return { orders: [], warn: `${sourceName}: no ASIN or product-name column — not an order file` };
  }
  const get = (r, f) => (map[f] === undefined ? null : val(r[map[f]]));
  const orders = [];
  for (const r of rows.slice(1)) {
    const asin = get(r, 'asin');
    const name = get(r, 'name');
    if (!asin && !name) continue;
    const status = get(r, 'status');
    orders.push({
      date: toDate(get(r, 'date')),
      asin: asin ? asin.toUpperCase() : null,
      name: name ? name.slice(0, 180) : null,
      qty: toNum(get(r, 'qty')) || 1,
      unitPrice: toNum(get(r, 'unitPrice')),
      total: toNum(get(r, 'total')),
      currency: get(r, 'currency'),
      condition: get(r, 'condition'),
      status,
      cancelled: isCancelled(status) || undefined,
      orderId: get(r, 'orderId'),
    });
  }
  return { orders, columns: Object.keys(map) };
}

/* --------------------------------------------------------------- ingest --- */

function findCsvs(target) {
  const st = fs.statSync(target);
  if (st.isFile()) {
    if (/\.zip$/i.test(target)) return unzipToTemp(target);
    return [target];
  }
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.csv$/i.test(e.name)) out.push(p);
    }
  })(target);
  return out;
}

// No zip library, and adding one would break the zero-dependency rule for a single call.
function unzipToTemp(zip) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'amzx-orders-'));
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(dest)} -Force`],
      { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`could not unzip ${zip}. Extract it yourself and pass the folder instead.\n${e.message}`);
  }
  return findCsvs(dest);
}

function ingest(target) {
  const files = findCsvs(target);
  if (!files.length) throw new Error(`no CSV files found under ${target}`);

  const all = [];
  const seen = new Set();
  const report = [];
  for (const f of files) {
    const { orders, warn } = normalise(parseCsv(fs.readFileSync(f, 'utf8')), path.basename(f));
    if (warn) { report.push(`  skipped ${path.basename(f)} — ${warn.split('— ').pop()}`); continue; }
    let added = 0;
    for (const o of orders) {
      // Amazon splits one order across shipment rows and repeats items; key on the
      // combination rather than the order id alone or the count doubles.
      const key = [o.orderId, o.asin, o.date, o.qty, o.total].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(o);
      added++;
    }
    report.push(`  ${path.basename(f)} — ${added} items`);
  }

  all.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const live = all.filter((o) => !o.cancelled);

  // by-ASIN index: the artifact that makes "have I bought this?" an O(1), near-zero-token
  // lookup instead of a scan.
  const byAsin = {};
  for (const o of live) {
    if (!o.asin) continue;
    const e = byAsin[o.asin] || (byAsin[o.asin] = { n: 0, qty: 0, spent: 0, first: null, last: null, name: null });
    e.n++;
    e.qty += o.qty || 1;
    if (o.total) e.spent = Math.round((e.spent + o.total) * 100) / 100;
    if (o.date && (!e.first || o.date < e.first)) e.first = o.date;
    if (o.date && (!e.last || o.date > e.last)) { e.last = o.date; e.lastPrice = o.unitPrice || o.total; }
    if (!e.name && o.name) e.name = o.name;
  }

  fs.mkdirSync(STORE, { recursive: true });
  write('orders.json', { generatedFrom: files.length + ' file(s)', items: all.length, orders: all });
  write('by-asin.json', byAsin);
  fs.writeFileSync(path.join(STORE, 'ORDERS.md'), summaryMarkdown(live, byAsin), 'utf8');

  console.log(`Ingested ${all.length} items (${all.length - live.length} cancelled) from:`);
  console.log(report.join('\n'));
  console.log(`\nWrote to ${STORE}:\n  orders.json, by-asin.json, ORDERS.md`);
  console.log(`\n${Object.keys(byAsin).length} distinct ASINs. store/ is gitignored — keep it that way.`);
}

const write = (name, obj) =>
  fs.writeFileSync(path.join(STORE, name), JSON.stringify(obj, null, 1), 'utf8');

/* -------------------------------------------------------------- reports --- */

function summaryMarkdown(live, byAsin) {
  const byYear = {};
  for (const o of live) {
    const y = (o.date || '____').slice(0, 4);
    const e = byYear[y] || (byYear[y] = { items: 0, spent: 0 });
    e.items++;
    if (o.total) e.spent = Math.round((e.spent + o.total) * 100) / 100;
  }
  const repeats = Object.entries(byAsin)
    .filter(([, e]) => e.n > 1)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 25);
  const dates = live.map((o) => o.date).filter(Boolean).sort();

  const L = [];
  L.push('# Order history', '');
  L.push(`${live.length} items across ${Object.keys(byAsin).length} distinct products.`);
  if (dates.length) L.push(`Range: ${dates[0]} to ${dates[dates.length - 1]}.`);
  L.push('', '## By year', '', '| Year | Items | Spend |', '|---|---|---|');
  for (const y of Object.keys(byYear).sort()) {
    L.push(`| ${y} | ${byYear[y].items} | ${byYear[y].spent.toFixed(2)} |`);
  }
  L.push('', '## Repurchased', '');
  if (!repeats.length) L.push('_Nothing bought more than once._');
  else {
    L.push('| × | Product | ASIN | Last | Last price |', '|---|---|---|---|---|');
    for (const [asin, e] of repeats) {
      L.push(`| ${e.n} | ${(e.name || '').slice(0, 60)} | ${asin} | ${e.last || ''} | ${e.lastPrice != null ? e.lastPrice : ''} |`);
    }
  }
  L.push('', '---', '', '_Generated by `bin/orders.js`. Contains purchase history — never commit._', '');
  return L.join('\n');
}

function load(name) {
  const p = path.join(STORE, name);
  if (!fs.existsSync(p)) {
    console.error(`No ${name} in ${STORE}. Run:  node bin/orders.js ingest <export>`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function lookupAsin(asin) {
  const byAsin = load('by-asin.json');
  const e = byAsin[String(asin).toUpperCase()];
  if (!e) { console.log(`${asin}: never purchased.`); return; }
  console.log(`${asin}: bought ${e.n}× (qty ${e.qty}), ${e.first} to ${e.last}`);
  if (e.name) console.log(`  ${e.name}`);
  if (e.lastPrice != null) console.log(`  last price ${e.lastPrice}, total spent ${e.spent}`);
}

function search(term) {
  const t = String(term).toLowerCase();
  const hits = Object.entries(load('by-asin.json'))
    .filter(([a, e]) => a.toLowerCase() === t || (e.name || '').toLowerCase().includes(t))
    .sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)));
  if (!hits.length) { console.log(`No purchases matching "${term}".`); return; }
  for (const [asin, e] of hits.slice(0, 30)) {
    console.log(`${e.last || '??????????'}  ${asin}  ${e.n}×  ${e.lastPrice != null ? String(e.lastPrice).padStart(8) : '       ?'}  ${(e.name || '').slice(0, 64)}`);
  }
  if (hits.length > 30) console.log(`... and ${hits.length - 30} more`);
}

function stats() {
  process.stdout.write(fs.readFileSync(path.join(STORE, 'ORDERS.md'), 'utf8'));
}

/* ----------------------------------------------------------------- main --- */

// Guarded: tests/orders.test.js requires this file for its parsers, and an unguarded main
// would run the CLI — print usage and exit(0) — before a single assertion executed.
function main() {
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'ingest' && arg) ingest(arg);
  else if (cmd === 'asin' && arg) lookupAsin(arg);
  else if (cmd === 'search' && arg) search(arg);
  else if (cmd === 'stats') stats();
  else {
    console.log(`Usage:
  node bin/orders.js ingest <export.zip | folder | file.csv>
  node bin/orders.js asin   <ASIN>
  node bin/orders.js search <text>
  node bin/orders.js stats

Output goes to ${STORE} (gitignored). Override with AMZX_STORE.`);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('Error: ' + e.message);
  process.exit(1);
}
}

if (require.main === module) main();

module.exports = { parseCsv, mapColumns, normalise, toDate, toNum, val, isCancelled, ingest };
