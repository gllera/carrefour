// Carrefour offers scraper
// Walks every page of a Carrefour offers category and dumps each product to JSON + CSV.
//
// Usage:
//   node scrape.js                          # default URL below, output to ./products.{json,csv}
//   node scrape.js <url>                    # custom URL
//   node scrape.js <url> <outputBasename>   # custom URL + custom output prefix
//
// Env knobs:
//   SCRAPE_WORKERS=N   number of concurrent campaign workers in hub mode (default 3)
//
// Hub mode (URL ends in /c): discovers every /g campaign on the hub and
// scrapes them with N concurrent workers sharing one Chrome session.
// Single mode (URL ends in /g): walks one listing sequentially.

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'https://www.carrefour.es/supermercado/ofertas50qvmayo26/ofertas50qvmayo26/g';
const ORIGIN = 'https://www.carrefour.es';
const PAGE_SIZE = 24;                   // Carrefour serves 24 cards/page
const NAV_TIMEOUT_MS = 90_000;
const RETRIES_PER_PAGE = 3;
const POLITE_DELAY_MS = 800;            // baseline gap between page loads
const POLITE_JITTER_MS = 600;           // random additional gap
const RATE_LIMIT_BACKOFF_MS = 15_000;   // pause everyone when a 429/503 is seen
const DEFAULT_WORKERS = 3;              // hub-mode default concurrency

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polite gap with jitter so repeated loads don't fall on a perfect cadence.
const politeGap = () => sleep(POLITE_DELAY_MS + Math.floor(Math.random() * POLITE_JITTER_MS));

// Shared cool-down: when one worker is rate-limited, every worker waits.
let coolDownUntil = 0;
async function awaitCoolDown() {
  const wait = coolDownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}
function tripCoolDown(ms = RATE_LIMIT_BACKOFF_MS) {
  const until = Date.now() + ms;
  if (until > coolDownUntil) coolDownUntil = until;
}

function buildPageUrl(baseUrl, offset) {
  const u = new URL(baseUrl);
  if (offset > 0) u.searchParams.set('offset', String(offset));
  else u.searchParams.delete('offset');
  return u.toString();
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = 500;
    const pause = 80;
    let last = -1;
    for (let i = 0; i < 30; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, pause));
      const h = document.body.scrollHeight;
      if (h === last && window.scrollY + window.innerHeight >= h - 5) break;
      last = h;
    }
    window.scrollTo(0, 0);
  });
}

// Extract metadata about the listing on the current page.
async function readPageMeta(page) {
  return page.evaluate(() => {
    const txt = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.trim() : null;
    };
    const items = document.querySelectorAll('.product-card-list__item');
    const total = (() => {
      const spans = document.querySelectorAll('.pagination__results-item');
      // 3rd span ("1 - 24 de 640 productos"): last is the total
      if (spans.length >= 3) return parseInt(spans[spans.length - 1].innerText.replace(/\D/g, ''), 10);
      return null;
    })();
    const pageInfo = txt('.pagination__main'); // e.g. "Página 1 de 27"
    return {
      cardCount: items.length,
      total,
      pageInfo,
      title: document.title,
    };
  });
}

