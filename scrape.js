// Carrefour offers scraper
// Walks every page of a Carrefour offers category and dumps each product to
// JSON, CSV and a self-contained, searchable HTML page.
//
// Usage:
//   node scrape.js                          # default URL, output to ./products.{json,csv,html}
//   node scrape.js <url>                    # custom URL
//   node scrape.js <url> <outputBasename>   # custom URL + custom output prefix
//
// Env:
//   SCRAPE_WORKERS=N   concurrent campaign workers in hub mode (default 3)
//
// Hub mode (URL ends in /c): discovers every /g campaign and scrapes them in
// parallel. Single mode (/g): walks one listing.

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { buildAiPayload, renderReport, inferCategory } = require('./analyze');

const DEFAULT_URL = 'https://www.carrefour.es/supermercado/ofertas/cat20968591/c';
const ORIGIN = 'https://www.carrefour.es';
const POSTAL_CODE = '28904';
// The promo grids list Carrefour's NATIONAL catalog, but each shopper is pinned
// to one store ("sale point") whose assortment is only a subset. A product in a
// grid but not in the store redirects to its category when opened — the "broken
// links" a shopper hits. We reproduce the target store during link verification
// (see verifyAccessibility) with this cookie so we can drop what they can't open.
// Format: <storeId>||<postal>|<deliveryMode>|<n>, copied from a live session's
// `salepoint` cookie. Change it if the offers page should target another store.
const SALEPOINT = '005704||28904|A_DOMICILIO|0';
const PAGE_SIZE = 24;
const NAV_TIMEOUT_MS = 90_000;
const RETRIES_PER_PAGE = 3;
const POLITE_DELAY_MS = 800;
const POLITE_JITTER_MS = 600;
const RATE_LIMIT_BACKOFF_MS = 15_000;
const DEFAULT_WORKERS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeGap = () => sleep(POLITE_DELAY_MS + Math.floor(Math.random() * POLITE_JITTER_MS));

// Shared cool-down: when one worker is rate-limited, every worker waits.
let coolDownUntil = 0;
const awaitCoolDown = () => sleep(Math.max(0, coolDownUntil - Date.now()));
const tripCoolDown = (ms = RATE_LIMIT_BACKOFF_MS) => {
  coolDownUntil = Math.max(coolDownUntil, Date.now() + ms);
};

function buildPageUrl(baseUrl, offset) {
  const u = new URL(baseUrl);
  if (offset > 0) u.searchParams.set('offset', String(offset));
  else u.searchParams.delete('offset');
  return u.toString();
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    let last = -1;
    for (let i = 0; i < 30; i++) {
      window.scrollBy(0, 500);
      await new Promise((r) => setTimeout(r, 80));
      const h = document.body.scrollHeight;
      if (h === last && window.scrollY + window.innerHeight >= h - 5) break;
      last = h;
    }
    window.scrollTo(0, 0);
  });
}

async function readPageMeta(page) {
  return page.evaluate(() => {
    const spans = document.querySelectorAll('.pagination__results-item');
    return {
      cardCount: document.querySelectorAll('.product-card-list__item').length,
      // "1 - 24 de 640 productos" → last span holds the total
      total: spans.length >= 3
        ? parseInt(spans[spans.length - 1].innerText.replace(/\D/g, ''), 10)
        : null,
    };
  });
}

