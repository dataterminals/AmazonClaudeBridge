# `window.__amzx` — API

Every call is synchronous except `full()`, `offers()` and `criticalReviews()`.
All output is pruned: nulls, empty objects and empty arrays are dropped before returning.

## `full(opts?)` → Promise\<object\>

The one you want. Dispatches on page type and returns page metadata plus the matching record.

```js
await __amzx.full()                  // whatever this page is
await __amzx.full({limit: 40})       // search pages: more rows (default 24)
```

Extra data costs a **navigation**, not an option flag — the library makes no network requests.
Navigate to `/dp/<ASIN>?aod=1` and call `full()` again to get `offers`.

Always present: `type`, `url`, `capturedAt`, `_v`. Present when relevant: `asin`, `title`.
On a CAPTCHA or error interstitial it returns `{blocked, error}` and nothing else — a human has to
clear that in the browser.

### On a search page

```jsonc
{
  "type": "search",
  "url": "https://www.amazon.com/s",
  "search": {
    "query": "usb c cable",
    "sortedBy": "relevance",
    "shown": 16,
    "organicTotal": 16,
    "sponsoredRemoved": 6,        // 6 of the 22 result nodes were ads
    "resultCountText": "1-16 of over 70,000 results for",
    "results": [
      {
        "pos": 1,
        "asin": "B07DC5PPFV",
        "title": "Anker USB A to USB C Cable (2-Pack, 6 ft, Black)",
        "price": 9.99,
        "stars": 4.7,
        "ratings": 147100,        // "(147.1K)" on the page
        "prime": true,
        "ownedSince": "Aug 2026", // Amazon says you already bought this
        "url": "https://www.amazon.com/dp/B07DC5PPFV"
      }
    ]
  }
}
```

`badge` and `ownedSince` share one slot on the page. A `Purchased …` badge becomes `ownedSince`;
anything else (`Best Seller`, `Amazon's Choice`) stays in `badge`.

### On a product page

```jsonc
{
  "type": "product",
  "asin": "B07DC5PPFV",
  "product": {
    "title": "...",
    "brand": "Anker",
    "price": { "current": 9.99, "currency": "USD", "unit": "$0.83 / feet" },
    "rating": { "stars": 4.7, "count": 147109 },
    "availability": "In Stock",
    "shipsFrom": "Amazon",
    "soldBy": "AnkerDirect",
    "delivery": "FREE delivery Overnight 7 AM - 11 AM ...",
    "category": "Electronics > Computers & Accessories > ...",
    "bullets": ["..."],
    "specs": { "Brand": "Anker", "Connector Type": "USB-C", "...": "..." },
    "url": "https://www.amazon.com/dp/B07DC5PPFV"
  }
}
```

`price.was` appears only when there is a strikethrough list price; `coupon` and `badges` only when
present. **`_missing`** lists any of `title / price / rating / availability / soldBy` that came
back empty — always check it.

### All sellers

Navigate to `https://www.amazon.com/dp/<ASIN>?aod=1` and call `full()` again. The panel renders
client-side, so fetching that URL returns a page without it — you have to actually go there.

```jsonc
"offers": [
  { "price": 9.99, "seller": "AnkerDirect",   "shipsFrom": "Amazon.com", "condition": "New" },
  { "price": 9.89, "seller": "Amazon Resale", "shipsFrom": "Amazon.com", "condition": "Resale - Like New" },
  { "price": 18.29,"seller": "Amazon.com",    "shipsFrom": "Amazon.com", "condition": "New" }
]
```

Real capture — note the buy box was showing $9.99 while Amazon Resale had it at $9.89. That gap
is the reason this call exists.

Call `offers()` on a page without the panel and you get `{_needs: "navigate to …"}` rather than
an empty result, so a missing panel can't be mistaken for a product with one seller.

### Variants — `variants(opts?)`

Included in `full()` on every product page. Decodes Amazon's twister payload
(`dimensions` / `variationValues` / `dimensionToAsinMap`).

