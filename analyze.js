// analyze.js — turn a raw scrape payload into AI-friendly artifacts.
//
// The raw products.json is faithful but verbose: redundant text fields, the
// same promo boilerplate repeated on every product, and no computed signals
// (discount %, comparable unit price, category). That bloats token count and
// makes an LLM do arithmetic it shouldn't have to.
//
// This module derives two things from the raw payload:
//   buildAiPayload(payload) → compact, denormalized, enriched JSON for an LLM
//   renderReport(ai)        → deterministic Markdown digest of the offers
//
// Both are pure functions of the raw payload, so this file also runs standalone
// against an existing products.json without re-scraping:
//   node analyze.js [products.json] [outBase]
//     → writes <outBase>.ai.json and <outBase>.report.md
//
// SCHEMA = 'carrefour-ai/1'. effectiveDiscountPct is an ESTIMATE; cashback
// coupons ("que vuelve" / "en Cupón") are deferred (returned on a later
// purchase), flagged with deferred:true. See PROMO_RULES.

const SCHEMA = 'carrefour-ai/1';

// ---------------------------------------------------------------------------
// Promo classification. Carrefour shows ~13 distinct badge titles; each maps to
// a discount semantics. effPct is the effective immediate discount when the
// offer's basis is met (e.g. "2ª unidad -50%" = pay 1.5× for 2 = 25% off the
// pair). Cashback coupons are marked deferred — the value comes back later, so
// it is NOT an immediate price cut. Titles not in the table fall through to the
// regex heuristics in classifyPromo(), so future badges still classify.
const PROMO_RULES = {
  '2ª unidad -50%':   { type: 'second-unit',     effPct: 25, basis: 'al comprar 2 uds' },
  '2ª unidad -70%':   { type: 'second-unit',     effPct: 35, basis: 'al comprar 2 uds' },
  '3x2':              { type: 'multibuy',        effPct: 33, basis: 'al comprar 3 uds' },
  '2x1':              { type: 'multibuy',        effPct: 50, basis: 'al comprar 2 uds' },
  '50% que vuelve':   { type: 'cashback-coupon', effPct: 50, basis: 'cupón próxima compra', deferred: true },
  '50% en Cupón':     { type: 'cashback-coupon', effPct: 50, basis: 'cupón', deferred: true },
  '20% en Cupón':     { type: 'cashback-coupon', effPct: 20, basis: 'cupón', deferred: true },
  '-10% Acumulación': { type: 'stacking',        effPct: 10, basis: 'acumulación en cupón', deferred: true },
  'XXL Ahorro':       { type: 'bulk' },
  'Precio Imbatible': { type: 'price-flag' },
  'Super Precio':     { type: 'price-flag' },
  'Envío Gratis':     { type: 'shipping' },
  'Lote':             { type: 'bundle' },
  'Air Fryer':        { type: 'themed' },
};

function classifyPromo(title) {
  if (!title) return null;
  const exact = PROMO_RULES[title];
  if (exact) return { ...exact };
  const t = title.toLowerCase();
  let m;
  // "2ª unidad -70%" style → effective pct is half the second-unit discount.
  if ((m = t.match(/2[ªa].*?unidad.*?-?(\d+)\s*%/))) {
    return { type: 'second-unit', effPct: Math.round(+m[1] / 2), basis: 'al comprar 2 uds' };
  }
  // "NxM" multibuy → effective pct = (N-M)/N.
  if ((m = t.match(/(\d+)\s*x\s*(\d+)/))) {
    const [n, k] = [+m[1], +m[2]];
    if (n > k) return { type: 'multibuy', effPct: Math.round(((n - k) / n) * 100), basis: `al comprar ${n} uds` };
  }
  // Coupon / cashback wording.
  if (/cup[oó]n|vuelve/.test(t)) {
    const pct = (m = t.match(/(\d+)\s*%/)) ? +m[1] : null;
    return { type: 'cashback-coupon', effPct: pct, basis: 'cupón', deferred: true };
  }
  // Bare "-25%" immediate.
  if ((m = t.match(/-\s*(\d+)\s*%/))) return { type: 'percent-off', effPct: +m[1] };
  return { type: 'other' };
}