async function extractProducts(page) {
  return page.evaluate((origin) => {
    const absolutize = (h) => {
      if (!h) return null;
      try { return new URL(h, origin).toString(); } catch { return h; }
    };
    const parsePrice = (s) => {
      if (!s) return null;
      const m = s.replace(/\s/g, '').match(/(\d+[.,]?\d*)/);
      return m ? parseFloat(m[1].replace(',', '.')) : null;
    };
    const txt = (el, sel) => el.querySelector(sel)?.innerText.trim() ?? null;
    const attr = (el, sel, n) => el.querySelector(sel)?.getAttribute(n) ?? null;
    const productIdFromHref = (h) =>
      h?.match(/\/([RP]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/p\b/)?.[1]
      ?? h?.match(/\/(\d{4,})\/p\b/)?.[1]
      ?? null;

    return Array.from(document.querySelectorAll('.product-card-list__item')).map((li, idx) => {
      const parent = li.querySelector('.product-card__parent');
      const titleA = li.querySelector('.product-card__title a, h2 a');
      const mediaA = li.querySelector('.product-card__media-link');
      const img = li.querySelector('.product-card__image');
      const badge = li.querySelector('.badge__name');

      const href = titleA?.getAttribute('href') ?? mediaA?.getAttribute('href') ?? null;
      const priceText = txt(li, '.product-card__price') ?? parent?.getAttribute('app_price') ?? null;
      const strikeText = li.querySelector('.product-card__price--strikethrough, .product-card__previous-price, [class*="strikethrough"]:not([class*="container"])')?.innerText.trim() ?? null;
      const ppuText = txt(li, '.product-card__price-per-unit');
      const badgeTitle = badge?.getAttribute('title') ?? badge?.innerText.trim() ?? null;

      return {
        position: idx,
        productId: productIdFromHref(href),
        name: titleA?.innerText.trim() ?? img?.getAttribute('alt') ?? null,
        brand: parent?.getAttribute('brand') ?? null,
        url: absolutize(href),
        // Vue lazy-loads images: real URL is on data-src; src holds a base64
        // LQIP until the card enters the viewport. We block image requests
        // for speed, so off-screen cards never swap — read data-src first.
        imageUrl: img ? (img.getAttribute('data-src') || img.getAttribute('src')) : null,
        imageAlt: img?.getAttribute('alt') ?? null,
        priceText,
        price: parsePrice(priceText),
        originalPriceText: strikeText,
        originalPrice: parsePrice(strikeText),
        pricePerUnitText: ppuText,
        pricePerUnit: parsePrice(ppuText),
        pricePerUnitAttr: parent?.getAttribute('app_price_per_unit') ?? null,
        catalog: parent?.getAttribute('catalog') ?? null,
        documentType: parent?.getAttribute('document_type') ?? null,
        discountText: li.querySelector('[class*="discount"], [class*="Discount"]')?.innerText.trim() ?? null,
        promo: badgeTitle ? {
          title: badgeTitle,
          color: badge?.getAttribute('style')?.match(/background-color\s*:\s*([^;]+)/i)?.[1].trim() ?? null,
          description: txt(li, '.tooltip__text-section'),
          validUntil: txt(li, '.tooltip__valid-until'),
          campaignUrl: absolutize(attr(li, '.badge__link', 'href')),
        } : null,
      };
    });
  }, ORIGIN);
}

async function loadPage(page, url) {
  for (let attempt = 1; attempt <= RETRIES_PER_PAGE; attempt++) {
    try {
      await awaitCoolDown();
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      const status = resp?.status() ?? 0;
      // Server-side trouble (rate limit, 5xx) — trip a shared cool-down so
      // every worker pauses, then retry. Client-side 4xx are not retried.
      if (status === 429 || (status >= 500 && status < 600)) {
        console.error(`  HTTP ${status} — cool-down ${RATE_LIMIT_BACKOFF_MS}ms`);
        tripCoolDown();
        throw new Error(`HTTP ${status}`);
      }
      if (!status || status >= 400) throw new Error(`HTTP ${status}`);
      await page.waitForSelector('.product-card-list__item', { timeout: 30_000 });
      await autoScroll(page);
      await sleep(300 + Math.floor(Math.random() * 400));
      return;
    } catch (e) {
      console.error(`  attempt ${attempt} failed: ${e.message}`);
      if (attempt === RETRIES_PER_PAGE) throw e;
      await sleep((1500 + Math.floor(Math.random() * 1500)) * attempt);
    }
  }
}

const escapeHtml = (s) => s == null ? '' : String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtPrice = (v) => v == null ? '' : `${v.toFixed(2)} €`.replace('.', ',');

// Self-contained, searchable HTML page. Products are inlined as JSON so
// filtering/sorting runs entirely in the browser — works offline.
function renderHtml(payload, outPath) {
  const all = payload.products || [];
  // Skip products explicitly marked inaccessible (untouched products are kept).
  const products = all.filter((p) => p.accessible !== false);
  const hiddenCount = all.length - products.length;
  const brands = new Set(products.map((p) => p.brand).filter(Boolean));
  const prices = products.map((p) => p.price).filter((v) => v != null);
  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;
  const hiddenNote = hiddenCount ? ` · <strong>${hiddenCount}</strong> no disponibles ocultos` : '';
  // Human date for the header ("12 jul 2026, 23:16"); raw ISO kept in a title tooltip.
  const updatedAt = new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid',
  }).format(new Date(payload.scrapedAt));
  // Tag each product with an inferred type so the page can group by category
  // (the same heuristic the AI report uses); uncategorized → "Otros".
  const tagged = products.map((p) => ({ ...p, category: inferCategory(p.name) || 'Otros' }));
  // Escape `<` so a stray `</script>` in product names can't close the tag.
  const dataJson = JSON.stringify(tagged).replace(/</g, '\\u003c');

  fs.writeFileSync(outPath, `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Carrefour · ${products.length} ofertas</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #f6f7fb; --card: #fff; --text: #1a1a1a; --muted: #6b7280;
    --accent: #004e9f; --price: #c8102e;
    --shadow: 0 1px 2px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.04);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
  header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #e5e7eb; padding: 14px 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  header h1 { margin: 0; font-size: 18px; color: var(--accent); }
  header .meta { color: var(--muted); font-size: 13px; }
  .controls { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .controls input, .controls select { border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 10px; font-size: 13px; background: #fff; }
  .controls input:focus, .controls select:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
  #count { color: var(--muted); font-size: 13px; }
  main { padding: 16px 24px 48px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .card { background: var(--card); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; display: flex; flex-direction: column; text-decoration: none; color: inherit; transition: transform .12s, box-shadow .12s; position: relative; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(15,23,42,.10); }
  .card .imgwrap { aspect-ratio: 1 / 1; background: #fafafa; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
  .card img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
  .badge { position: absolute; left: 8px; top: 8px; font-size: 11px; font-weight: 600; color: #fff; padding: 4px 8px; border-radius: 999px; background: #A63793; max-width: calc(100% - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .body { padding: 10px 12px; display: flex; flex-direction: column; flex: 1; }
  .card .brand { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
  .card .name { font-size: 13px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(13px * 1.35 * 3); margin-bottom: 8px; }
  .card .price { font-weight: 700; font-size: 17px; color: var(--price); margin-top: auto; }
  .card .ppu { color: var(--muted); font-size: 12px; }
  .controls label.check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); cursor: pointer; user-select: none; }
  .group-title { display: flex; align-items: center; gap: 8px; width: 100%; margin: 20px 0 12px; padding: 0 0 6px; border: 0; border-bottom: 1px solid #e5e7eb; background: none; font: inherit; font-size: 15px; font-weight: 700; color: var(--accent); text-align: left; cursor: pointer; }
  .group:first-child .group-title { margin-top: 0; }
  .group-title .n { color: var(--muted); font-weight: 400; font-size: 13px; }
  .group-title .caret { display: inline-block; font-size: 11px; transition: transform .15s; }
  .group:not(.collapsed) .group-title .caret { transform: rotate(90deg); }
  .group.collapsed .grid { display: none; }
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
  footer { padding: 24px; text-align: center; color: var(--muted); font-size: 12px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Carrefour · ofertas</h1>
  <span class="meta">${products.length} productos · ${brands.size} marcas · ${fmtPrice(priceMin)} – ${fmtPrice(priceMax)}${hiddenNote} · <span title="${escapeHtml(payload.scrapedAt)}">Actualizado ${escapeHtml(updatedAt)}</span></span>
  <div class="controls">
    <input id="q" type="search" placeholder="Buscar producto, marca…" autocomplete="off">
    <select id="brand"><option value="">Todas las marcas</option></select>
    <select id="promo"><option value="">Todas las promociones</option></select>
    <select id="sort">
      <option value="nameAsc">Nombre A–Z</option>
      <option value="default">Orden original</option>
      <option value="priceAsc">Precio: menor a mayor</option>
      <option value="priceDesc">Precio: mayor a menor</option>
    </select>
    <label class="check"><input id="group" type="checkbox" checked> Agrupar por tipo</label>
    <span id="count"></span>
  </div>
</header>
<main>
  <div id="grid" class="grid"></div>
  <div id="empty" class="empty" hidden>Sin resultados</div>
</main>
<footer>
  Datos obtenidos de
  <a href="${escapeHtml(payload.sourceUrl)}" target="_blank" rel="noopener">carrefour.es</a>
</footer>
<script id="data" type="application/json">${dataJson}</script>
<script>
  const PRODUCTS = JSON.parse(document.getElementById('data').textContent);
  const $ = (id) => document.getElementById(id);
  const grid = $('grid'), countEl = $('count'), emptyEl = $('empty');
  const collapsed = new Set();  // product types the user has collapsed (kept across re-renders)
  const qEl = $('q'), brandEl = $('brand'), promoEl = $('promo'), sortEl = $('sort'), groupEl = $('group');

  const uniq = (key) => [...new Set(PRODUCTS
      .map(p => key === 'promo' ? p.promo?.title : p[key])
      .filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  for (const [key, sel] of [['brand', brandEl], ['promo', promoEl]]) {
    for (const v of uniq(key)) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    }
  }

  const fmt = (v) => v == null ? '' : v.toFixed(2).replace('.', ',') + ' €';
  const norm = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');

  function renderCard(p) {
    const promoTitle = p.promo?.title;
    const promoColor = p.promo?.color || '#A63793';
    return \`<a class="card" href="\${p.url || '#'}" target="_blank" rel="noopener">
      <div class="imgwrap">
        \${p.imageUrl ? \`<img loading="lazy" src="\${p.imageUrl}" alt="">\` : ''}
        \${promoTitle ? \`<span class="badge" style="background:\${promoColor}">\${promoTitle}</span>\` : ''}
      </div>
      <div class="body">
        <div class="brand">\${p.brand || ''}</div>
        <div class="name">\${p.name || ''}</div>
        <div class="price">\${fmt(p.price)}</div>
        \${p.pricePerUnitText ? \`<div class="ppu">\${p.pricePerUnitText}</div>\` : ''}
      </div>
    </a>\`;
  }

  function apply() {
    const q = norm(qEl.value.trim());
    const brand = brandEl.value, promo = promoEl.value, sort = sortEl.value;
    let rows = PRODUCTS.filter(p => {
      if (brand && p.brand !== brand) return false;
      if (promo && p.promo?.title !== promo) return false;
      if (q && !(norm(p.name) + ' ' + norm(p.brand)).includes(q)) return false;
      return true;
    });
    if (sort === 'priceAsc') rows.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    else if (sort === 'priceDesc') rows.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
    else if (sort === 'nameAsc') rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));
    if (groupEl.checked) {
      // Group by product type; keep the current sort within each group, order
      // the headings alphabetically with "Otros" last, and make each heading a
      // toggle that collapses/expands its cards (state in the collapsed set).
      grid.className = '';
      const groups = new Map();
      for (const p of rows) {
        const k = p.category || 'Otros';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
      }
      const names = [...groups.keys()].sort((a, b) =>
        a === 'Otros' ? 1 : b === 'Otros' ? -1 : a.localeCompare(b, 'es'));
      grid.innerHTML = names.map((name) => {
        const items = groups.get(name);
        const col = collapsed.has(name);
        return \`<section class="group\${col ? ' collapsed' : ''}" data-cat="\${name}">\`
          + \`<button class="group-title" type="button" aria-expanded="\${!col}">\`
          + \`<span class="caret">▸</span><span>\${name}</span> <span class="n">(\${items.length})</span></button>\`
          + \`<div class="grid">\${items.map(renderCard).join('')}</div>\`
          + \`</section>\`;
      }).join('');
    } else {
      grid.className = 'grid';
      grid.innerHTML = rows.map(renderCard).join('');
    }
    emptyEl.hidden = rows.length > 0;
    countEl.textContent = \`\${rows.length} / \${PRODUCTS.length}\`;
  }

  qEl.addEventListener('input', apply);
  for (const el of [brandEl, promoEl, sortEl, groupEl]) el.addEventListener('change', apply);
  // Toggle a group open/closed when its heading is clicked.
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.group-title');
    if (!btn) return;
    const section = btn.closest('.group');
    const cat = section.dataset.cat;
    const col = !collapsed.has(cat);
    if (col) collapsed.add(cat); else collapsed.delete(cat);
    section.classList.toggle('collapsed', col);
    btn.setAttribute('aria-expanded', String(!col));
  });
  apply();
</script>
</body>
</html>`);
  return { total: products.length, sizeKb: Math.round(fs.statSync(outPath).size / 1024) };
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
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    const p = r.promo || {};
    lines.push([
      r.productId, r.name, r.brand, r.price, r.priceText,
      r.originalPrice, r.originalPriceText,
      r.pricePerUnit, r.pricePerUnitText,
      r.catalog, r.documentType, r.discountText,
      p.title, p.validUntil, p.description, p.campaignUrl,
      r.url, r.imageUrl, r.pageNumber, r.positionOnPage,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

// Walks one listing page-by-page, feeding products to `ingest`. Pages within a
// campaign are walked sequentially — same shape as a real shopper paginating.
async function scrapeListing(page, baseUrl, ingest, workerId = '') {
  const tag = workerId ? `[w${workerId}]` : '';
  const campaign = baseUrl.split('/')[4] || baseUrl;
  console.log(`\n${tag}=== ${campaign}`);
  await loadPage(page, buildPageUrl(baseUrl, 0));
  const meta = await readPageMeta(page);
  const pageSize = meta.cardCount || PAGE_SIZE;
  const total = meta.total || (meta.cardCount * 27);
  const totalPages = Math.ceil(total / pageSize);
  console.log(`${tag}  ${campaign}: ${total} products / ${totalPages} pages`);

  const firstPage = await extractProducts(page);
  ingest(firstPage, 1, baseUrl);
  let collected = firstPage.length;

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
    try {
      await loadPage(page, buildPageUrl(baseUrl, (pageNumber - 1) * pageSize));
      const products = await extractProducts(page);
      ingest(products, pageNumber, baseUrl);
      collected += products.length;
      if (products.length === 0) {
        console.log(`${tag}  ${campaign}: empty page ${pageNumber} — stopping`);
        break;
      }
      await politeGap();
    } catch (e) {
      console.error(`${tag}  ${campaign} page ${pageNumber} failed: ${e.message}`);
    }
  }
  console.log(`${tag}  ${campaign}: done (${collected} cards visited)`);
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
    for (const a of document.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(a.getAttribute('href') || '', origin).toString(); } catch { continue; }
      if (!url.startsWith(origin + '/supermercado/')) continue;
      if (!/\/[^/]+\/[^/?#]+\/g(?:[?#].*)?$/.test(url)) continue;
      seen.add(url);
    }
    return [...seen];
  }, ORIGIN);
  console.log(`  found ${links.length} campaign URLs`);
  for (const u of links) console.log('    ' + u);
  return links;
}

