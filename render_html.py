#!/usr/bin/env python3
"""Render products.json as a self-contained, searchable HTML page."""
import html
import json
import sys
from pathlib import Path


def fmt_price(value, fallback=None):
    if value is None:
        return fallback or ''
    return f'{value:.2f} €'.replace('.', ',')


def render(products_path: str = 'products.json', out_path: str = 'products.html') -> None:
    data = json.loads(Path(products_path).read_text())
    products = data['products']

    # Stats
    total = len(products)
    brands = sorted({p['brand'] for p in products if p.get('brand')})
    promos = sorted({p['promo']['title'] for p in products if p.get('promo')})
    prices = [p['price'] for p in products if p.get('price') is not None]
    price_min = min(prices) if prices else 0
    price_max = max(prices) if prices else 0
    accessible_count = sum(1 for p in products if p.get('accessible'))
    inaccessible_count = sum(1 for p in products if p.get('accessible') is False)
    validation_note = ''
    if 'urlValidation' in data:
        validation_note = (
            f' · <strong>{accessible_count}</strong> accesibles, '
            f'<strong>{inaccessible_count}</strong> sin página de producto'
        )

    # Inline the products as JSON so search/filtering runs purely client-side
    payload = json.dumps(products, ensure_ascii=False)

    html_doc = f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Carrefour · {total} ofertas</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {{
    --bg: #f6f7fb;
    --card: #ffffff;
    --text: #1a1a1a;
    --muted: #6b7280;
    --accent: #004e9f;
    --price: #c8102e;
    --shadow: 0 1px 2px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.04);
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
  }}
  header {{
    position: sticky; top: 0; z-index: 10;
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
    padding: 14px 24px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  }}
  header h1 {{
    margin: 0; font-size: 18px; color: var(--accent);
  }}
  header .meta {{ color: var(--muted); font-size: 13px; }}
  .controls {{
    margin-left: auto;
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  }}
  .controls input, .controls select {{
    border: 1px solid #d1d5db; border-radius: 6px;
    padding: 6px 10px; font-size: 13px; background: #fff;
  }}
  .controls input:focus, .controls select:focus {{
    outline: 2px solid var(--accent); outline-offset: -2px;
  }}
  #count {{ color: var(--muted); font-size: 13px; }}
  main {{ padding: 16px 24px 48px; }}
  .grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 14px;
  }}
  .card {{
    background: var(--card);
    border-radius: 8px;
    box-shadow: var(--shadow);
    overflow: hidden;
    display: flex; flex-direction: column;
    text-decoration: none; color: inherit;
    transition: transform .12s ease, box-shadow .12s ease;
    position: relative;
  }}
  .card:hover {{ transform: translateY(-2px); box-shadow: 0 4px 12px rgba(15,23,42,.10); }}
  .card.unavailable .imgwrap img {{ filter: grayscale(60%) opacity(.7); }}
  .card.unavailable .body {{ opacity: .85; }}
  .card .unavailable-flag {{
    position: absolute; right: 8px; top: 8px;
    font-size: 11px; font-weight: 600;
    color: #fff; padding: 4px 8px; border-radius: 999px;
    background: #6b7280;
  }}
  .card .imgwrap {{
    aspect-ratio: 1 / 1;
    background: #fafafa;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    position: relative;
  }}
  .card img {{
    width: 100%; height: 100%; object-fit: contain;
    background: #fff;
  }}
  .badge {{
    position: absolute; left: 8px; top: 8px;
    font-size: 11px; font-weight: 600;
    color: #fff; padding: 4px 8px; border-radius: 999px;
    background: #A63793;
    max-width: calc(100% - 16px);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }}
  .card .body {{
    padding: 10px 12px; display: flex; flex-direction: column; flex: 1;
  }}
  .card .brand {{
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); margin-bottom: 4px;
  }}
  .card .name {{
    font-size: 13px; line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: calc(13px * 1.35 * 3);
    margin-bottom: 8px;
  }}
  .card .price {{
    font-weight: 700; font-size: 17px; color: var(--price);
    margin-top: auto;
  }}
  .card .ppu {{ color: var(--muted); font-size: 12px; }}
  .empty {{
    text-align: center; padding: 60px 20px; color: var(--muted);
  }}
  footer {{
    padding: 24px; text-align: center; color: var(--muted); font-size: 12px;
  }}
  a {{ color: var(--accent); }}
</style>
</head>
<body>
<header>
  <h1>Carrefour · ofertas</h1>
  <span class="meta">{total} productos · {len(brands)} marcas · {fmt_price(price_min)} – {fmt_price(price_max)}{validation_note}</span>
  <div class="controls">
    <input id="q" type="search" placeholder="Buscar producto, marca…" autocomplete="off">
    <select id="brand"><option value="">Todas las marcas</option></select>
    <select id="promo"><option value="">Todas las promociones</option></select>
    <select id="access"><option value="">Disponibles + no disponibles</option><option value="accessible">Solo disponibles</option><option value="inaccessible">Solo no disponibles</option></select>
    <select id="sort">
      <option value="default">Orden original</option>
      <option value="priceAsc">Precio: menor a mayor</option>
      <option value="priceDesc">Precio: mayor a menor</option>
      <option value="nameAsc">Nombre A–Z</option>
    </select>
    <span id="count"></span>
  </div>
