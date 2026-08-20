# Amazon Claude Bridge

A **read-only extractor library** for `www.amazon.com`. It installs as a userscript, renders
nothing, and binds no keys. All it does is define `window.__amzx` — so an assistant driving the
browser can pull a compact, de-sponsored JSON record of whatever page is open, instead of reading
a 60 KB accessibility tree and guessing.

> **Cosmetic changes live elsewhere.** The dark theme is
> [AmazonTweaks](https://github.com/dataterminals/AmazonTweaks). This repo is the data side.
> Keep the two apart.

---

## Why

Reading Amazon through a general browser tool is expensive and lossy:

- A search results page serialises to tens of KB of nav, ads, carousels and footer. The ~15 fields
  that actually inform a decision are 1–2 KB. You run out of context long before you run out of
  products.
- Sponsored placements are interleaved with organic results and look nearly identical, so every
  read spends effort re-deciding which is which.
- Comparing five candidates means five expensive page reads, then assembling a table by hand.

The fix is to extract *inside the page*, where the DOM already is, and hand back only the fields
that change a decision. On a real search page that is 22 raw result nodes in, 16 organic products
out, ads counted and dropped.

## What it does

| Page | Call | You get |
|---|---|---|
| Search results | `__amzx.full()` | Organic results only — ASIN, title, price, stars, review count, Prime, badge — plus how many ads were removed |
| Product | `__amzx.full()` | Price (with unit price and list price), rating, availability, ships-from / sold-by, delivery, coupon, badges, breadcrumb, feature bullets, spec table, canonical URL |
| Product, deep | `__amzx.full({deep:true})` | The above plus **all sellers** (the buy box hides them, and the default is often not the cheapest) and **verified-purchase critical reviews, newest first** |
| Reviews | `__amzx.full()` | Star distribution plus a sample with dates, verified flags and helpful counts |
| Anything | `__amzx.health()` | Which selectors still resolve on this page — see *Maintenance* |

Every record is pruned of nulls and empty branches before it is returned, and long strings are
capped. Compactness is the product.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`src/amazon-claude-bridge.user.js`](src/amazon-claude-bridge.user.js) **raw** and let
   Tampermonkey take the install.
3. Load any Amazon page and check the console: `__amzx.version` should return a string.

If `__amzx` is `undefined` on an Amazon page, see the `@grant none` note in *Maintenance*.

### The companion skill

[`skill/SKILL.md`](skill/SKILL.md) is a Claude Code skill carrying the research playbook — the
search-URL parameters worth building by hand, how to report a comparison, and a listing-vetting
checklist. Install it at user scope:

```bash
mkdir -p ~/.claude/skills/amazon-shopping && cp skill/SKILL.md ~/.claude/skills/amazon-shopping/
```

It is a copy, not a link — re-run that after pulling changes.

## Scope, deliberately narrow

The script reads the DOM and, only when the caller passes `{deep:true}`, issues same-origin GETs
for two pages the signed-in user could reach by clicking — the all-sellers panel and the reviews
list. That is the entire footprint.

It does **not** write to the page, submit a form, touch a cart / buy / checkout control, read
credentials, contact any third-party host, or crawl in the background. Anything that changes
account state belongs in a different, clearly-scoped tool.

## Captures contain personal data

Amazon stamps the signed-in user's own history into search results — a badge reading
`Purchased Aug 2025`, which this library surfaces as `ownedSince`. It is genuinely useful
("do I already own this?") and it is also purchase history.

`.gitignore` excludes `/store/` for exactly this reason. **Keep captures out of the repo.** Treat this
repo as publishable; what it extracts is not.

## Maintenance

Amazon reshuffles its DOM constantly, and the dangerous failure is the quiet one — a selector that
stops matching, returns `null`, and lets the caller reason confidently about a price that was
never read.

Two things are built to make that loud instead:

- **`__amzx.health()`** reports, for the current page, which fields resolved, which resolved only
  via a fallback candidate, and which are outright `broken`. Fields that are legitimately absent on
  most pages (coupon, list price, badges) are reported as `absent`, so a real break is not buried.
- **Every record carries `_missing`** listing which of the load-bearing fields came back empty.

When a field breaks, **add a candidate selector to the `SEL` registry** near the top of the
script — never rewrite the extraction logic. Candidates are tried in order, most-specific first.

`@grant none` is load-bearing. With any `GM_*` grant, Tampermonkey runs the script in a sandbox
whose `window` is not the page's `window`, and `__amzx` becomes invisible to an external
evaluator — the script looks installed and working while its only purpose silently fails.

## Tests

```bash
node tests/parse.test.js
```

60 zero-dependency tests over the pure parsers. Each case is a defect found by running the
extractor against live amazon.com rather than by reading it — abbreviated review counts
(`"(22.2K)"` parsed as 222), doubled unit prices (`"$0.83$0.83 / feet"`), and CSS leaking out of
`textContent` and fabricating a badge that was not on the page.

Selectors cannot be tested offline. `health()` is the check for those, against the live site.

## License

MIT
