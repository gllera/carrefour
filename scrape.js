// Carrefour offers scraper
// Walks every page of a Carrefour offers category and dumps each product to JSON + CSV.
//
// Usage:
//   node scrape.js                          # default URL below, output to ./products.{json,csv}
//   node scrape.js <url>                    # custom URL
//   node scrape.js <url> <outputBasename>   # custom URL + custom output prefix
//
// The default URL is the "50% que vuelve mayo 26" campaign.

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
const POLITE_DELAY_MS = 800;            // gap between page loads

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        imageUrl: img ? img.getAttribute('src') : null,
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
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp && resp.status()}`);
      // wait for the product grid to materialise
      await page.waitForSelector('.product-card-list__item', { timeout: 30_000 });
      await autoScroll(page);
      // small settle delay
      await sleep(400);
      return;
    } catch (e) {
      lastErr = e;
      console.error(`  attempt ${attempt} failed: ${e.message}`);
      await sleep(2000 * attempt);
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

(async () => {
  const baseUrl = process.argv[2] || DEFAULT_URL;
  const outBase = process.argv[3] || 'products';

  console.log('Carrefour scraper');
  console.log('  base URL:', baseUrl);
  console.log('  out:    ', `${outBase}.json`, `${outBase}.csv`);
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
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900 });
  // Block heavy assets to speed things up; we still need HTML + JS.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'media' || t === 'font' || t === 'image') return req.abort();
    return req.continue();
  });

  try {
    // Load first page to discover total
    console.log('→ page 1 / ?  (offset=0)');
    await loadPage(page, buildPageUrl(baseUrl, 0));
    const meta = await readPageMeta(page);
    const total = meta.total || (meta.cardCount * 27);
    const pageSize = meta.cardCount || PAGE_SIZE;
    const totalPages = Math.ceil(total / pageSize);
    console.log(`  detected: ${total} products, ${pageSize}/page, ${totalPages} pages`);
    console.log(`  page header: ${meta.pageInfo || '(n/a)'}`);

    const seen = new Map();           // productId → product
    const ordered = [];               // preserves first-seen order

    const ingest = (products, pageNumber) => {
      let added = 0;
      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        // Skip non-product slots (banner/sponsored placeholders without name+url).
        if (!p.name && !p.url) continue;
        const key = p.productId || p.url || `${pageNumber}:${p.position}:${p.name}`;
        if (seen.has(key)) continue;
        const enriched = { ...p, pageNumber, positionOnPage: p.position };
        delete enriched.position;
        seen.set(key, enriched);
        ordered.push(enriched);
        added++;
      }
      return added;
    };

    const firstPageProducts = await extractProducts(page);
    let added = ingest(firstPageProducts, 1);
    console.log(`  extracted ${firstPageProducts.length} cards, ${added} new (total ${ordered.length}/${total})`);

    for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
      const offset = (pageNumber - 1) * pageSize;
      const url = buildPageUrl(baseUrl, offset);
      console.log(`→ page ${pageNumber} / ${totalPages}  (offset=${offset})`);
      try {
        await loadPage(page, url);
        const products = await extractProducts(page);
        const newCount = ingest(products, pageNumber);
        console.log(`  extracted ${products.length} cards, ${newCount} new (total ${ordered.length}/${total})`);
        if (products.length === 0) {
          console.log('  empty page — stopping');
          break;
        }
        await sleep(POLITE_DELAY_MS);
      } catch (e) {
        console.error(`  page ${pageNumber} permanently failed: ${e.message}`);
      }
    }

    // Persist results
    const jsonPath = path.resolve(`${outBase}.json`);
    const csvPath = path.resolve(`${outBase}.csv`);
    const payload = {
      scrapedAt: new Date().toISOString(),
      sourceUrl: baseUrl,
      reportedTotal: total,
      collected: ordered.length,
      products: ordered,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(csvPath, toCsv(ordered));

    console.log();
    console.log(`✓ collected ${ordered.length} unique products (reported total: ${total})`);
    console.log(`✓ saved JSON → ${jsonPath}`);
    console.log(`✓ saved CSV  → ${csvPath}`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
