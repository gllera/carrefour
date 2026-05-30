# Carrefour Offers Scraper

Scraper de las ofertas del supermercado online de Carrefour España. Recorre cada página de una categoría de ofertas y exporta cada producto a **JSON**, **CSV** y una página **HTML** autocontenida con búsqueda y filtros.

## Características

- **Modo hub** (`/c`): descubre todas las campañas `/g` de una categoría y las recorre en paralelo.
- **Modo único** (`/g`): recorre una sola campaña.
- Backoff compartido entre workers ante 429/5xx para no martillear Cloudflare.
- Imágenes/medios/fuentes bloqueados a nivel de request → scraping rápido.
- Contextos de navegador separados por worker para evitar solapamiento de resultados.
- Stealth plugin de Puppeteer para reducir detección de automatización.

## Instalación

```bash
npm install
```

Requiere Node.js 18+.

## Uso

```bash
# URL por defecto (ofertas del super), salida en ./products.{json,csv,html}
node scrape.js

# URL personalizada
node scrape.js https://www.carrefour.es/supermercado/ofertas/cat20968591/c

# URL + prefijo de salida personalizado
node scrape.js https://www.carrefour.es/.../g lacteos
```

### Variables de entorno

| Variable          | Por defecto | Descripción                                    |
|-------------------|-------------|------------------------------------------------|
| `SCRAPE_WORKERS`  | `3`         | Workers concurrentes en modo hub               |

## Salida

- `products.json` — payload completo con metadatos, resumen por campaña y todos los productos.
- `products.csv` — fila por producto, columnas clave para hojas de cálculo.
- `products.html` — página estática con todos los productos embebidos: búsqueda por nombre/marca, filtro por marca y promoción, orden por precio o nombre. Funciona offline.
- `products.ai.json` — vista compacta y enriquecida para análisis con un LLM (~75% más pequeña que `products.json`). Ver abajo.
- `products.report.md` — resumen determinista en Markdown: mejores descuentos, precio por unidad más barato, desglose de promociones, ofertas por categoría y marcas con más ofertas.

### Campos por producto (`products.json`)

`productId`, `name`, `brand`, `url`, `imageUrl`, `price`, `originalPrice`, `pricePerUnit`, `priceText`, `discountText`, `promo` (título, color, descripción, válido hasta, URL de campaña), `catalog`, `documentType`, `pageNumber`, `positionOnPage`, `sourceUrl`.

### Salida para IA (`products.ai.json`, esquema `carrefour-ai/1`)

Generada por `analyze.js`. Quita campos redundantes, deduplica las promociones en una tabla de consulta y añade señales calculadas para que un LLM no tenga que recomputarlas:

- **`promos[]`** — tabla de promociones únicas (en lugar de repetir el texto en cada producto). Cada una con `type` (`second-unit`, `multibuy`, `cashback-coupon`, `bulk`, `price-flag`, `shipping`, `bundle`, `stacking`, `themed`…), `effectiveDiscountPct` estimado, `deferred` (cupones que se devuelven en una compra posterior) y `validFrom`/`validUntil` en ISO.
- **`products[]`** — por producto: `id`, `name`, `brand`, `price`, `wasPrice`/`discountPct` (sólo si había precio tachado), `unit` + `unitPrice` (€/kg, €/l, €/ud…), `category` (inferida del nombre), `promo` (índice en `promos[]`) y `url`.
- **`summary`** — agregados ya calculados: rango y mediana de precios, conteos por tipo de promoción, desglose por promoción (`promoBreakdown`), categorías, marcas top, lo más barato por unidad de medida y los mayores descuentos inmediatos.

`effectiveDiscountPct` es una **estimación** del descuento inmediato si se cumple la base de la oferta (p. ej. comprar 2 uds); los cupones `deferred` se devuelven en una compra posterior, no son una rebaja inmediata.

`analyze.js` también funciona de forma independiente sobre un scrape existente, sin volver a scrapear:

```bash
node analyze.js products.json            # → products.ai.json + products.report.md
node analyze.js products.json salida     # prefijo de salida personalizado
```

## Notas

- El código postal está fijado en `28904` (Getafe) en el cookie `postalCode` — cámbialo en `scrape.js` si necesitas precios de otra zona.
- Las imágenes de los productos usan lazy-loading: el scraper lee `data-src` antes que `src` porque las imágenes de productos fuera del viewport nunca se cargan (los requests de imagen están bloqueados por velocidad).
- Repositorio sin licencia explícita — uso personal/educativo. Respeta los `robots.txt` y los términos de servicio del sitio objetivo.
