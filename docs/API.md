# `window.__amzx` — API

Every call is synchronous except `full()`, `offers()` and `criticalReviews()`.
All output is pruned: nulls, empty objects and empty arrays are dropped before returning.

## `full(opts?)` → Promise\<object\>

The one you want. Dispatches on page type and returns page metadata plus the matching record.

```js
await __amzx.full()                  // whatever this page is
await __amzx.full({deep: true})      // product pages: + all sellers, + critical reviews
await __amzx.full({limit: 40})       // search pages: more rows (default 24)
```

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

With `{deep: true}` you also get:

- **`offers`** — up to 10 sellers with price, seller, ships-from and condition. The buy box shows
  one; the cheapest is often not it.
- **`criticalReviews`** — verified-purchase, newest-first, critical only. Where real defects and
  listing hijacks show up.

Each deep fetch is one same-origin GET. Failures land in `_warn` rather than killing the capture.

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
| `offers(asin?)` | Promise — all sellers |
| `criticalReviews(asin?, limit?)` | Promise — verified critical reviews |
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
