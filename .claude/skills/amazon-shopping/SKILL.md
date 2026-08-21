---
name: amazon-shopping
description: Research products on amazon.com through the user's logged-in browser using the __amzx extractor library — search, compare candidates, and vet a listing before buying. Use when the user pastes an Amazon link, asks to compare products, asks whether something is a good buy, or asks to find the best option in a category. Do not use for placing orders.
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

1. **One of Sylvia's browsers**, reached through the `mcp__claude-in-chrome__*` tools. The
   userscript is installed on both (**SylDesk**, the desktop, and **SylG5**, the laptop). It is
   NOT installed in any sandboxed or cloud browser.
2. **`bin/orders.js` in this repo**, for purchase history. Needs a local filesystem and an
   ingested `store/`.

So:

- **`__amzx` is undefined** → you are not on one of her browsers. Say which capability is missing.
  You may still read the page with ordinary browser tools, but **say that you are doing it**, and
  expect it to cost 10–30× the tokens.
- **No `mcp__claude-in-chrome__*` tools at all** → you cannot reach her browsers from this
  environment. Report that plainly instead of substituting a different browser and implying the
  results are equivalent.
- **No filesystem / no `store/`** → purchase-history answers are unavailable. Do not guess, and
  do not scrape order pages.

**Never present unverified data in the shape of a `__amzx` capture.** If you did not get results
through the extractor, you do not know which entries were sponsored, and you must not claim ads
were filtered. Ad density on a plain search runs about a quarter of the page, so silently passing
those through as organic results is a real, material error.

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

If `__amzx` is undefined, the userscript isn't installed — say so and stop, rather than falling
back to expensive page reads without telling the user why it got slow.

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

**`filterByStar=critical` does not work.** Verified 2026-08-20: navigating to the critical-filter
URL returned eight 4-and-5-star reviews. Amazon ignores the parameter. `__amzx.reviews()` sets
`_warn` when it detects this — respect it. Never tell the user the critical reviews look fine
based on reviews you have not confirmed are critical; say the filter is unavailable instead.

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

Always state `sponsoredRemoved` when it's non-trivial. "16 organic results, 6 ads filtered" tells
the user what they're actually looking at.

If `ownedSince` is set on any result, lead with that — Amazon is reporting the user already bought
it, and that usually ends the question.

## Vetting a listing

Things worth flagging when you see them in a capture:

- **Sold-by / ships-from mismatch** — a third-party seller shipping directly is a different risk
  and a different returns path than Amazon-fulfilled.
- **Cheapest offer isn't the buy box.** `offers` frequently shows a lower price than the default.
  Say so, with the seller.
- **Reviews describing a different product.** Classic listing hijack — the ASIN's review pool was
  inherited from something else and the rating is meaningless. You'll have to spot this in the
  general review sample, since the critical filter is unavailable.
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