// Each worker gets its own browser context — sharing one causes Carrefour's
// Vue app and the shared HTTP cache to render overlapping product sets across
// tabs, losing ~35% of unique products. Separate contexts (same Chrome, same
// IP) keep navigation deterministic.
async function newWorkerPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'media' || t === 'font' || t === 'image') return req.abort();
    req.continue();
  });
  await page.setCookie(
    { name: 'postalCode',     value: POSTAL_CODE, domain: '.carrefour.es', path: '/' },
    { name: 'userPostalCode', value: POSTAL_CODE, domain: '.carrefour.es', path: '/' },
  );
  return { ctx, page };
}

// Carrefour's promo grids list the national catalog, but each shopper is pinned
// to one store whose assortment is a subset — a product in the grid but not in
// the store redirects to its category (a dead link) when opened. Reproduce the
// target store with the `salepoint` cookie, then HEAD each product URL following
// redirects: a live product lands on a /p URL, a store-missing one on /c (or the
// homepage). Mark the misses accessible:false so renderHtml and buildAiPayload
// drop them (they already filter on that flag). Only a definitive 200-not-on-/p
// hides a product; a non-200 or a network error leaves it visible — we never
// hide a real offer on an inconclusive check (rate limiting just hides fewer).
async function verifyAccessibility(browser, products, { concurrency = 10, chunkSize = 200 } = {}) {
  const targets = products.filter((p) => p.url);
  if (!targets.length) return { checked: 0, dead: 0 };
  const { ctx, page } = await newWorkerPage(browser);
  let dead = 0;
  try {
    await page.setCookie({ name: 'salepoint', value: SALEPOINT, domain: '.carrefour.es', path: '/' });
    // fetch() needs a same-origin document for the store cookies to apply.
    await page.goto(`${ORIGIN}/supermercado`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    for (let start = 0; start < targets.length; start += chunkSize) {
      const slice = targets.slice(start, start + chunkSize);
      const deadIdx = await page.evaluate(async (urls, conc) => {
        const check = async (u) => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 10_000);
          try {
            const r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: ac.signal });
            if (r.status !== 200) return null;                              // inconclusive
            return new URL(r.url).pathname.endsWith('/p') ? false : true;   // false=live, true=dead
          } catch { return null; } finally { clearTimeout(timer); }
        };
        const hits = [];
        let i = 0;
        const worker = async () => {
          while (i < urls.length) { const idx = i++; if ((await check(urls[idx])) === true) hits.push(idx); }
        };
        await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, worker));
        return hits;
      }, slice.map((p) => p.url), concurrency);
      for (const idx of deadIdx) { slice[idx].accessible = false; dead++; }
      console.log(`  verified ${Math.min(start + chunkSize, targets.length)}/${targets.length} · ${dead} not in store`);
    }
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
  return { checked: targets.length, dead };
}

