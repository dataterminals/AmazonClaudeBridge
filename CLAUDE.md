# CLAUDE.md — AmazonClaudeBridge

Repo-specific rules. General conventions come from the sibling TFW/dataterminals repos.

## What this repo is

A userscript that publishes `window.__amzx` on `www.amazon.com` — a read-only extractor library.
**You are the caller.** The user pastes a product link, you navigate their Chrome there and
evaluate `__amzx.full()`. They should never have to press a key on the page.

Cosmetics (dark mode) live in the sibling repo **AmazonTweaks**. Do not add UI here, and do not
add extraction there.

## How to use it in a session

```js
// after navigating the tab to an amazon.com URL
await __amzx.full()                 // search page or product page — dispatches on page type
await __amzx.full({limit: 40})      // search page, more rows (default 24)
__amzx.health()                     // which selectors still resolve here
```

**Extra data costs a navigation, not an option flag.** There is no fetch path (see rule 7):

```js
// all sellers — the buy box shows one and it is often not the cheapest
navigate(`https://www.amazon.com/dp/${asin}?aod=1`); await __amzx.full()   // -> .offers
// reviews
navigate(`https://www.amazon.com/product-reviews/${asin}/`); await __amzx.full()
```

`full()` is async. Return it directly — the eval has REPL semantics and top-level `await` works.

Read `_missing` and `_warn` on every result before trusting it. A thin capture is far more often a
broken selector than a genuinely sparse product.

## Rules

1. **`@grant none` is load-bearing.** Adding any `GM_*` grant moves the script into Tampermonkey's
   sandbox, where `window` is not the page's `window` and `__amzx` becomes invisible to an external
   evaluator. The script then appears installed and working while its entire purpose fails
   silently. If a GM API is ever genuinely needed, keep the grant *and* publish via
   `unsafeWindow.__amzx = API`.

2. **Selectors live only in `SEL`.** When a field breaks, add a candidate to that registry,
   most-specific first, most-durable last. Never move selector strings into the extraction
   functions — the single registry is what makes a DOM change a one-line fix.

3. **Never commit `/store/`.** Captures carry the user's purchase history (Amazon stamps
   `Purchased Aug 2025` into search results, surfaced as `ownedSince`). This repo is public.
   Same sanitisation doctrine as OCRClaudeBridge: no real paths, no real order data, invented
   figures in docs.

4. **Stay read-only.** DOM reads, plus same-origin GETs of pages the user could click to, only
   under `{deep:true}`. No writes, no form submits, no cart/buy/checkout controls, no credentials,
   no third-party hosts, no background crawling. Do not "just add" a cart helper.

5. **Verify against the live site before believing a selector.** Every fix in v0.1.0 came from
   probing amazon.com, and three of them contradicted what the DOM was assumed to do:
   `[data-component-type="sp-sponsored-result"]` matched nothing, `#bylineInfo` no longer exists,
   and `#acBadge_feature_div` contains a stylesheet on products with no badge. Reading the code is
   not verification.

6. **Run `node tests/parse.test.js` after touching any parser.** Zero dependencies, plain node.

7. **Do not re-add a fetch path.** It was tried and removed in v0.2.0. The all-offers AJAX
   endpoints 404 in every URL shape; `?aod=1` over XHR omits the client-rendered panel; and
   `filterByStar=critical` is ignored by Amazon over fetch *and* over real navigation. If you
   think you have found a working endpoint, verify the returned star ratings actually match the
   requested filter before believing it — the old code "worked" and returned 5-star reviews.

## Order history

`bin/orders.js` ingests Amazon's official *Request My Data* export into `store/`. Check
`store/by-asin.json` before recommending a purchase — "you already bought this, 2025-08-14, for
$16.49" ends most questions, and the last-paid price is the only price history available
anywhere in this toolchain.

Three rules:

- **`store/` is gitignored and stays that way.** It is a complete purchase history. The repo is
  public.
- **Never scrape order pages.** They are a React app with per-deploy class hashes, and the export
  is official, complete, and needs no maintenance. There is deliberately no orders extractor in
  the userscript.
- **The ingest drops addresses and payment columns on the way in** (`PII_DROP`). Don't "helpfully"
  add them back; nothing this tool answers needs them.

## Known-fragile spots

- **Sponsored detection** currently rests on `.puis-sponsored-label-text` /
  `.puis-label-popover-default`. The latter is a generic popover class kept as a last-resort
  fallback; it earned its place only because it flagged exactly the same 6-of-22 results as the
  specific classes on 2026-08-20. A false positive here silently hides a real product, which is
  the expensive direction — re-check it if organic counts look low.
- **Orders pages** have no extractor. Amazon's order history is a React app with per-deploy class
  hashes, and it is the wrong thing to scrape anyway: Amazon's official *Request My Data* export
  hands over the entire order history as CSV, once, with no maintenance. Use that.
- **Price** comes from `#corePrice_feature_div`'s *first* `.a-offscreen`; the second is the unit
  price. If a price ever reads suspiciously low, that ordering is the first thing to check.
