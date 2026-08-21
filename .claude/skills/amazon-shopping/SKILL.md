---
name: amazon-shopping
description: Research products on amazon.com — search, compare candidates, check price and sellers, read the variant map, and vet a listing before buying. Extracts compact structured data via the __amzx library instead of reading whole pages. Use whenever the user pastes an Amazon or amzn.to link, asks about a product, asks to compare or find the best option in a category, asks whether something is a good price or a good buy, asks about a seller, a rating, or reviews, or asks what they previously bought or paid on Amazon. Do not use for placing orders or operating a cart.
---

# Amazon shopping research

The user's browser has **AmazonClaudeBridge** installed, which publishes `window.__amzx` on
`www.amazon.com`. Extract through it. Do not read Amazon pages with `read_page` or
`get_page_text` — a search page serialises to tens of KB and you will run out of context after
three or four products.

**Never operate a cart, buy, checkout, or account control.** This skill researches. The user buys.

## Preflight — check this before promising anything

This skill has two local dependencies, and a session that lacks them must say so rather than
quietly doing something worse:

1. **A browser with the userscript installed**, reached through the `mcp__claude-in-chrome__*`
   tools. That means one of the operator's own browsers — it is NOT installed in any sandboxed or
   cloud browser, so a hosted session will not have it.
2. **`bin/orders.js` in this repo**, for purchase history. Needs a local filesystem and an
   ingested `store/`.

So:

**Probe liveness FIRST — before any `__amzx` check.** The first thing that can fail is
`javascript_tool` itself, and when it does, every probe looks identical to "the library is
missing". Make this the first JS call of the session:

```js
1  // liveness probe
```

| Probe result | Meaning | Do |
|---|---|---|
| returns `1` | JS execution works | continue to the `__amzx` check |
| **`Permission for this action was denied by the … classifier`** | a safety classifier refused the payload | **do not retry, do not rephrase.** Name the refused call and stop |
| **`javascript_tool did not respond in time`** | usually an unanswered permission prompt in the Chrome side panel | ask the user to check the side panel. **One retry, then stop** |

Only once the probe returns `1`:

- **`__amzx` is undefined** → you are not on a browser with the userscript. Go to the ladder
  below. Do not conclude the tooling is broken — a browser without it is the expected case in a
  hosted or sandboxed environment.
- **No `mcp__claude-in-chrome__*` tools at all** → you cannot reach the user's browsers from this
  environment. Report that plainly instead of substituting a different browser and implying the
  results are equivalent.
- **No filesystem / no `store/`** → purchase-history answers are unavailable. Do not guess, and
  do not scrape order pages.

**Never present unverified data in the shape of a `__amzx` capture.** If you did not get results
through the extractor, you do not know which entries were sponsored, and you must not claim ads
were filtered. Ad density on a plain search runs about a quarter of the page, so silently passing
those through as organic results is a real, material error.

### Getting `__amzx`: a three-tier ladder, in order

**Tier 1 — the installed userscript. This is the happy path.** If `typeof __amzx !== 'undefined'`,
use it. Zero cost, zero injection. This is the normal case on an operator's own machine, which is
where most work happens. Try this first and expect it to succeed.

**Tier 2 — inject the vendored copy.** If `__amzx` is undefined, read
`assets/amzx.min.js` from this skill's own directory and evaluate that string in the page. It is
local, version-locked to this skill, and reviewed at install time.

Its real cost: **~25 KB spent in context on every page you inject it into.** That is roughly what
one raw search-results read costs, so it pays for itself the moment you make two `__amzx` calls on
the same page — and it is pure waste if you inject it to read one field. Prefer Tier 1
deliberately rather than falling into Tier 2 by habit, and if you only need a title, just read the
title.

**Tier 3 — stop.** No `__amzx` and no vendored asset: name the missing capability and stop. You
may read the page with ordinary browser tools as an explicitly labelled degraded mode, but say so.

