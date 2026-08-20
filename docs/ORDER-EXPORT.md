# Order history via Amazon's official export

Amazon's own order search is poor, and order pages are a React app with per-deploy class hashes —
the worst possible scraping target. But Amazon will hand over the entire history as CSV if you
ask. It is a one-time request, it is official, and it never needs maintaining.

This is the only source of **what you actually paid and when**. Nothing else in this toolchain
has price history.

## 1. Request it (you have to do this part)

<https://www.amazon.com/hz/privacy-central/data-requests/preview.html>

Also reachable through *Account → Data Privacy → Request Your Information*.

**The page forces a fresh sign-in.** It redirects through `ap/signin` with
`openid.pape.max_auth_age=600`, so an already-signed-in session is not enough — Amazon wants a
password entered within the last ten minutes. An assistant cannot and should not do this step.

Pick **Your Orders** from the category chooser rather than *Request All Your Data*: the full
archive is enormous, takes far longer to prepare, and contains a great deal this tool has no use
for. Then submit.

> Amazon reworks this page periodically, so the exact control labels may differ from the above.
> The category chooser and a submit button are the durable parts.

## 2. Confirm by email

Amazon sends a **"Confirm your data request"** email. The request is not queued until you click
the link in it — this is the step people miss, then wonder why nothing arrived.

## 3. Wait

Orders usually come back within a few hours. Amazon's stated limit is up to 30 days. You get a
second email with a download link, and **that link expires** (about a week), so grab the file
when it lands.

## 4. Ingest it

```bash
node bin/orders.js ingest ~/Downloads/Your\ Orders.zip
```

Accepts the `.zip` directly (unzipped via PowerShell), an already-extracted folder, or a single
`.csv`. The file that matters is `Retail.OrderHistory.1/Retail.OrderHistory.1.csv`; anything else
in the archive without an ASIN or product-name column is skipped with a note.

Writes three things into `store/`:

| File | What it's for |
|---|---|
| `by-asin.json` | The lookup. ASIN → times bought, first/last date, last price, total spent |
| `orders.json` | Every normalised line item |
| `ORDERS.md` | Spend by year and a repurchase table, readable as-is |

## 5. Query it

```bash
node bin/orders.js asin B07DC5PPFV     # bought before? when? what did I pay?
node bin/orders.js search "usb c"      # everything matching, newest first
node bin/orders.js stats               # the summary
```

```
B07DC5PPFV: bought 3× (qty 3), 2023-04-11 to 2025-08-14
  Anker USB-C Cable, 2-Pack, 6ft
  last price 16.49, total spent 44.47
```

That price drift — $12.99, then $14.99, then $16.49 — is the kind of thing no product page will
ever tell you.

## What the ingest handles

Each of these was a real defect, pinned by `tests/orders.test.js`:

- **Duplicate shipment rows.** Amazon repeats an item per shipment. Keyed on order + ASIN + date
  + quantity + total, so counts and spend don't double.
- **Cancelled orders** are recorded but excluded from the index — a cancelled order correctly
  reports as *never purchased*.
- **Quoted fields** containing commas and literal newlines (product names, gift messages). A
  naive split shears rows apart and every downstream number is wrong.
- **A UTF-8 BOM** that corrupts the first header name.
- **"Not Available"** in place of missing values, which otherwise compares truthy and poisons
  aggregates.
- **Renamed columns** between export vintages, matched loosely rather than hard-coded.

## Privacy

`store/` is gitignored and this repo is public — keep them that way.

The ingest never reads the address, payment-instrument, tracking, gift-message or serial-number
columns (`PII_DROP` in `bin/orders.js`), so they never reach disk in the first place. Nothing this
tool answers needs them. Don't add them back.