// Drain a queue of campaign listing URLs across a pool of worker pages, feeding
// every product to `ingest` and pushing each campaign's summary to `summaries`.
// Each worker gets its own context (see newWorkerPage) so their product sets
// don't overlap. Failures are recorded per-campaign, never abort the pool.
async function scrapeCampaigns(browser, urls, ingest, summaries, workers, label = '') {
  if (!urls.length) return;
  const effectiveWorkers = Math.min(workers, urls.length);
  const queue = urls.slice();
  if (effectiveWorkers > 1) console.log(`\nStarting ${effectiveWorkers} parallel workers for ${urls.length} ${label}campaign(s)`);
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: effectiveWorkers }, async (_, id) => {
    const { ctx, page } = await newWorkerPage(browser);
    // Stagger so all workers don't pound Cloudflare at the same instant.
    await sleep(id * 1500);
    try {
      while (queue.length > 0) {
        const u = queue.shift();
        if (!u) break;
        const tag = effectiveWorkers > 1 ? id + 1 : '';
        try {
          summaries.push(await scrapeListing(page, u, ingest, tag));
        } catch (e) {
          console.error(`${tag ? `[w${tag}] ` : ''}campaign ${u} failed: ${e.message}`);
          summaries.push({ url: u, error: e.message });
        }
        await politeGap();
      }
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  }));
  if (effectiveWorkers > 1) {
    console.log(`Parallel ${label}scrape finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
}

// The offers hub only lists the 7 category `/g` campaigns + 3x2, so headline
// promos ("50% que vuelve", "super precio", "2ª unidad", "30%", …) are missed —
// they live on `…/s` pages the hub never links. But every product carries a
// promo badge that DOES link its campaign, so we harvest those `/s` URLs from
// the products already scraped and walk the ones not yet covered. Skip `3x2`
// (its `/g` campaign is comprehensive) and `envio-gratis` (a shipping perk, not
// a discount). Same `/s` page structure as `/g`, so scrapeListing handles them.
function discoverPromoCampaignsFromProducts(products, alreadyScraped = []) {
  const done = new Set(alreadyScraped);
  const skipSlugs = new Set(['3x2', 'envio-gratis']);
  const found = new Set();
  for (const p of products) {
    const cu = p.promo?.campaignUrl;
    if (!cu || !/\/s$/.test(cu) || done.has(cu) || found.has(cu)) continue;
    let slug;
    try { slug = new URL(cu).pathname.split('/')[2]; } catch { continue; }
    if (skipSlugs.has(slug)) continue;
    found.add(cu);
  }
  return [...found];
}

// Only run the scrape when invoked directly; when required as a module
// (e.g. to regenerate the HTML from products.json) just expose the renderer.
if (require.main === module) (async () => {
  const rawArgs = process.argv.slice(2);
  const force = rawArgs.includes('--force') || process.env.SCRAPE_FORCE === '1';
  const positional = rawArgs.filter((a) => !a.startsWith('--'));
  const baseUrl = positional[0] || DEFAULT_URL;
  const outBase = positional[1] || 'products';
  // Outputs — and the same-day cache — live in OUT_DIR: the mounted volume in
  // Docker (Dockerfile sets ENV OUT_DIR=/output), or cwd for a direct run.
  const outDir = process.env.OUT_DIR || process.cwd();
  const outPath = (ext) => path.resolve(outDir, `${outBase}.${ext}`);

  // The offers don't change within a day, so a second run today is wasted work
  // (and risks rate limits). If we already have today's scrape, reuse it as the
  // cache and stop. --force / SCRAPE_FORCE=1 overrides.
  if (!force && fs.existsSync(outPath('json'))) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath('json'), 'utf8'));
      const prevDay = String(prev.scrapedAt || '').slice(0, 10);
      if (prevDay === new Date().toISOString().slice(0, 10)) {
        const n = prev.collected ?? prev.products?.length ?? '?';
        console.log(`Carrefour scraper: ya scrapeado hoy (${prev.scrapedAt}, ${n} productos).`);
        console.log(`Usando el resultado en cache -> ${outPath('json')}`);
        console.log(`(usa --force o SCRAPE_FORCE=1 para volver a scrapear)`);
        return;
      }
    } catch { /* unreadable / pre-cache file — fall through and scrape */ }
  }

  const isHub = /\/c(?:[?#].*)?$/.test(baseUrl);
  const requestedWorkers = parseInt(process.env.SCRAPE_WORKERS, 10);
  const workers = isHub
    ? Math.max(1, Number.isFinite(requestedWorkers) ? requestedWorkers : DEFAULT_WORKERS)
    : 1;

  console.log('Carrefour scraper');
  console.log('  base URL:', baseUrl);
  console.log('  mode:    ', isHub ? `hub (walk every /g campaign, ${workers} workers)` : 'single listing');
  console.log('  out:     ', `${outDir}/${outBase}.{json,csv,html,ai.json,report.md}`);
  console.log();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    // Discover campaign URLs (hub mode) using a throwaway worker page.
    let urls = [baseUrl];
    if (isHub) {
      const { ctx, page } = await newWorkerPage(browser);
      try {
        urls = await discoverCampaignUrls(page, baseUrl);
        if (urls.length === 0) throw new Error('No /g campaign URLs found on hub — is this really a hub page?');
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    }

    // Collect products. Map preserves insertion order, so it doubles as the
    // ordered output list. Duplicates across campaigns just append to
    // `sourceUrls` on the first-seen entry.
    const seen = new Map();
    const ingest = (products, pageNumber, sourceUrl) => {
      for (const p of products) {
        if (!p.name && !p.url) continue; // banner / sponsored slot
        const key = p.productId || p.url || `${sourceUrl}#${pageNumber}:${p.position}:${p.name}`;
        const existing = seen.get(key);
        if (existing) {
          existing.sourceUrls ??= [existing.sourceUrl];
          if (!existing.sourceUrls.includes(sourceUrl)) existing.sourceUrls.push(sourceUrl);
          continue;
        }
        const { position, ...rest } = p;
        seen.set(key, { ...rest, pageNumber, positionOnPage: position, sourceUrl });
      }
    };

    // Pass 1 — the campaigns discovered on the offers hub (`/g`, single listing).
    const summaries = [];
    await scrapeCampaigns(browser, urls, ingest, summaries, workers);

    // Pass 2 (hub mode) — headline promos reachable only via product badges
    // (`…/s`): "50% que vuelve", "super precio", "2ª unidad", etc. Discover them
    // from the products just scraped and walk the ones the hub didn't list.
    if (isHub) {
      const promoUrls = discoverPromoCampaignsFromProducts([...seen.values()], urls);
      if (promoUrls.length) {
        console.log(`\nDiscovered ${promoUrls.length} promo campaign(s) from product badges (…/s)`);
        await scrapeCampaigns(browser, promoUrls, ingest, summaries, workers, 'promo ');
      }
    }

    // Persist results
    const ordered = [...seen.values()];

    // Grids list the national catalog; some products aren't in the target store
    // and would open as dead links (redirect to their category). Flag those so
    // the outputs drop them. products.json keeps every product (with the flag)
    // as the raw record; the presentation/analysis outputs hide accessible:false.
    console.log('\nVerifying product links against store…');
    const verif = await verifyAccessibility(browser, ordered);
    console.log(`✓ verified ${verif.checked} links · ${verif.dead} not available in store (hidden)`);

    const reportedTotal = summaries.reduce((s, c) => s + (c.total || 0), 0);
    const jsonPath = outPath('json');
    const csvPath = outPath('csv');
    const htmlPath = outPath('html');
    const aiPath = outPath('ai.json');
    const reportPath = outPath('report.md');
    const payload = {
      scrapedAt: new Date().toISOString(),
      sourceUrl: baseUrl,
      hubMode: isHub,
      campaigns: summaries,
      reportedTotal,
      collected: ordered.length,
      products: ordered,
    };
    // products.json = complete raw record (dead links flagged). CSV/HTML/AI are
    // consumer outputs, so they drop the store-unavailable products.
    const visible = ordered.filter((p) => p.accessible !== false);
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(csvPath, toCsv(visible));
    const htmlInfo = renderHtml(payload, htmlPath);

    // AI-friendly artifacts: a compact, enriched, denormalized JSON for LLMs
    // and a deterministic Markdown digest. Built from a shallow copy carrying
    // postalCode so products.json itself stays unchanged.
    const ai = buildAiPayload({ ...payload, postalCode: POSTAL_CODE });
    fs.writeFileSync(aiPath, JSON.stringify(ai));
    fs.writeFileSync(reportPath, renderReport(ai));
    const kb = (p) => Math.round(fs.statSync(p).size / 1024);

    console.log();
    console.log(`✓ collected ${ordered.length} unique products across ${summaries.length} campaign(s) (sum of campaign totals: ${reportedTotal})`);
    console.log(`  ${visible.length} available in store · ${verif.dead} hidden (not in store / dead link)`);
    console.log(`✓ saved JSON   → ${jsonPath}`);
    console.log(`✓ saved CSV    → ${csvPath}`);
    console.log(`✓ saved HTML   → ${htmlPath} (${htmlInfo.total} products, ${htmlInfo.sizeKb} KB)`);
    console.log(`✓ saved AI     → ${aiPath} (${ai.products.length} products, ${ai.promos.length} promos, ${kb(aiPath)} KB)`);
    console.log(`✓ saved report → ${reportPath} (${kb(reportPath)} KB)`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});

module.exports = { renderHtml, verifyAccessibility };