// ---------------------------------------------------------------------------
// Coarse category inference from the product name. catalog/documentType are
// always "food", so they're useless for grouping — but the name is reliable.
// First match wins, so order specific phrases before the words they contain
// (e.g. "tomate frito" as a sauce before "tomate" as a vegetable).
const CATEGORY_RULES = [
  // Mascotas and Bebé go first: pet food ("pienso de pollo para perro") and baby
  // formula ("leche infantil") contain food words that would otherwise land them
  // in Carne/Lácteos and dodge a category filter for those who don't buy them.
  ['Mascotas',           ['pienso', 'para perro', 'para perros', 'para gato', 'para gatos', ' perros', ' gatos', 'mascota', 'felix', 'whiskas', 'friskies', 'pedigree', 'purina', 'dentastix']],
  ['Bebé',               ['infantil', 'papilla', 'potito', 'pañal', 'panal', 'toallitas bebe', 'bebe ', 'blemil', 'almiron', 'nan optipro', 'nutriben', 'blevit', 'puleva peques']],
  ['Charcutería',        ['jamon', 'chorizo', 'salchichon', 'fuet', 'embuchado', 'mortadela', 'salami', 'embutido', 'fiambre', 'pate', 'sobrasada', 'cecina', 'lacon', 'chopped']],
  ['Lácteos y huevos',   ['leche', 'yogur', 'queso', 'mantequilla', 'margarina', ' nata', 'kefir', 'cuajada', 'natillas', 'mascarpone', 'requeson', 'huevo', 'flan']],
  ['Pescado y marisco',  ['atun', 'merluza', 'salmon', 'bacalao', 'gamba', 'langostino', 'marisco', 'sardina', 'anchoa', 'mejillon', 'pulpo', 'calamar', 'surimi', 'palitos de mar', 'pescado', 'boqueron', 'rape', 'dorada', 'lubina']],
  ['Carne y aves',       ['pollo', 'cerdo', 'ternera', 'vacuno', 'lomo', 'chuleta', 'salchicha', 'hamburguesa', 'bacon', 'panceta', 'pavo', 'cordero', 'costilla', 'solomillo', 'carne', 'magro', 'butifarra']],
  ['Frutas y verduras',  ['manzana', 'platano', 'naranja', 'tomate', 'lechuga', 'patata', 'cebolla', 'zanahoria', 'pimiento', 'fresa', 'verdura', 'ensalada', 'pepino', 'calabac', 'brocoli', 'champiñon', 'champinon', 'aguacate', 'mandarina', 'limon', 'pera ', 'uva', 'sandia', 'melon', 'kiwi', 'fruta']],
  ['Congelados',         ['congelad', 'helado', 'varitas', 'nuggets', 'croqueta']],
  ['Panadería y bollería', ['pan ', 'pan d', 'bolleria', 'croissant', 'magdalena', 'galleta', 'bizcocho', 'tostada', 'donut', 'napolitana', 'palmera', 'gofre', 'reposteria', 'masa']],
  ['Cereales y dulces',  ['cereal', 'mermelada', ' miel', 'cacao', 'colacao', 'nesquik', 'chocolate', 'bombon', 'turron', 'caramelo', 'chicle', 'gominola', 'golosina']],
  ['Aperitivos y snacks', ['patatas fritas', 'snack', 'aperitivo', 'frutos secos', 'almendra', 'nuez', 'nueces', 'cacahuete', 'pistacho', 'aceituna', 'nachos', 'tortitas']],
  ['Pasta, arroz y legumbres', ['pasta', 'espagueti', 'macarr', 'arroz', 'lenteja', 'garbanzo', 'alubia', 'fideos', 'cuscus', 'quinoa', 'legumbre', 'noodles']],
  ['Aceite, salsas y condimentos', ['aceite', 'vinagre', 'salsa', 'ketchup', 'mayonesa', 'mostaza', 'tomate frito', 'sofrito', 'caldo', 'especia', 'pimienta', 'oregano', ' sal ']],
  ['Conservas',          ['conserva', 'esparrago', ' maiz', 'guisante', 'encurtido', 'pepinillo', 'lata de']],
  // 'cafe ' keeps a trailing space so it matches "café molido" but NOT
  // "cafeína" (which would steal caffeinated colas from Bebidas).
  ['Café e infusiones',  ['cafe ', ' te ', 'infusion', 'capsula', 'nescafe', 'manzanilla', 'poleo', 'descafeinado']],
  ['Bebidas',            ['agua', 'refresco', 'cola', 'cerveza', 'vino', 'zumo', 'tonica', 'bitter', 'sidra', 'vermut', 'ginebra', ' ron ', 'whisky', 'vodka', 'licor', 'cava', 'champan', 'mosto', 'isotonic', 'energetica', 'monster', 'aquarius', 'nestea', 'bebida']],
  ['Cuidado personal',   ['gel de', 'champu', 'desodorante', 'colonia', 'crema', 'dentifrico', 'pasta de dientes', 'cepillo', 'maquillaje', 'compresa', 'tampon', 'papel higienico', 'jabon', 'cuchilla', 'afeitar', 'higiene', 'corporal', 'facial']],
  ['Limpieza y hogar',   ['detergente', 'suavizante', 'lejia', 'limpiador', 'friegasuelos', 'lavavajillas', 'bayeta', 'estropajo', 'servilleta', 'bolsa de basura', 'papel de cocina', 'ambientador', 'insecticida', 'fregasuelos', 'limpia']],
  ['Platos preparados',  ['pizza', 'preparado', 'precocinad', 'lasaña', 'lasana']],
];