// Extract every product card on the currently loaded page.
async function extractProducts(page) {
  return page.evaluate((origin) => {
    const absolutize = (href) => {
      if (!href) return null;
      try { return new URL(href, origin).toString(); } catch { return href; }
    };
    const parsePrice = (s) => {
      if (!s) return null;
      // "6,95 €" or "6,95 €/kg" → 6.95
      const m = s.replace(/\s/g, '').match(/(\d+[.,]?\d*)/);
      return m ? parseFloat(m[1].replace(',', '.')) : null;
    };
    const txt = (el, sel) => {
      const x = el.querySelector(sel);
      return x ? x.innerText.trim() : null;
    };
    const attr = (el, sel, name) => {
      const x = el.querySelector(sel);
      return x ? x.getAttribute(name) : null;
    };

    const cards = Array.from(document.querySelectorAll('.product-card-list__item'));
    return cards.map((li, idx) => {
      const parent = li.querySelector('.product-card__parent');
      const priceStr = parent ? parent.getAttribute('app_price') : null;
      const ppuAttr = parent ? parent.getAttribute('app_price_per_unit') : null;
      const brand = parent ? parent.getAttribute('brand') : null;
      const catalog = parent ? parent.getAttribute('catalog') : null;
      const docType = parent ? parent.getAttribute('document_type') : null;

      const titleA = li.querySelector('.product-card__title a, h2 a');
      const mediaA = li.querySelector('.product-card__media-link');
      const img = li.querySelector('.product-card__image');

      const href = (titleA && titleA.getAttribute('href')) ||
                   (mediaA && mediaA.getAttribute('href'));
      const url = absolutize(href);

      // Product ID lives in the URL, e.g. /<slug>/R-VC4AECOMM-506922/p or /<slug>/R-prod731236/p
      let productId = null;
      if (href) {
        const m = href.match(/\/([RP]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/p\b/);
        if (m) productId = m[1];
        else {
          const m2 = href.match(/\/(\d{4,})\/p\b/);
          if (m2) productId = m2[1];
        }
      }

      const name = (titleA && titleA.innerText.trim()) ||
                   (img && img.getAttribute('alt')) || null;

      const priceText = txt(li, '.product-card__price') || priceStr;
      const pricePerUnitText = txt(li, '.product-card__price-per-unit');

      // Some products show an original (strikethrough) price for direct discounts.
      const strikethrough = li.querySelector('.product-card__price--strikethrough, .product-card__previous-price, [class*="strikethrough"]:not([class*="container"])');
      const originalPriceText = strikethrough ? strikethrough.innerText.trim() : null;

      // Promo / badge
      const badgeTitle = attr(li, '.badge__name', 'title') || txt(li, '.badge__name');
      const badgeColor = (() => {
        const b = li.querySelector('.badge__name');
        if (!b) return null;
        const s = b.getAttribute('style') || '';
        const m = s.match(/background-color\s*:\s*([^;]+)/i);
        return m ? m[1].trim() : null;
      })();
      const promoDesc = txt(li, '.tooltip__text-section');
      const promoValidUntil = txt(li, '.tooltip__valid-until');
      const promoLink = absolutize(attr(li, '.badge__link', 'href'));

      // Discount text (some campaigns mark "-50%" style)
      const discountEl = li.querySelector('[class*="discount"], [class*="Discount"]');
      const discountText = discountEl ? discountEl.innerText.trim() : null;

      return {
        position: idx,
        productId,
        name,
        brand,
        url,
        // Carrefour uses a Vue lazy-load directive: real URL lives in data-src
        // and src holds a base64 LQIP placeholder until the image enters the
        // viewport. We block image requests for speed, so the swap never
        // completes for off-screen cards — read data-src first.
        imageUrl: img ? (img.getAttribute('data-src') || img.getAttribute('src')) : null,
        imageAlt: img ? img.getAttribute('alt') : null,
        priceText,
        price: parsePrice(priceText),
        originalPriceText,
        originalPrice: parsePrice(originalPriceText),
        pricePerUnitText,
        pricePerUnit: parsePrice(pricePerUnitText),
        pricePerUnitAttr: ppuAttr,
        catalog,
        documentType: docType,
        discountText,
        promo: badgeTitle ? {
          title: badgeTitle,
          color: badgeColor,
          description: promoDesc,
          validUntil: promoValidUntil,
          campaignUrl: promoLink,
        } : null,
      };
    });
  }, ORIGIN);
}

async function loadPage(page, url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES_PER_PAGE; attempt++) {
    try {
      await awaitCoolDown();
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      const status = resp && resp.status();
      // Server-side trouble (rate limit, 5xx) — trip a shared cool-down so
      // every worker pauses, then retry. Plain client-side 4xx are not retried.
      if (status === 429 || (status >= 500 && status < 600)) {
        console.error(`  HTTP ${status} from server — cool-down ${RATE_LIMIT_BACKOFF_MS}ms then retry`);
        tripCoolDown();
        throw new Error(`HTTP ${status}`);
      }
      if (!resp || status >= 400) throw new Error(`HTTP ${status}`);
      // wait for the product grid to materialise
      await page.waitForSelector('.product-card-list__item', { timeout: 30_000 });
      await autoScroll(page);
      await sleep(300 + Math.floor(Math.random() * 400)); // settle
      return;
    } catch (e) {
      lastErr = e;
      console.error(`  attempt ${attempt} failed: ${e.message}`);
      // exponential-ish back-off with jitter
      await sleep((1500 + Math.floor(Math.random() * 1500)) * attempt);
    }
  }
  throw lastErr || new Error('Failed to load page');
}

