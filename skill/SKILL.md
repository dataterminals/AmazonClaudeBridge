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

## The loop

0. If the Chrome tools are deferred, load them in **one** ToolSearch call — don't spend a
   round-trip per tool:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__tabs_close_mcp`
   Use claude-in-chrome, not the in-app browser: prices, Prime eligibility, delivery estimates and
   the `Purchased …` badge all depend on the user's logged-in session, and the userscript is
   installed in their real browser. Close any tab you opened when you're done.
1. Navigate the tab to an Amazon URL (build it with the parameters below — don't click through UI).
2. `await __amzx.full()` — or `{deep:true}` on a product page you're seriously considering.
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
- `https://www.amazon.com/product-reviews/<ASIN>/?sortBy=recent&filterByStar=critical&reviewerType=avp_only_reviews`
  — verified critical reviews, newest first (or just use `full({deep:true})`)

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

Things worth flagging when you see them in a `{deep:true}` capture:

- **Sold-by / ships-from mismatch** — a third-party seller shipping directly is a different risk
  and a different returns path than Amazon-fulfilled.
- **Cheapest offer isn't the buy box.** `offers` frequently shows a lower price than the default.
  Say so, with the seller.
- **Critical reviews describing a different product.** Classic listing hijack — the ASIN's review
  pool was inherited from something else and the rating is meaningless.
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