> **Never fetch code over the network and eval it.** A previous version of this skill told you to
> `fetch()` the library from GitHub and `(0, eval)` it. That is the textbook shape of what safety
> tooling exists to stop, and it was **blocked by a classifier** in a real session — correctly, and
> not as a flake. `main` is mutable, so what would execute is not knowable at review time. Do not
> reintroduce it, and do not route around a denial by rephrasing the payload.

**A signed-out browser gives different data.** Prices, Prime eligibility, delivery estimates and
the `Purchased …` badge all depend on the session. If `#nav-link-accountList` reads "Sign in", say
the figures are the signed-out view — do not sign in, and do not present them as the user's own.

## The loop

0. If the Chrome tools are deferred, load them in **one** ToolSearch call — don't spend a
   round-trip per tool:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__tabs_close_mcp`
   Use claude-in-chrome, not the in-app browser: prices, Prime eligibility, delivery estimates and
   the `Purchased …` badge all depend on the user's logged-in session, and the userscript is
   installed in their real browser. Close any tab you opened when you're done.
1. Navigate the tab to an Amazon URL (build it with the parameters below — don't click through UI).
2. `await __amzx.full()`. For a product you're seriously considering, navigate again to
   `/dp/<ASIN>?aod=1` and call it a second time — that adds `offers`, every seller for the item.
   Worth the extra round-trip: the buy box shows one seller and often isn't the cheapest.
3. Check `_missing` and `_warn`. If they're substantial, run `__amzx.health()` before trusting it.
4. Report as a comparison table, not prose.

If `__amzx` is undefined, work the three-tier ladder above — do not silently fall back to
expensive raw page reads, and do not report the tooling as broken.

## Build search URLs directly

Base: `https://www.amazon.com/s?k=<query>`

| Parameter | Effect |
|---|---|
| `&s=price-asc-rank` | Cheapest first |
| `&s=review-rank` | Best reviewed first |
| `&s=date-desc-rank` | Newest first |
| `&s=exact-aware-popularity-rank` | "Featured" / default |
| `&rh=p_36:1000-3000` | Price $10.00–$30.00 — **in cents** |
| `&rh=p_72:1248915011` | 4 stars and up (US marketplace node) |
| `&rh=p_6:ATVPDKIKX0DER` | Sold by Amazon itself, not a marketplace seller |
| `&page=2` | Pagination |

Combine `rh` filters with commas: `&rh=p_36:1000-3000,p_72:1248915011`.

Node IDs like `p_72:…` and `p_85:…` are marketplace-specific and Amazon does change them. If a
filtered search returns zero or nonsense, drop the `rh` and filter in your own analysis instead —
don't keep retrying node IDs.

Other useful URLs:

- `https://www.amazon.com/dp/<ASIN>` — canonical product page, no tracking cruft
- `https://www.amazon.com/dp/<ASIN>?aod=1` — all sellers. The panel renders client-side, so you
  must **navigate** here; fetching it returns a page without the offers
- `https://www.amazon.com/product-reviews/<ASIN>/` — the reviews list

## Reviews are capped at 8 and the parameters are inert

Not just `critical` — **every** review parameter is ignored. Verified 2026-08-21 on `B0BV9YJ7LS`:
`filterByStar=one_star` returned eight reviews rated 5,5,5,5,4,5,5,5. Identical eight for
`two_star`, `three_star`, `critical`, both `sortBy` values and `pageNumber=2`. No pagination
control exists. It is site-wide, not one bad listing — `B0BGKYF5VZ` served 224 reviews under its
1★ filter on 18 Aug and eight on 20 Aug.

**The star distribution is the only trustworthy thing the reviews endpoint still returns.** The
percentages are real. The sample is not representative, cannot be made representative, and no
amount of URL fiddling will reach review number nine — don't try.

`reviews()` gives you `sampling: {n, ratingsTotal, coverage, ceiling}`. On that ring: 8 readable
against 574 rated is **1.4% coverage**, while the distribution says 3% are 1★ — roughly 17 angry
reviews that the "one star" filter will not show you. Quote the distribution and the coverage
figure. Never characterise a product's problems from the sample.