```jsonc
"variants": {
  "axes": { "color_name": ["01 Claddagh-Gold", "…"], "ring_size": ["4","5","…","12"] },
  "skuCount": 45,
  "selected": { "color_name": "01 Claddagh-Silver", "ring_size": "8", "asin": "B0BV9YJ7LS" },
  "possibleCombos": 56,        // only when it exceeds skuCount
  "unavailable": [             // advertised in the dropdown, absent from the map
    { "ring_size": "8", "gem_type": "natural green peridot" }
  ],
  "_dilution": "This listing's star rating is pooled across 45 SKUs (5 color_name x 9 ring_size). It is not a rating for this variant alone."
}
```

`_dilution` is the payload. **A rating earned by one product and a rating pooled across ninety are
different numbers wearing the same badge**, and nothing on the rendered page distinguishes them.

`unavailable` is the other half: verified on `B015WD11L6`, "natural green peridot" is stocked in
ring sizes 7 and 10 only — the dropdown offers it in size 8 and no such SKU exists.

Pass `{full: true}` for the complete decoded combination list (large; omitted by default). The
decode is **self-validating**: map keys are underscore-joined value indices matching `dimensions`
positionally, and `selected` is found by locating the current page's own ASIN in the map. If
`selected` is null on a variation page, the convention has moved and `_warn` says so.

### Reviews are capped at 8, and every parameter is ignored

Verified 2026-08-21 on `B0BV9YJ7LS`: `filterByStar=one_star` returns eight reviews rated
5,5,5,5,4,5,5,5. The same eight come back for `two_star`, `three_star`, `critical`, both `sortBy`
values and `pageNumber=2`. There is no pagination control. This is site-wide — `B0BGKYF5VZ` served
224 reviews under its 1★ filter on 18 Aug and eight on 20 Aug.

`criticalReviews()` was removed in v0.2.0 rather than left to mislead. `reviews()` now returns:

```jsonc
"sampling": { "n": 8, "ratingsTotal": 574, "coverage": "1.4%", "ceiling": true, "complete": false }
```

and sets `_warn` naming any parameter proven ignored. **The star distribution is the only
trustworthy figure the endpoint still returns** — on that listing it reports 3% at 1★, roughly 17
reviews that the "one star" filter will not show you.

## `health()` → object

```jsonc
{
  "pageType": "product",
  "ok":      ["product.title", "product.shipsFrom (fallback #1)", "product.image"],
  "absent":  ["product.coupon", "product.badgeChoice"],   // legitimately not on this page
  "broken":  [],                                          // selectors that resolve nowhere
  "summary": "14 ok, 2 absent-but-optional, 0 BROKEN"
}
```

Run it whenever a capture looks thin. `absent` is expected — most products have no coupon.
Anything in `broken` means Amazon moved something and `SEL` needs a new candidate.
`(fallback #N)` means the primary selector stopped matching and a backup carried it — an early
warning that the primary is rotting.

## Narrower calls

| Call | Returns |
|---|---|
| `page()` | Page type, canonical URL, ASIN, timestamp, `blocked` state |
| `product()` | Product record only |
| `search(opts?)` | Search record only |
| `reviews(doc?, opts?)` | Star distribution + review sample from a document |
| `offers()` | All sellers on the current page, or `{_needs}` if the panel isn't loaded |
| `text(max?)` | Rough visible text. Escape hatch for page types with no extractor (cart, wishlists) |
| `SEL` | The live selector registry — inspect it when debugging |

## Failure modes worth knowing

| Symptom | Cause |
|---|---|
| `__amzx is not defined` | Script not installed, or a `GM_*` grant was added and moved it into Tampermonkey's sandbox |
| `{blocked: "captcha"}` | Robot wall. A human must clear it in this browser |
| Record present but `_missing` lists most fields | Page still rendering, or a real DOM change — run `health()` |
| `sponsoredRemoved` unusually high | Possible false positives in ad detection, which silently hides real products |
| Review count ~100× too low | Abbreviated form (`"22.2K"`) reaching a parser that strips non-digits. Fixed in 0.1.0; check `num()` if it returns |
