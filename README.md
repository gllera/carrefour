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

### Campos por producto

`productId`, `name`, `brand`, `url`, `imageUrl`, `price`, `originalPrice`, `pricePerUnit`, `priceText`, `discountText`, `promo` (título, color, descripción, válido hasta, URL de campaña), `catalog`, `documentType`, `pageNumber`, `positionOnPage`, `sourceUrl`.

## Notas

- El código postal está fijado en `28904` (Getafe) en el cookie `postalCode` — cámbialo en `scrape.js` si necesitas precios de otra zona.
- Las imágenes de los productos usan lazy-loading: el scraper lee `data-src` antes que `src` porque las imágenes de productos fuera del viewport nunca se cargan (los requests de imagen están bloqueados por velocidad).
- Repositorio sin licencia explícita — uso personal/educativo. Respeta los `robots.txt` y los términos de servicio del sitio objetivo.
