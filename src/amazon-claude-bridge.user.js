// ==UserScript==
// @name         Amazon Claude Bridge
// @namespace    https://github.com/dataterminals/AmazonClaudeBridge
// @version      0.3.0
// @description  Read-only extractor library for amazon.com. Exposes window.__amzx so an assistant driving the browser can pull a compact, de-sponsored JSON record of the current page instead of reading a 60 KB accessibility tree. Never clicks a buy control, submits a form, or reads credentials.
// @author       dataterminals
// @homepageURL  https://github.com/dataterminals/AmazonClaudeBridge
// @supportURL   https://github.com/dataterminals/AmazonClaudeBridge/issues
// @match        https://www.amazon.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/dataterminals/AmazonClaudeBridge/main/src/amazon-claude-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/dataterminals/AmazonClaudeBridge/main/src/amazon-claude-bridge.user.js
// @noframes
// ==/UserScript==
//
// DESIGN NOTES (for the next maintainer — human or Claude):
//
//   * WHAT THIS IS. A *library*, not a feature. It renders no UI, binds no hotkey, and changes
//     nothing on the page. It defines window.__amzx and stops. The caller is an assistant
//     driving this browser, which navigates to a URL and then evaluates `__amzx.full()`.
//     Cosmetics live in the sibling repo AmazonTweaks; keep the two apart.
//
//   * IT PUBLISHES ITSELF VIA A <script> TAG, and that is not decoration — see the loader at
//     the bottom. Whether a userscript's `window` is the page's `window` depends on how the
//     extension injected it, which the script cannot observe. v0.1.0 relied on `@grant none`
//     meaning main-world, installed fine, and left `__amzx` undefined with no error anywhere.
//     A <script> element always evaluates in the main world because the DOM is shared, so the
//     loader is correct under every injection mode. Do not "simplify" it back to a direct call.
//
//   * READ-ONLY, and narrowly so. DOM reads of the page the caller navigated to. Nothing else:
//     no writes, no form submits, no buy/checkout controls, no credential access, no network
//     requests of any kind, no background crawling.
//
//   * THERE IS NO FETCH PATH, and that is deliberate. v0.1.0 fetched sub-pages for offers and
//     critical reviews. Both were dead on arrival (see the `offers` section below): the AJAX
//     endpoints 404, the offers panel renders client-side, and Amazon ignores
//     filterByStar=critical over fetch AND over real navigation. The caller drives the browser,
//     so the caller navigates; these functions read whatever is in front of them and report a
//     `_needs` hint when the data requires a different URL.
//
//   * COMPACTNESS IS THE PRODUCT. The reason to exist is that the caller pays per token. Every
//     field is capped and trimmed and empty values are dropped. If you add a field, ask what
//     decision it changes — if the answer is "none", leave it out.
//
//   * ALL SELECTORS LIVE IN `SEL`. Amazon reshuffles its DOM constantly. Extraction logic reads
//     from that one registry via pick()/pickText(), which try candidates in order. When a field
//     breaks, add a candidate to SEL — never rewrite the logic. Order candidates most-specific
//     first; the last entry should be the most durable fallback.
//
//   * SILENT DEGRADATION IS THE ENEMY. A scraper that quietly returns null for `price` is worse
//     than one that throws, because the caller reasons confidently about missing data. That is
//     what `__amzx.health()` is for, and why every record carries `_missing`. Check it before
//     trusting a capture that looks thin.
//
'use strict';
(function () {
  function __amzxLib() {
  'use strict';
  const VERSION = '0.3.0';

  /* ---------------------------------------------------------------- utils */

  const $ = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };
  const $$ = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  // Collapse whitespace, strip the zero-width junk Amazon sprinkles into labels.
  const clean = (s) => (s == null ? null : String(s)
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null);

  const clip = (s, n) => { const c = clean(s); return c && c.length > n ? c.slice(0, n - 1) + '\u2026' : c; };

  // First candidate selector that yields an element.
  const pick = (cands, root = document) => {
    for (const c of cands) { const el = $(c, root); if (el) return el; }
    return null;
  };

  // textContent minus <style>/<script> payloads. Amazon ships inline CSS *inside* feature
  // containers — #acBadge_feature_div holds a stylesheet on products that have no badge — so
  // raw textContent returns a wall of CSS. That reads as a present, non-empty value and
  // silently invents an "Amazon Choice" badge that was never on the page.
  const txtOf = (el) => {
    if (!el) return null;
    if (!el.querySelector || !el.querySelector('style,script,noscript')) return clean(el.textContent);
    const copy = el.cloneNode(true);
    for (const n of copy.querySelectorAll('style,script,noscript')) n.remove();
    return clean(copy.textContent);
  };

  // First candidate that yields non-empty text (an element can exist but be blank —
  // .priceToPay .a-offscreen is present and empty on current product pages).
  const pickText = (cands, root = document) => {
    for (const c of cands) {
      const t = txtOf($(c, root));
      if (t) return t;
    }
    return null;
  };

  const pickAttr = (cands, attr, root = document) => {
    for (const c of cands) {
      const el = $(c, root);
      const v = el && el.getAttribute(attr);
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  // "$1,234.56" / "US$12.34" / "12,34 EUR" -> 1234.56 . Returns null rather than NaN.
  //
  // Takes the FIRST well-formed amount rather than stripping separators across the whole
  // string. Amazon renders a price twice inside one node (offscreen + visible), so "$9.99$9.99"
  // stripped to "9.999.99" parses as 9.999 — a plausible-looking wrong number, which is the
  // worst kind. Seen live in the all-sellers panel: $18.29 arrived as 18.2918.
  const money = (s) => {
    const c = clean(s);
    if (!c) return null;
    const m = c.match(/\d[\d.,]*/);
    if (!m) return null;
    const t = m[0].replace(/[.,]+$/, '');
    // A trailing comma with exactly 2 digits after it is a decimal comma, not a thousands mark.
    const norm = /,\d{2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    const n = parseFloat(norm);
    return Number.isFinite(n) ? n : null;
  };

  // Counts, including Amazon's abbreviated form. Search results render "(22.2K)", so a naive
  // strip-non-digits reads that as 222 — off by two orders of magnitude, and silently.
  const num = (s) => {
    const c = clean(s);
    if (!c) return null;
    const m = c.match(/([\d,.]+)\s*([KMkm])?/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const suffix = (m[2] || '').toUpperCase();
    return Math.round(n * (suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : 1));
  };

  // Per-unit price renders as "($0.83$0.83 / feet)": the offscreen and the visible span both
  // contribute, so the amount arrives doubled. Strip the parens, then collapse the repeat.
  const unitPrice = (s) => clean((s || '').replace(/[()]/g, '').replace(/^([^\d]*[\d.,]+)\1/, '$1'));

  const currency = (s) => {
    const c = clean(s) || '';
    if (c.includes('$')) return 'USD';
    if (c.includes('\u00A3')) return 'GBP';
    if (c.includes('\u20AC')) return 'EUR';
    return null;
  };

  // Drop nulls / empty arrays / empty objects, recursively. This is where the token savings land.
  const compact = (v) => {
    if (Array.isArray(v)) {
      const a = v.map(compact).filter((x) => x !== null && x !== undefined);
      return a.length ? a : null;
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        const c = compact(val);
        if (c !== null && c !== undefined) o[k] = c;
      }
      return Object.keys(o).length ? o : null;
    }
    if (typeof v === 'string') return clean(v);
    return v === undefined ? null : v;
  };

  const asinFrom = (url) => {
    const m = String(url || '').match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
  };

  // Canonical /dp/ URL with all the tracking cruft removed.
  const dpUrl = (asin) => (asin ? 'https://www.amazon.com/dp/' + asin : null);

  /* ------------------------------------------------------- selector registry */
  // Most-specific first, most-durable last. Add candidates here when a field breaks.

  const SEL = {
    product: {
      title:      ['#productTitle', '#title span#productTitle', 'h1#title'],
      byline:     ['#bylineInfo', '#brand', 'a#bylineInfo'],
      // Verified 2026-08-20: the .priceToPay .a-offscreen node exists but is EMPTY, while
      // #corePrice_feature_div's first .a-offscreen carries "$9.99". Its second one is the
      // per-unit price, so first-match-wins is what we want. .priceToPay's own text is the
      // fallback because the offscreen span inside it can't be relied on.
      price:      ['#corePrice_feature_div .a-price .a-offscreen',
                   '#corePriceDisplay_desktop_feature_div .priceToPay',
                   '#apex_desktop .a-price .a-offscreen',
                   '#priceblock_ourprice', '#priceblock_dealprice', '#priceblock_saleprice',
                   '.a-price .a-offscreen'],
      wasPrice:   ['#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
                   'span[data-a-strike="true"] .a-offscreen',
                   '.basisPrice .a-offscreen'],
      unitPrice:  ['#corePriceDisplay_desktop_feature_div .pricePerUnit',
                   '.pricePerUnit', '#corePrice_feature_div .a-size-small.a-color-price'],
      rating:     ['#acrPopover .a-icon-alt', '#averageCustomerReviews .a-icon-alt',
                   'span[data-hook="rating-out-of-text"]'],
      ratingAttr: ['#acrPopover'],
      ratingCount:['#acrCustomerReviewText', '[data-hook="total-review-count"]'],
      availability:['#availability span', '#availability', '#outOfStock .a-color-price'],
      shipsFrom:  ['.tabular-buybox-text[tabular-attribute-name="Ships from"] .tabular-buybox-text-message',
                   '#fulfillerInfoFeature_feature_div .offer-display-feature-text-message',
                   '[tabular-attribute-name="Ships from"]'],
      soldBy:     ['.tabular-buybox-text[tabular-attribute-name="Sold by"] .tabular-buybox-text-message',
                   '#merchantInfoFeature_feature_div .offer-display-feature-text-message',
                   '#sellerProfileTriggerId', '#merchant-info',
                   '[tabular-attribute-name="Sold by"]'],
      delivery:   ['#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
                   '#deliveryBlockMessage', '#delivery-block-message',
                   '[data-csa-c-delivery-time]'],
      coupon:     ['#promoPriceBlockMessage .a-color-success', '[id^="couponText"]',
                   '.couponLabelText', '#vpcButton .a-color-success'],
      image:      ['#landingImage', '#imgTagWrapperId img', '#main-image-container img'],
      breadcrumb: ['#wayfinding-breadcrumbs_feature_div'],
      bullets:    ['#feature-bullets li span.a-list-item', '#featurebullets_feature_div li span'],
      // Anchor on the badge's own text node, not the wrapper div — the wrapper is present
      // (holding only CSS) even when the product has no badge. txtOf() strips the CSS, but
      // naming the text element keeps this honest if that helper is ever changed.
      badgeChoice:['#acBadge_feature_div .ac-badge-text-primary', '#acBadge_feature_div a',
                   '[data-feature-name="acBadge"] .a-badge-text'],
      badgeBest:  ['#zeitgeistBadge_feature_div .badge-text', '#zeitgeistBadge_feature_div a',
                   '.badge-wrapper .best-seller-badge'],
      brandRow:   ['#productOverview_feature_div tr'],
      specRows:   ['.prodDetTable tr',
                   '#productDetails_techSpec_section_1 tr',
                   '#productDetails_detailBullets_sections1 tr',
                   '#technicalSpecifications_section_1 tr'],
      detailList: ['#detailBullets_feature_div li', '#detailBulletsWrapper_feature_div li'],
      asinInput:  ['#ASIN', 'input[name="ASIN"]', '#asin'],
    },
    search: {
      results:    ['div.s-main-slot div[data-component-type="s-search-result"][data-asin]',
                   'div[data-component-type="s-search-result"][data-asin]',
                   'div.s-result-item[data-asin]'],
      title:      ['[data-cy="title-recipe"] h2 span', 'h2 a span', 'h2 span', 'h2'],
      link:       ['[data-cy="title-recipe"] a', 'h2 a', 'a.a-link-normal.s-no-outline'],
      price:      ['[data-cy="price-recipe"] .a-price .a-offscreen', '.a-price .a-offscreen'],
      wasPrice:   ['[data-a-strike="true"] .a-offscreen', '.a-text-price .a-offscreen'],
      unitPrice:  ['.a-price ~ span.a-size-base.a-color-secondary', '.a-size-base.a-color-secondary'],
      rating:     ['[data-cy="reviews-block"] .a-icon-alt', '.a-icon-star-small .a-icon-alt',
                   '.a-icon-star .a-icon-alt', 'i.a-icon-star-small span'],
      ratingCount:['a .s-underline-text', 'span.a-size-base.s-underline-text',
                   '[data-cy="reviews-block"] a .a-size-base'],
      prime:      ['.a-icon-prime', '[aria-label*="Prime"]'],
      badge:      ['.a-badge-text', 'span.a-badge-label-inner .a-badge-text'],
      thumb:      ['img.s-image'],
      // Any hit here marks the result as an ad and drops it from `results`.
      // Ordered most-reliable first. A FALSE POSITIVE is the expensive failure here: it
      // silently hides a genuine product the user might have wanted, and nothing in the
      // output says it happened. So the loose catch-all `.puis-label-popover-default` goes
      // LAST — it is a generic popover class, not a sponsorship marker, and only earns its
      // place because on 2026-08-20 it flagged exactly the same 6 of 22 results as the
      // specific classes did. Verified same day: `sp-sponsored-result` matched nothing.
      sponsored:  ['.puis-sponsored-label-text', '.s-sponsored-label-text',
                   '[data-component-type="sp-sponsored-result"]',
                   'a[aria-label*="Sponsored"]', 'span[aria-label*="Sponsored"]',
                   '.s-sponsored-label-info-icon', '.puis-label-popover-default'],
      resultCount:['[data-component-type="s-result-info-bar"] h1 span',
                   '.s-breadcrumb .sg-col-inner span', '#s-result-info-bar-content span'],
    },
    reviews: {
      card:       ['div[data-hook="review"]', '.review'],
      rTitle:     ['[data-hook="review-title"] span:not(.a-icon-alt)', '[data-hook="review-title"]'],
      rStars:     ['[data-hook="review-star-rating"] .a-icon-alt', '[data-hook="cmps-review-star-rating"] .a-icon-alt'],
      rDate:      ['[data-hook="review-date"]'],
      rBody:      ['[data-hook="review-body"] span', '[data-hook="review-body"]'],
      rVerified:  ['[data-hook="avp-badge"]'],
      rHelpful:   ['[data-hook="helpful-vote-statement"]'],
      histRow:    ['#histogramTable tr', '[data-hook="histogram-row"]'],
    },
    offers: {
      // `div[id^="aod-offer"]` is WRONG and was the original bug: every child div inside an
      // offer is also id-prefixed "aod-offer" (aod-offer-price, aod-offer-soldBy, ...), so it
      // returned 39 "offers" for a product with 3. The real containers are the pinned buy-box
      // offer plus each div#aod-offer. Verified 2026-08-20.
      row:        ['#aod-pinned-offer', 'div#aod-offer'],
      // Same empty-.a-offscreen and CSS-in-container traps as the main price block; txtOf()
      // strips the <style> payload out of #aod-offer-price.
      oPrice:     ['[id^="aod-price-"] .a-offscreen', '#aod-offer-price .a-offscreen',
                   '[id^="aod-price-"]', '#aod-offer-price'],
      oSeller:    ['#aod-offer-soldBy .a-col-right a', '#aod-offer-soldBy .a-col-right span',
                   '[id^="aod-offer-soldBy"] .a-col-right'],
      oShip:      ['#aod-offer-shipsFrom .a-col-right span', '[id^="aod-offer-shipsFrom"] .a-col-right'],
      oCondition: ['#aod-offer-heading'],
    },
  };

  // Fields that are legitimately absent on plenty of perfectly healthy pages: most products
  // have no coupon, no strikethrough list price, no badge. health() reports these as `absent`
  // rather than `broken`, so a genuine selector break is not buried in expected noise.
  const OPTIONAL = new Set([
    'wasPrice', 'unitPrice', 'coupon', 'badgeChoice', 'badgeBest', 'delivery', 'byline',
    'detailList', 'brandRow', 'thumb', 'link', 'badge', 'histRow', 'rVerified', 'rHelpful',
  ]);

  /* ------------------------------------------------------------- page type */

  function pageType() {
    const p = location.pathname;
    if (/\/product-reviews\//.test(p)) return 'reviews';
    if (/\/(dp|gp\/product)\//.test(p)) return 'product';
    if (/^\/s\b/.test(p) || location.search.includes('k=')) return 'search';
    if (/order-history|your-orders/.test(p)) return 'orders';
    if (/\/gp\/cart|\/cart\//.test(p)) return 'cart';
    if (/\/hz\/wishlist|\/gp\/registry/.test(p)) return 'list';
    return 'unknown';
  }

  // Amazon renders behind a robot wall sometimes. Say so loudly rather than returning {}.
  function blocked() {
    if ($('#productTitle') || $('div.s-main-slot')) return null;
    const body = document.body ? document.body.innerText : '';
    if ($('form[action*="validateCaptcha"]') || /Enter the characters you see below/i.test(body)) return 'captcha';
    if (/Sorry! Something went wrong/i.test(body)) return 'error-page';
    return null;
  }

  function page() {
    return compact({
      type: pageType(),
      url: location.href.split('?')[0],
      asin: asinFrom(location.href),
      title: clip(document.title, 120),
      blocked: blocked(),
      capturedAt: new Date().toISOString(),
    }) || {};
  }

  /* --------------------------------------------------------------- product */

  function specs() {
    const out = {};
    for (const tr of $$(SEL.product.specRows.join(','))) {
      const k = txtOf($('th', tr));
      const v = txtOf($('td', tr));
      if (k && v && Object.keys(out).length < 30) out[k] = clip(v, 120);
    }
    // Older layout: "Key : Value" inside a bullet list with two nested spans.
    if (!Object.keys(out).length) {
      for (const li of $$(SEL.product.detailList.join(','))) {
        const spans = $$('span', li);
        if (spans.length >= 2) {
          const k = (clean(spans[0].textContent) || '').replace(/[\s:\u200E\u200F]+$/, '');
          const v = clean(spans[1].textContent);
          if (k && v && k.length < 60 && Object.keys(out).length < 30) out[k] = clip(v, 120);
        }
      }
    }
    return out;
  }

  function ratingValue() {
    // The alt text ("4.5 out of 5 stars") is the durable source; the title attr is a backup.
    const alt = pickText(SEL.product.rating);
    if (alt) {
      const m = alt.match(/([\d.]+)\s*out of/);
      if (m && Number.isFinite(parseFloat(m[1]))) return parseFloat(m[1]);
    }
    const t = pickAttr(SEL.product.ratingAttr, 'title');
    if (t) {
      const m = t.match(/([\d.]+)/);
      if (m && Number.isFinite(parseFloat(m[1]))) return parseFloat(m[1]);
    }
    return null;
  }

  // Brand moved out of #bylineInfo on current layouts — that id is simply gone, and
  // #bylineInfo_feature_div is present but empty. The reliable source is now the
  // product-overview table's "Brand" row. Verified 2026-08-20.
  function brandName() {
    const byline = pickText(SEL.product.byline);
    if (byline) return byline.replace(/^(Visit the |Brand: )/i, '').replace(/ Store$/i, '');
    for (const tr of $$(SEL.product.brandRow.join(','))) {
      const cells = $$('td,th', tr);
      if (cells.length >= 2 && /^brand$/i.test(txtOf(cells[0]) || '')) return txtOf(cells[1]);
    }
    return null;
  }

  function product() {
    const S = SEL.product;
    const asinEl = $(S.asinInput.join(','));
    const asin = clean(asinEl ? asinEl.value : null) || asinFrom(location.href);
    const priceRaw = pickText(S.price);
    const rec = {
      asin,
      url: dpUrl(asin) || location.href.split('?')[0],
      title: clip(pickText(S.title), 200),
      brand: clip(brandName(), 60),
      price: compact({
        current: money(priceRaw),
        currency: currency(priceRaw),
        was: money(pickText(S.wasPrice)),
        unit: clip(unitPrice(pickText(S.unitPrice)), 40),
      }),
      rating: compact({
        stars: ratingValue(),
        count: num(pickText(S.ratingCount)),
      }),
      availability: clip(pickText(S.availability), 80),
      shipsFrom: clip(pickText(S.shipsFrom), 60),
      soldBy: clip(pickText(S.soldBy), 60),
      delivery: clip(pickText(S.delivery), 80),
      coupon: clip(pickText(S.coupon), 80),
      badges: compact([
        pickText(S.badgeChoice) ? 'Amazon Choice' : null,
        pickText(S.badgeBest) ? 'Best Seller' : null,
      ]),
      category: clip($$(S.breadcrumb[0] + ' a').map((a) => clean(a.textContent)).filter(Boolean).join(' > '), 120),
      bullets: $$(S.bullets.join(',')).map((e) => clip(e.textContent, 160)).filter(Boolean).slice(0, 8),
      specs: specs(),
      image: pickAttr(S.image, 'data-old-hires') || pickAttr(S.image, 'src'),
    };
    // Say what is missing rather than letting the caller assume absence means "not applicable".
    const want = ['title', 'price', 'rating', 'availability', 'soldBy'];
    const missing = want.filter((k) => {
      const v = rec[k];
      return !v || (typeof v === 'object' && !Object.keys(v).length);
    });
    const out = compact(rec) || {};
    if (missing.length) out._missing = missing;
    return out;
  }

  /* ---------------------------------------------------------------- search */

  function isSponsored(el) {
    if (SEL.search.sponsored.some((s) => $(s, el))) return true;
    // Belt and braces: the word can appear as a bare label node with no stable class.
    const lbl = $('.puis-label-popover, .a-color-secondary', el);
    return /^\s*Sponsored\b/i.test(clean(lbl ? lbl.textContent : null) || '');
  }

  function searchResults(opts) {
    opts = opts || {};
    const limit = opts.limit == null ? 24 : opts.limit;
    const S = SEL.search;
    const nodes = $$(S.results[0]).length ? $$(S.results[0]) : $$(S.results.join(','));
    let sponsored = 0;
    let pos = 0;
    const out = [];
    for (const el of nodes) {
      const asin = el.getAttribute('data-asin');
      if (!asin || asin.length !== 10) continue;
      if (isSponsored(el)) { sponsored++; continue; }
      pos++;
      if (out.length >= limit) continue;
      const priceRaw = pickText(S.price, el);
      const ratingAlt = pickText(S.rating, el);
      const starsM = ratingAlt ? ratingAlt.match(/([\d.]+)/) : null;
      // Amazon stamps the signed-in user's own history into the badge slot as
      // "Purchased Aug 2025". Split it out: it answers "do I already own this?" for free,
      // and it is personal data, so it must be legible to whatever stores the capture.
      const badgeTxt = clip(pickText(S.badge, el), 40);
      const ownedM = badgeTxt ? badgeTxt.match(/^Purchased\s+(.+)$/i) : null;
      out.push(compact({
        pos,
        asin,
        title: clip(pickText(S.title, el), 140),
        price: money(priceRaw),
        was: money(pickText(S.wasPrice, el)),
        stars: starsM ? parseFloat(starsM[1]) : null,
        ratings: num(pickText(S.ratingCount, el)),
        prime: pick(S.prime, el) ? true : null,
        badge: ownedM ? null : badgeTxt,
        ownedSince: ownedM ? ownedM[1] : null,
        url: dpUrl(asin),
      }));
    }
    const qs = new URLSearchParams(location.search);
    return {
      query: qs.get('k'),
      sortedBy: qs.get('s') || 'relevance',
      shown: out.length,
      organicTotal: pos,
      sponsoredRemoved: sponsored,
      resultCountText: clip(pickText(S.resultCount), 80),
      results: out,
    };
  }

  /* --------------------------------------------------------------- reviews */

  function reviewsOn(doc, opts) {
    doc = doc || document;
    opts = opts || {};
    const S = SEL.reviews;
    const limit = opts.limit == null ? 8 : opts.limit;
    const cards = $$(S.card.join(','), doc).slice(0, limit);
    const dist = {};
    for (const tr of $$(S.histRow.join(','), doc)) {
      const first = tr.querySelector('td:first-child, .a-text-left');
      const last = tr.querySelector('td:last-child, .a-text-right');
      const label = clean(first ? first.textContent : null);
      const pct = clean(last ? last.textContent : null);
      const m = label ? label.match(/^([1-5])\s*star/i) : null;
      if (m && pct) dist[m[1] + 'star'] = pct;
    }
    const sample = cards.map((c) => {
        const sm = (pickText(S.rStars, c) || '').match(/([\d.]+)/);
        const dt = pickText(S.rDate, c);
        return compact({
          stars: sm ? parseFloat(sm[1]) : null,
          title: clip(pickText(S.rTitle, c), 100),
          date: clip(dt ? dt.replace(/^Reviewed in\s+/i, '') : null, 60),
          verified: pick(S.rVerified, c) ? true : null,
          helpful: num(pickText(S.rHelpful, c)),
          body: clip(pickText(S.rBody, c), 300),
        });
    });

    // Amazon ignores filterByStar=critical. Verified 2026-08-20: navigating (not fetching —
    // navigating) to the critical-filter URL still returned eight 4-and-5-star reviews. An
    // assistant that trusts the URL will report "the critical reviews look fine" having never
    // seen a critical review, which is worse than having no feature. Catch the lie here.
    const askedCritical = /filterByStar=critical/.test(location.search);
    const anyCritical = sample.some((r) => r.stars && r.stars <= 3);
    const out = compact({ distribution: dist, sample: sample }) || {};
    if (askedCritical && sample.length && !anyCritical) {
      out._warn = 'Requested filterByStar=critical but every returned review is 4-5 stars: '
        + 'Amazon ignored the filter. These are NOT critical reviews — do not report them as such.';
    }
    return out;
  }

  /* ----------------------------------------------------------------- offers */
  //
  // These used to fetch sub-pages. That is dead — verified 2026-08-20:
  //
  //   * Every all-offers-display AJAX endpoint returns 404 (three URL shapes tried).
  //   * /dp/<ASIN>?aod=1 fetched over XHR returns the page WITHOUT the offers panel; it is
  //     rendered client-side.
  //   * /product-reviews/<ASIN>/?filterByStar=critical returns the same 4-5 star reviews as
  //     the product page, over both fetch AND real navigation. Amazon ignores the filter.
  //
  // So there is no fetch path. The caller navigates, and these read the live DOM — which is
  // fine, because the caller drives the browser anyway. Read `_needs` on the result: it says
  // where to navigate to make the data appear, instead of silently returning nothing.

  // All sellers for the product. Requires the caller to be on /dp/<ASIN>?aod=1 — the buy box
  // shows one seller and the cheapest is frequently not it.
  function offers() {
    const S = SEL.offers;
    const rows = $$(S.row.join(','));
    if (!rows.length) {
      return { _needs: 'navigate to https://www.amazon.com/dp/' + (asinFrom(location.href) || '<ASIN>') +
        '?aod=1 — the all-sellers panel renders client-side and is not on the plain product page' };
    }
    return compact(rows.slice(0, 10).map((r) => compact({
      price: money(pickText(S.oPrice, r)),
      seller: clip(pickText(S.oSeller, r), 50),
      shipsFrom: clip(pickText(S.oShip, r), 50),
      condition: clip(pickText(S.oCondition, r), 40),
    })));
  }

  /* ------------------------------------------------------------------ full */

  async function full(opts) {
    opts = opts || {};
    const meta = page();
    if (meta.blocked) {
      return Object.assign({}, meta, {
        error: 'page is behind a ' + meta.blocked + ' wall — a human needs to clear it in this browser',
      });
    }
    const out = Object.assign({}, meta, { _v: VERSION });
    try {
      if (meta.type === 'product') {
        out.product = product();
        // The all-sellers panel exists only when the caller navigated with ?aod=1. Include it
        // when it is genuinely on the page; otherwise pass along where to go to get it.
        const o = offers();
        if (o && !o._needs) out.offers = o;
        else if (o && o._needs) out.offersHint = o._needs;
      } else if (meta.type === 'search') {
        out.search = searchResults(opts);
      } else if (meta.type === 'reviews') {
        out.reviews = reviewsOn(document, opts);
      } else {
        out.note = 'no extractor for page type "' + meta.type + '"; use __amzx.text() for a rough read';
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  }

  /* ---------------------------------------------------------------- health */

  // Which selectors still resolve on THIS page. Run it when a capture looks thin —
  // it distinguishes "Amazon changed the DOM" from "this product genuinely has no coupon".
  function health() {
    const t = pageType();
    const groups = t === 'product' ? { product: SEL.product }
      : t === 'search' ? { search: SEL.search }
      : t === 'reviews' ? { reviews: SEL.reviews }
      : { product: SEL.product, search: SEL.search };
    const report = { version: VERSION, pageType: t, url: location.href.split('?')[0],
                     ok: [], absent: [], broken: [] };
    for (const gname of Object.keys(groups)) {
      const g = groups[gname];
      for (const field of Object.keys(g)) {
        const cands = g[field];
        const idx = cands.findIndex((c) => $(c));
        const name = gname + '.' + field;
        if (idx === -1) {
          (OPTIONAL.has(field) ? report.absent : report.broken).push(name);
        } else {
          report.ok.push(name
            + (idx ? ' (fallback #' + idx + ')' : '')
            + (txtOf($(cands[idx])) === null ? ' [element only, no text]' : ''));
        }
      }
    }
    report.summary = report.ok.length + ' ok, ' + report.absent.length
      + ' absent-but-optional, ' + report.broken.length + ' BROKEN';
    return report;
  }

  // Escape hatch: rough visible text, for page types with no extractor yet.
  function text(max) {
    const el = document.querySelector('#dp-container, #search, #centerCol, main, body');
    return clip(el ? el.innerText : null, max == null ? 4000 : max);
  }

  /* ---------------------------------------------------------------- expose */

  const API = {
    version: VERSION,
    page: page,
    product: product,
    search: searchResults,
    reviews: reviewsOn,
    offers: offers,
    full: full,
    health: health,
    text: text,
    SEL: SEL,
    // Exposed for tests/parse.test.js, which runs this file under node with a stub window.
    // Not part of the caller-facing surface — do not build on it.
    _internals: { clean, clip, money, num, currency, compact, asinFrom, txtOf, unitPrice },
  };
  Object.defineProperty(window, '__amzx', { value: API, writable: true, configurable: true });
  }

  /* --------------------------------------------------------------- publish */
  //
  // Inject the library as a <script> tag rather than just calling it.
  //
  // Whether a userscript's `window` IS the page's `window` depends on how the extension
  // injected it, which depends on browser settings the script cannot see. Under Manifest V3 a
  // manager may run even a `@grant none` script in an isolated world — and then everything
  // above executes perfectly, defines __amzx on a `window` nobody else can reach, and reports
  // no error at all. That is the exact failure this library is built to prevent, so it should
  // not ship with that failure in its own loader.
  //
  // The DOM is shared across worlds, so a <script> element always evaluates in the page's main
  // world. This is correct in both cases: injected from the main world it is a no-op detour,
  // injected from a sandbox it is the only way across. Verified on amazon.com 2026-08-20 —
  // inline script execution is not CSP-blocked there.
  try {
    const el = document.createElement('script');
    el.textContent = '(' + __amzxLib.toString() + ')();';
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (e) {
    // Strict CSP, or no DOM at all (the node test harness). Define it here and let the
    // caller find out from health() whether it can actually see the page.
    try { __amzxLib(); } catch (_) { /* nothing left to try */ }
  }
})();