## Check purchase history first

If `store/by-asin.json` exists in the AmazonClaudeBridge repo, **check it before recommending
anything**. It is the local mirror of Amazon's official order-history export, and it answers
things the live site can't.

```bash
node bin/orders.js asin B07DC5PPFV     # bought before? when? what did I pay?
node bin/orders.js search "usb c"      # everything matching, newest first
node bin/orders.js stats               # spend by year, repurchase table
```

Lead with anything it turns up — it usually ends the question:

- **Already owned.** "You bought this 2025-08-14 for $16.49" beats any comparison table.
- **Price drift.** If the last price was lower than today's, say so with both figures. This is
  the only real price history available; Amazon shows none and the extractor can't infer it.
- **Reorder cadence.** A thing bought 3× at roughly even intervals is a consumable, and the
  useful answer is "you're about due" rather than a fresh product comparison.

If the file doesn't exist, don't guess and don't scrape order pages — say the export hasn't been
ingested yet and point at `docs/ORDER-EXPORT.md`.

## Reporting

Lead with a table. Columns that actually change a decision:

| # | Product | Price | Unit | ★ | Reviews | Sold by | Notes |

Then a short recommendation with the reason, and the rule-outs with *why* — the rule-outs are the
part that saves the user repeating this later.

**State `sponsoredRemoved` on every search report, without exception.** Not "when non-trivial" —
always. About a quarter of a plain search page is advertising, and a report that omits the figure
is indistinguishable from one where filtering never happened. "16 organic results, 6 ads filtered"
takes four words and tells the user what they are actually looking at.

If `ownedSince` is set on any result, lead with that — Amazon is reporting the user already bought
it, and that usually ends the question.

## Vetting a listing

Things worth flagging when you see them in a capture:

- **Sold-by / ships-from mismatch** — a third-party seller shipping directly is a different risk
  and a different returns path than Amazon-fulfilled.
- **Cheapest offer isn't the buy box.** `offers` frequently shows a lower price than the default.
  Say so, with the seller.
- **A rating pooled across many SKUs.** With review reading capped, `variants` is now the primary
  audit tool — check it on every product page. `full()` includes it automatically and sets
  `_dilution` whenever a listing has more than one SKU. A 574-rating average spread over 45 rings
  is not a rating for the ring being bought, and nothing on the page says so. Real catches: a
  Claddagh listing whose colour axis held four Triquetra knots — a different ring entirely; a
  24-rating birthstone listing where every rating belonged to one colourway.
- **A variant that is advertised but not stocked.** `variants().unavailable` lists combinations the
  dropdown offers and the map doesn't have. Verified on `B015WD11L6`: "natural green peridot"
  exists in sizes 7 and 10 only — not in size 8, and the rendered dropdown never says so.
- **Reviews describing a different product.** Classic listing hijack. You'll have to spot this in
  the 8-review sample, since every filter is inert — and 8 of several hundred may well not contain
  it. Absence of evidence here is close to worthless.
- **Rating count wildly out of scale with the product's apparent age**, or a bimodal distribution
  (heavy 5s and 1s, little middle).
- **Review pool shared across unrelated variations** — a "4.6" can belong mostly to a different
  size or colour.
- **Price far below the category norm** with no explanation in the specs.

State what you observed and let the user judge. Don't refuse to report a product because it looks
suspicious, and don't declare a listing fraudulent — describe the signal.

## What this can't tell you

**Price history.** Amazon does not show it and neither does this. If the user asks whether
something is a good price, say plainly that you can compare it against current alternatives but
cannot see what it cost last month.

**Complete order history.** Search results carry a `Purchased <date>` badge for items the user
bought, but that is per-result and incidental. For real purchase history, Amazon's official
*Request My Data* export delivers the whole thing as CSV — worth suggesting once, then reading
locally, rather than trying to scrape order pages.
