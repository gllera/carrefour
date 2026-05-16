// Repair the imageUrl field in an existing products.json.
//
// scrape.js (pre-fix) captured img.src directly. Carrefour lazy-loads card
// images: the real URL is on data-src, and src holds a base64 LQIP until the
// card enters the viewport. Because we block image requests for speed, the
// swap never happens for off-screen cards — so ~2/3 of products end up with
// the placeholder in imageUrl.
//
// This script re-visits the listing pages of products.json's sourceUrl and
// patches imageUrl for every product where it is currently a data: URL or
// missing. All other fields (including urlValidation enrichment) are kept.
//
// Usage:
//   node repair_images.js                      # in-place repair of ./products.json
//   node repair_images.js <products.json>      # custom path

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://www.carrefour.es';
const NAV_TIMEOUT_MS = 90_000;
const RETRIES_PER_PAGE = 3;
const POLITE_DELAY_MS = 800;

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
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, pause));
      const h = document.body.scrollHeight;
      if (h === last && window.scrollY + window.innerHeight >= h - 5) break;
      last = h;
    }
    window.scrollTo(0, 0);
  });
}

async function extractCardImages(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.product-card-list__item'));
    return cards.map((li) => {
      const titleA = li.querySelector('.product-card__title a, h2 a');
      const mediaA = li.querySelector('.product-card__media-link');
      const href = (titleA && titleA.getAttribute('href')) ||
                   (mediaA && mediaA.getAttribute('href'));
      let productId = null;
      if (href) {
        const m = href.match(/\/([RP]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/p\b/);
        if (m) productId = m[1];
        else {
          const m2 = href.match(/\/(\d{4,})\/p\b/);
          if (m2) productId = m2[1];
        }
      }
      const img = li.querySelector('.product-card__image');
      const imageUrl = img ? (img.getAttribute('data-src') || img.getAttribute('src')) : null;
      return { productId, href, imageUrl };
    });
  });
}

async function loadPage(page, url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES_PER_PAGE; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp && resp.status()}`);
      await page.waitForSelector('.product-card-list__item', { timeout: 30_000 });
      await autoScroll(page);
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

(async () => {
  const productsPath = path.resolve(process.argv[2] || 'products.json');
  if (!fs.existsSync(productsPath)) {
    console.error(`fatal: ${productsPath} not found`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
  const products = data.products || [];
  const baseUrl = data.sourceUrl;
  if (!baseUrl) {
    console.error('fatal: products.json has no sourceUrl');
    process.exit(1);
  }

  // Build absolute URL → product index for fast lookup, since href on cards
  // includes the canonical product path that may not match productId 1:1.
  const byUrl = new Map();
  const byId = new Map();
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (p.url) byUrl.set(p.url, i);
    if (p.productId) byId.set(p.productId, i);
  }

  const placeholders = products.filter(p => !p.imageUrl || (p.imageUrl || '').startsWith('data:'));
  console.log('Image repair');
  console.log('  source:    ', baseUrl);
  console.log('  products:  ', products.length);
  console.log('  to repair: ', placeholders.length);
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
  // Same speed-up as scrape.js: block media/font/image bytes. We only need
  // attributes, never the rendered image.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'media' || t === 'font' || t === 'image') return req.abort();
    return req.continue();
  });

  // We don't know the total without loading page 1 first. Keep walking pages
  // until we see an empty grid (matches scrape.js's behaviour).
  let pageSize = 24;
  let totalPages = null;
  let repaired = 0;
  let notFound = 0;

  try {
    let offset = 0;
    let pageNumber = 1;
    while (true) {
      const url = buildPageUrl(baseUrl, offset);
      console.log(`→ page ${pageNumber}${totalPages ? ` / ${totalPages}` : ''}  (offset=${offset})`);
      try {
        await loadPage(page, url);

        if (pageNumber === 1) {
          const meta = await page.evaluate(() => {
            const items = document.querySelectorAll('.product-card-list__item');
            const spans = document.querySelectorAll('.pagination__results-item');
            const total = spans.length >= 3
              ? parseInt(spans[spans.length - 1].innerText.replace(/\D/g, ''), 10)
              : null;
            return { cardCount: items.length, total };
          });
          if (meta.cardCount) pageSize = meta.cardCount;
          if (meta.total) totalPages = Math.ceil(meta.total / pageSize);
        }

        const cards = await extractCardImages(page);
        if (cards.length === 0) {
          console.log('  empty page — stopping');
          break;
        }
        let pageRepaired = 0;
        for (const c of cards) {
          if (!c.imageUrl || c.imageUrl.startsWith('data:')) continue;
          // Resolve absolute href the same way scrape.js does for matching.
          let absUrl = null;
          if (c.href) {
            try { absUrl = new URL(c.href, ORIGIN).toString(); } catch { absUrl = c.href; }
          }
          let idx = (absUrl && byUrl.get(absUrl));
          if (idx === undefined && c.productId) idx = byId.get(c.productId);
          if (idx === undefined) { notFound++; continue; }
          const existing = products[idx].imageUrl || '';
          if (existing.startsWith('http')) continue; // already good
          products[idx].imageUrl = c.imageUrl;
          repaired++;
          pageRepaired++;
        }
        console.log(`  ${cards.length} cards, ${pageRepaired} repaired (total repaired: ${repaired})`);

        if (totalPages && pageNumber >= totalPages) break;
        if (!totalPages && cards.length < pageSize) {
          // Heuristic stop if we don't know total
          break;
        }
        await sleep(POLITE_DELAY_MS);
      } catch (e) {
        console.error(`  page ${pageNumber} permanently failed: ${e.message}`);
        // Skip and continue; partial repair is better than aborting.
        if (totalPages && pageNumber >= totalPages) break;
      }
      pageNumber++;
      offset = (pageNumber - 1) * pageSize;
    }

    data.imageRepair = {
      repairedAt: new Date().toISOString(),
      repaired,
      notMatched: notFound,
    };
    fs.writeFileSync(productsPath, JSON.stringify(data, null, 2));

    console.log();
    console.log(`✓ repaired ${repaired} imageUrl entries`);
    if (notFound) console.log(`  ${notFound} cards on listing pages had no matching product in JSON`);
    console.log(`✓ wrote → ${productsPath}`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