function toCsv(rows) {
  const headers = [
    'productId', 'name', 'brand', 'price', 'priceText',
    'originalPrice', 'originalPriceText',
    'pricePerUnit', 'pricePerUnitText',
    'catalog', 'documentType', 'discountText',
    'promoTitle', 'promoValidUntil', 'promoDescription', 'promoUrl',
    'url', 'imageUrl', 'pageNumber', 'positionOnPage',
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.productId, r.name, r.brand, r.price, r.priceText,
      r.originalPrice, r.originalPriceText,
      r.pricePerUnit, r.pricePerUnitText,
      r.catalog, r.documentType, r.discountText,
      r.promo && r.promo.title, r.promo && r.promo.validUntil,
      r.promo && r.promo.description, r.promo && r.promo.campaignUrl,
      r.url, r.imageUrl, r.pageNumber, r.positionOnPage,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

// Walks one listing URL (a /g or /c that already shows products) page-by-page.
// Mutates `ingest` to collect into the shared store; returns the per-campaign
// summary that the top-level caller can log.
//
// Offsets are walked sequentially inside a campaign — that matches how a real
// shopper paginates and keeps the per-listing request rate low even when the
// hub is being scraped by multiple workers in parallel.
async function scrapeListing(page, baseUrl, ingest, workerId = '') {
  const tag = workerId ? `[w${workerId}]` : '';
  const campaignName = baseUrl.split('/')[4] || baseUrl;
  console.log(`\n${tag}=== ${campaignName}`);
  await loadPage(page, buildPageUrl(baseUrl, 0));
  const meta = await readPageMeta(page);
  const total = meta.total || (meta.cardCount * 27);
  const pageSize = meta.cardCount || PAGE_SIZE;
  const totalPages = Math.ceil(total / pageSize);
  console.log(`${tag}  ${campaignName}: ${total} products / ${totalPages} pages`);

  let collected = 0;
  const firstPageProducts = await extractProducts(page);
  ingest(firstPageProducts, 1, baseUrl);
  collected += firstPageProducts.length;

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
    const offset = (pageNumber - 1) * pageSize;
    const url = buildPageUrl(baseUrl, offset);
    try {
      await loadPage(page, url);
      const products = await extractProducts(page);
      ingest(products, pageNumber, baseUrl);
      collected += products.length;
      if (products.length === 0) { console.log(`${tag}  ${campaignName}: empty page ${pageNumber} — stopping`); break; }
      await politeGap();
    } catch (e) {
      console.error(`${tag}  ${campaignName} page ${pageNumber} failed: ${e.message}`);
    }
  }
  console.log(`${tag}  ${campaignName}: done (${collected} cards visited)`);
  return { url: baseUrl, total, collected };
}

// From a hub `/c` page, collect every campaign-style listing link (`/g` URLs).
async function discoverCampaignUrls(page, hubUrl) {
  console.log(`Discovering campaigns from ${hubUrl}`);
  await page.goto(hubUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
  await sleep(2000);
  await autoScroll(page);
  await sleep(1500);
  const links = await page.evaluate((origin) => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      if (!raw) continue;
      let url;
      try { url = new URL(raw, origin).toString(); } catch { continue; }
      if (!url.startsWith(origin + '/supermercado/')) continue;
      // /<slug>/<id>/g  — promotional campaign listings
      if (!/\/[^/]+\/[^/?#]+\/g(?:[?#].*)?$/.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }, ORIGIN);
  console.log(`  found ${links.length} campaign URLs`);
  for (const u of links) console.log('    ' + u);
  return links;
}

// Configure a Chrome tab the way our scraper needs: UA, viewport, asset blocking.
// Pages share cookies via the parent browser context — setting cookies once on
// the first page is enough.
async function configurePage(page) {
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'media' || t === 'font' || t === 'image') return req.abort();
    return req.continue();
  });
}

(async () => {
  const baseUrl = process.argv[2] || DEFAULT_URL;
  const outBase = process.argv[3] || 'products';
  // If the URL ends in /c we treat it as a hub and walk every /g child campaign.
  const isHub = /\/c(?:[?#].*)?$/.test(baseUrl);
  const requestedWorkers = parseInt(process.env.SCRAPE_WORKERS, 10);
  const workers = isHub
    ? Math.max(1, Number.isFinite(requestedWorkers) ? requestedWorkers : DEFAULT_WORKERS)
    : 1;

  console.log('Carrefour scraper');
  console.log('  base URL:', baseUrl);
  console.log('  mode:    ', isHub ? `hub (walk every /g campaign, ${workers} workers)` : 'single listing');
  console.log('  out:     ', `${outBase}.json`, `${outBase}.csv`);
  console.log();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const page = await browser.newPage();
  await configurePage(page);
  // Persist a postal code so geo-gated content shows up. Cookies are
  // browser-context wide, so the other worker tabs inherit them.
  await page.setCookie(
    { name: 'postalCode',     value: '28904', domain: '.carrefour.es', path: '/' },
    { name: 'userPostalCode', value: '28904', domain: '.carrefour.es', path: '/' },
  );

  try {
    const seen = new Map();           // productId → product
    const ordered = [];               // preserves first-seen order

    // Mutates the shared store. Stamps each product with the source campaign so
    // we can tell which listing first introduced it. `position` is renamed to
    // a per-campaign positionOnPage for the JSON consumer's sake.
    const ingest = (products, pageNumber, sourceUrl) => {
      let added = 0;
      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        if (!p.name && !p.url) continue; // banner / sponsored slot
        const key = p.productId || p.url || `${sourceUrl}#${pageNumber}:${p.position}:${p.name}`;
        if (seen.has(key)) {
          // Already collected — record this campaign as another source.
          const existing = seen.get(key);
          existing.sourceUrls = existing.sourceUrls || [existing.sourceUrl];
          if (!existing.sourceUrls.includes(sourceUrl)) existing.sourceUrls.push(sourceUrl);
          continue;
        }
        const enriched = {
          ...p,
          pageNumber,
          positionOnPage: p.position,
          sourceUrl,
        };
        delete enriched.position;
        seen.set(key, enriched);
        ordered.push(enriched);
        added++;
      }
      return added;
    };

    let urls;
    if (isHub) {
      urls = await discoverCampaignUrls(page, baseUrl);
      if (urls.length === 0) throw new Error('No /g campaign URLs found on hub — is this really a hub page?');
    } else {
      urls = [baseUrl];
    }

    // Build a worker pool sharing the same Chrome session.
    // Why share the browser: same Cloudflare clearance, same IP, same fingerprint —
    // it looks like one user with several tabs open instead of N separate sessions.
    const summaries = [];
    const effectiveWorkers = Math.min(workers, urls.length);
    if (effectiveWorkers <= 1) {
      // Single-worker path: reuse the page we already configured.
      for (const u of urls) {
        try {
          summaries.push(await scrapeListing(page, u, ingest));
        } catch (e) {
          console.error(`  campaign failed: ${e.message}`);
          summaries.push({ url: u, error: e.message });
        }
      }
    } else {
      console.log(`\nStarting ${effectiveWorkers} parallel workers for ${urls.length} campaigns`);
      // Sort longest campaigns first so the slowest start at t=0 and the small
      // ones backfill — keeps all workers busy until the very end.
      // (Heuristic: campaign size correlates with promo type; we don't know
      //  sizes a priori, but the hub returned them in a roughly decreasing
      //  order. Sort lexicographically descending as a cheap proxy for "the
      //  bigger pages first" — overridden by per-campaign discovery anyway.)
      const queue = urls.slice();
      const startedAt = Date.now();
      // Critical: each worker gets its own browser CONTEXT (separate cookies,
      // cache and storage). When workers share a context, Carrefour's Vue app
      // and the shared HTTP cache cause cross-tab interference — different
      // tabs end up rendering overlapping/identical product sets and we lose
      // ~35% of unique products. Separate contexts (still one Chrome process,
      // one IP) keep navigation deterministic per worker.
      const startWorker = async (id) => {
        const ctx = await browser.createBrowserContext();
        const myPage = await ctx.newPage();
        await configurePage(myPage);
        await myPage.setCookie(
          { name: 'postalCode',     value: '28904', domain: '.carrefour.es', path: '/' },
          { name: 'userPostalCode', value: '28904', domain: '.carrefour.es', path: '/' },
        );
        // Stagger so all workers don't pound Cloudflare at the same instant.
        await sleep(id * 1500);
        try {
          while (queue.length > 0) {
            const u = queue.shift();
            if (!u) break;
            try {
              const summary = await scrapeListing(myPage, u, ingest, id + 1);
              summaries.push(summary);
            } catch (e) {
              console.error(`[w${id + 1}] campaign ${u} failed: ${e.message}`);
              summaries.push({ url: u, error: e.message });
            }
            // breather between campaigns on the same worker
            await politeGap();
          }
        } finally {
          await myPage.close().catch(() => {});
          await ctx.close().catch(() => {});
        }
      };
      await Promise.all(Array.from({ length: effectiveWorkers }, (_, i) => startWorker(i)));
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`\nParallel scrape finished in ${elapsed}s`);
    }

    // Persist results
    const jsonPath = path.resolve(`${outBase}.json`);
    const csvPath = path.resolve(`${outBase}.csv`);
    const reportedTotal = summaries.reduce((s, c) => s + (c.total || 0), 0);
    const payload = {
      scrapedAt: new Date().toISOString(),
      sourceUrl: baseUrl,
      hubMode: isHub,
      campaigns: summaries,
      reportedTotal,
      collected: ordered.length,
      products: ordered,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(csvPath, toCsv(ordered));

    console.log();
    console.log(`✓ collected ${ordered.length} unique products across ${summaries.length} campaign(s) (sum of campaign totals: ${reportedTotal})`);
    console.log(`✓ saved JSON → ${jsonPath}`);
    console.log(`✓ saved CSV  → ${csvPath}`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