</header>
<main>
  <div id="grid" class="grid"></div>
  <div id="empty" class="empty" hidden>Sin resultados</div>
</main>
<footer>
  Datos obtenidos de
  <a href="{html.escape(data.get('sourceUrl',''))}" target="_blank" rel="noopener">carrefour.es</a>
  el {data.get('scrapedAt','')}
</footer>
<script id="data" type="application/json">{payload}</script>
<script>
  const PRODUCTS = JSON.parse(document.getElementById('data').textContent);
  const grid = document.getElementById('grid');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const qEl = document.getElementById('q');
  const brandEl = document.getElementById('brand');
  const promoEl = document.getElementById('promo');
  const accessEl = document.getElementById('access');
  const sortEl = document.getElementById('sort');

  // populate filter options
  const uniq = (key) => [...new Set(PRODUCTS
      .map(p => key === 'promo' ? (p.promo && p.promo.title) : p[key])
      .filter(Boolean))].sort((a,b) => a.localeCompare(b, 'es'));
  for (const b of uniq('brand')) {{
    const o = document.createElement('option'); o.value = b; o.textContent = b;
    brandEl.appendChild(o);
  }}
  for (const p of uniq('promo')) {{
    const o = document.createElement('option'); o.value = p; o.textContent = p;
    promoEl.appendChild(o);
  }}

  const fmt = (v) => v == null ? '' : v.toFixed(2).replace('.', ',') + ' €';
  const norm = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');

  function renderCard(p) {{
    const promoTitle = p.promo && p.promo.title;
    const promoColor = (p.promo && p.promo.color) || '#A63793';
    const inaccessible = p.accessible === false;
    const href = inaccessible ? (p.redirectsTo || p.url || '#') : (p.url || '#');
    const titleAttr = inaccessible
      ? 'title="Página de producto no disponible — el enlace lleva a la categoría"'
      : '';
    return `
      <a class="card${{inaccessible ? ' unavailable' : ''}}" href="${{href}}" target="_blank" rel="noopener" ${{titleAttr}}>
        <div class="imgwrap">
          ${{p.imageUrl ? `<img loading="lazy" src="${{p.imageUrl}}" alt="">` : ''}}
          ${{promoTitle ? `<span class="badge" style="background:${{promoColor}}">${{promoTitle}}</span>` : ''}}
          ${{inaccessible ? `<span class="unavailable-flag">No disponible</span>` : ''}}
        </div>
        <div class="body">
          <div class="brand">${{p.brand || ''}}</div>
          <div class="name">${{p.name || ''}}</div>
          <div class="price">${{fmt(p.price)}}</div>
          ${{p.pricePerUnitText ? `<div class="ppu">${{p.pricePerUnitText}}</div>` : ''}}
        </div>
      </a>
    `;
  }}

  function apply() {{
    const q = norm(qEl.value.trim());
    const brand = brandEl.value;
    const promo = promoEl.value;
    const sort = sortEl.value;
    const access = accessEl.value;
    let rows = PRODUCTS.filter(p => {{
      if (brand && p.brand !== brand) return false;
      if (promo && (!p.promo || p.promo.title !== promo)) return false;
      if (access === 'accessible' && p.accessible === false) return false;
      if (access === 'inaccessible' && p.accessible !== false) return false;
      if (q) {{
        const hay = norm(p.name) + ' ' + norm(p.brand);
        if (!hay.includes(q)) return false;
      }}
      return true;
    }});
    if (sort === 'priceAsc') rows.sort((a,b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    else if (sort === 'priceDesc') rows.sort((a,b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
    else if (sort === 'nameAsc') rows.sort((a,b) => (a.name || '').localeCompare(b.name || '', 'es'));
    grid.innerHTML = rows.map(renderCard).join('');
    emptyEl.hidden = rows.length > 0;
    countEl.textContent = `${{rows.length}} / ${{PRODUCTS.length}}`;
  }}

  qEl.addEventListener('input', apply);
  brandEl.addEventListener('change', apply);
  promoEl.addEventListener('change', apply);
  accessEl.addEventListener('change', apply);
  sortEl.addEventListener('change', apply);
  apply();
</script>
</body>
</html>"""

    Path(out_path).write_text(html_doc, encoding='utf-8')
    print(f'  rendered {total} products → {out_path} ({Path(out_path).stat().st_size/1024:.0f} KB)')


if __name__ == '__main__':
    render(
        sys.argv[1] if len(sys.argv) > 1 else 'products.json',
        sys.argv[2] if len(sys.argv) > 2 else 'products.html',
    )