const stripAccents = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function inferCategory(name) {
  const n = ' ' + stripAccents(name) + ' ';
  for (const [cat, kws] of CATEGORY_RULES) {
    for (const kw of kws) if (n.includes(stripAccents(kw))) return cat;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small parsers.
const round2 = (v) => v == null ? null : Math.round(v * 100) / 100;

// "3,47 €/l" → "l"; "1,20 €/lavado" → "lavado". Returns null if absent.
function parseUnit(ppuText) {
  const m = (ppuText || '').match(/€\s*\/\s*([a-zA-Z]+)/);
  return m ? m[1].toLowerCase() : null;
}

// dd/mm/yyyy → yyyy-mm-dd.
const toIso = (d) => {
  const m = (d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

// Pull the offer's validity window from the promo. validUntil holds the end;
// the description usually carries the full "del DD/MM/YYYY al DD/MM/YYYY" range.
function parseValidity(promo) {
  if (!promo) return {};
  const end = toIso(promo.validUntil);
  const range = (promo.description || '').match(/del\s+(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})/i);
  const validUntil = end || (range ? toIso(range[2]) : null);
  let validFrom = range ? toIso(range[1]) : null;
  // Cashback descriptions carry TWO ranges (offer window, then coupon-usage
  // window); the regex grabs the first. If that start lands after the badge's
  // end date it's the coupon window, not the offer — drop it (ISO sorts lexically).
  if (validFrom && validUntil && validFrom > validUntil) validFrom = null;
  return { validFrom, validUntil };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// ---------------------------------------------------------------------------
// buildAiPayload: compact, denormalized, enriched view of the raw payload.
function buildAiPayload(payload) {
  const raw = (payload.products || []).filter((p) => p.accessible !== false && (p.name || p.url));

  // Dedupe promos into a lookup table keyed by title (titles are stable and
  // carry all the semantics we surface). Products reference a promo by index.
  const promoIndex = new Map(); // title -> id
  const promos = [];
  const promoIdFor = (promo) => {
    if (!promo?.title) return null;
    if (promoIndex.has(promo.title)) return promoIndex.get(promo.title);
    const cls = classifyPromo(promo.title) || {};
    const { validFrom, validUntil } = parseValidity(promo);
    const id = promos.length;
    promos.push({
      id,
      title: promo.title,
      type: cls.type || 'other',
      ...(cls.effPct != null ? { effectiveDiscountPct: cls.effPct } : {}),
      ...(cls.deferred ? { deferred: true } : {}),
      ...(cls.basis ? { basis: cls.basis } : {}),
      ...(validFrom ? { validFrom } : {}),
      ...(validUntil ? { validUntil } : {}),
    });
    promoIndex.set(promo.title, id);
    return id;
  };

  const products = raw.map((p) => {
    const promoId = promoIdFor(p.promo);
    const unit = parseUnit(p.pricePerUnitText);
    const discountPct = (p.originalPrice && p.price != null && p.originalPrice > p.price)
      ? Math.round((1 - p.price / p.originalPrice) * 100)
      : null;
    const category = inferCategory(p.name);
    return {
      id: p.productId || p.url,
      name: p.name,
      ...(p.brand ? { brand: p.brand } : {}),
      price: round2(p.price),
      ...(p.originalPrice != null ? { wasPrice: round2(p.originalPrice) } : {}),
      ...(discountPct != null ? { discountPct } : {}),
      ...(unit ? { unit } : {}),
      ...(p.pricePerUnit != null ? { unitPrice: round2(p.pricePerUnit) } : {}),
      ...(category ? { category } : {}),
      ...(promoId != null ? { promo: promoId } : {}),
      url: p.url,
    };
  });

  // Aggregates — give the LLM the overview for free instead of making it
  // recompute over 1.6k rows.
  const prices = products.map((p) => p.price).filter((v) => v != null);
  const brandCounts = tally(products.map((p) => p.brand));
  const catCounts = tally(products.map((p) => p.category));
  const promoTypeCounts = tally(products.map((p) => p.promo != null ? promos[p.promo].type : null));

  // Per-promo product counts. Reporting a rate per *type* is misleading when a
  // type spans rates (e.g. "2ª unidad -50%" and "-70%" are both second-unit),
  // so we break down by the individual promo and attach its own count.
  const promoCounts = new Array(promos.length).fill(0);
  for (const p of products) if (p.promo != null) promoCounts[p.promo]++;
  const promoBreakdown = promos
    .map((pr) => ({ ...pr, count: promoCounts[pr.id] }))
    .sort((a, b) => b.count - a.count);

  // Cheapest per comparable unit (kg / l / ud / lavado …).
  const byUnit = {};
  for (const p of products) {
    if (!p.unit || p.unitPrice == null) continue;
    (byUnit[p.unit] ??= []).push(p);
  }
  const cheapestPerUnit = {};
  for (const [u, arr] of Object.entries(byUnit)) {
    cheapestPerUnit[u] = arr.slice().sort((a, b) => a.unitPrice - b.unitPrice).slice(0, 8)
      .map((p) => ({ name: p.name, ...(p.brand ? { brand: p.brand } : {}), unitPrice: p.unitPrice, unit: u, price: p.price }));
  }

  const topImmediateDiscounts = products.filter((p) => p.discountPct != null)
    .sort((a, b) => b.discountPct - a.discountPct).slice(0, 20)
    .map((p) => ({ name: p.name, ...(p.brand ? { brand: p.brand } : {}), price: p.price, wasPrice: p.wasPrice, discountPct: p.discountPct }));

  const summary = {
    productCount: products.length,
    brandCount: brandCounts.length,
    categoryCount: catCounts.length,
    campaignCount: (payload.campaigns || []).length,
    price: {
      min: prices.length ? round2(Math.min(...prices)) : null,
      max: prices.length ? round2(Math.max(...prices)) : null,
      median: round2(median(prices)),
      mean: prices.length ? round2(prices.reduce((s, v) => s + v, 0) / prices.length) : null,
    },
    withPromo: products.filter((p) => p.promo != null).length,
    withImmediateDiscount: products.filter((p) => p.discountPct != null).length,
    uncategorized: products.filter((p) => !p.category).length,
    promoTypes: Object.fromEntries(promoTypeCounts),
    promoBreakdown,
    categories: Object.fromEntries(catCounts),
    topBrands: brandCounts.slice(0, 25).map(([brand, count]) => ({ brand, count })),
    cheapestPerUnit,
    topImmediateDiscounts,
  };

  return {
    schema: SCHEMA,
    scrapedAt: payload.scrapedAt,
    sourceUrl: payload.sourceUrl,
    currency: 'EUR',
    postalCode: payload.postalCode || '28904',
    notes: [
      'effectiveDiscountPct in promos[] is an estimate of the immediate discount when the offer basis is met (e.g. buying 2 units).',
      'Promos with deferred:true (cashback "que vuelve" / "en Cupón") return value on a later purchase — not an immediate price cut.',
      'unitPrice is Carrefour\'s €/unit (unit field: kg, l, ud, lavado, m) — use it to compare value across pack sizes.',
      'discountPct is an immediate price cut, present only when a strikethrough original price was shown.',
      'category is inferred from the product name (heuristic); uncategorized products have no category field.',
    ],
    promos,
    summary,
    products,
  };
}

function tally(values) {
  const m = new Map();
  for (const v of values) if (v) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// renderReport: deterministic Markdown digest. No LLM — just the headline
// findings a shopper (or an LLM summarizing further) would want up front.
const eur = (v) => v == null ? '—' : `${v.toFixed(2).replace('.', ',')} €`;
const mdEsc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderReport(ai) {
  const s = ai.summary;
  const L = [];
  L.push(`# Carrefour — Análisis de ofertas`);
  L.push('');
  L.push(`_Fuente: ${ai.sourceUrl} · capturado ${ai.scrapedAt} · CP ${ai.postalCode}_`);
  L.push('');

  L.push(`## Resumen`);
  L.push('');
  L.push(`- **Productos:** ${s.productCount}`);
  L.push(`- **Marcas:** ${s.brandCount} · **Categorías:** ${s.categoryCount} · **Campañas:** ${s.campaignCount}`);
  L.push(`- **Precio:** ${eur(s.price.min)} – ${eur(s.price.max)} (mediana ${eur(s.price.median)}, media ${eur(s.price.mean)})`);
  L.push(`- **Con promoción:** ${s.withPromo} · **con descuento inmediato (precio tachado):** ${s.withImmediateDiscount}`);
  if (s.uncategorized) L.push(`- **Sin categorizar:** ${s.uncategorized}`);
  L.push('');

  // Promociones — broken down per individual badge (not per type), so the
  // effective discount shown always matches the products it counts.
  L.push(`## Promociones`);
  L.push('');
  L.push(`| Promoción | Tipo | Productos | Dto. efectivo | Válido hasta | Notas |`);
  L.push(`| --- | --- | ---: | ---: | --- | --- |`);
  for (const p of s.promoBreakdown) {
    const eff = p.effectiveDiscountPct != null ? `${p.effectiveDiscountPct}%` : '—';
    const note = p.deferred ? 'diferido (cupón)' : (p.basis || '');
    L.push(`| ${mdEsc(p.title)} | ${mdEsc(p.type)} | ${p.count} | ${eff} | ${p.validUntil || '—'} | ${mdEsc(note)} |`);
  }
  L.push('');

  // Immediate discounts.
  if (s.topImmediateDiscounts.length) {
    L.push(`## Mayores descuentos inmediatos (precio tachado)`);
    L.push('');
    L.push(`| Producto | Marca | Antes | Ahora | Dto. |`);
    L.push(`| --- | --- | ---: | ---: | ---: |`);
    for (const p of s.topImmediateDiscounts) {
      L.push(`| ${mdEsc(p.name)} | ${mdEsc(p.brand || '')} | ${eur(p.wasPrice)} | ${eur(p.price)} | **−${p.discountPct}%** |`);
    }
    L.push('');
  }

  // Cheapest per unit.
  L.push(`## Precio por unidad más barato`);
  L.push('');
  L.push(`_Comparativa de valor por unidad de medida (incluye productos básicos como sal, azúcar o harina)._`);
  L.push('');
  const unitLabel = { kg: '€/kg', l: '€/l', ud: '€/ud', lavado: '€/lavado', m: '€/m' };
  for (const u of ['kg', 'l', 'ud', 'lavado', 'm']) {
    const arr = s.cheapestPerUnit[u];
    if (!arr?.length) continue;
    L.push(`### ${unitLabel[u] || u} (${u})`);
    L.push('');
    L.push(`| Producto | Marca | ${unitLabel[u] || u} | Precio |`);
    L.push(`| --- | --- | ---: | ---: |`);
    for (const p of arr) {
      L.push(`| ${mdEsc(p.name)} | ${mdEsc(p.brand || '')} | ${p.unitPrice.toFixed(2).replace('.', ',')} | ${eur(p.price)} |`);
    }
    L.push('');
  }

  // Categories.
  const cats = Object.entries(s.categories);
  if (cats.length) {
    L.push(`## Ofertas por categoría`);
    L.push('');
    L.push(`| Categoría | Productos |`);
    L.push(`| --- | ---: |`);
    for (const [cat, count] of cats) L.push(`| ${mdEsc(cat)} | ${count} |`);
    L.push('');
  }

  // Top brands.
  L.push(`## Marcas con más ofertas`);
  L.push('');
  L.push(`| Marca | Productos |`);
  L.push(`| --- | ---: |`);
  for (const { brand, count } of s.topBrands) L.push(`| ${mdEsc(brand)} | ${count} |`);
  L.push('');

  L.push(`---`);
  L.push(`_Descuentos efectivos estimados; los cupones "que vuelve"/"en Cupón" se devuelven en una compra posterior. Datos públicos de carrefour.es para uso personal._`);
  L.push('');
  return L.join('\n');
}

module.exports = { buildAiPayload, renderReport, classifyPromo, inferCategory, SCHEMA };

// CLI: backfill/regenerate from an existing scrape without re-scraping.
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const inPath = process.argv[2] || 'products.json';
  const outBase = process.argv[3] || inPath.replace(/\.json$/, '');
  const payload = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const ai = buildAiPayload(payload);
  const aiPath = path.resolve(`${outBase}.ai.json`);
  const mdPath = path.resolve(`${outBase}.report.md`);
  fs.writeFileSync(aiPath, JSON.stringify(ai));
  fs.writeFileSync(mdPath, renderReport(ai));
  const kb = (p) => Math.round(fs.statSync(p).size / 1024);
  console.log(`✓ ${ai.products.length} products, ${ai.promos.length} promos, ${ai.summary.categoryCount} categories`);
  console.log(`✓ AI JSON  → ${aiPath} (${kb(aiPath)} KB)`);
  console.log(`✓ report   → ${mdPath} (${kb(mdPath)} KB)`);
}
