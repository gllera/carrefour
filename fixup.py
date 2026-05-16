#!/usr/bin/env python3
"""Post-process the scraped JSON: filter blank banner slots and fix lowercase product IDs."""
import json
import re
import sys
import csv
from pathlib import Path

PRODUCT_ID_RE = re.compile(r'/([RP]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/p\b')
PRODUCT_ID_FALLBACK_RE = re.compile(r'/(\d{4,})/p\b')


def extract_product_id(url: str | None) -> str | None:
    if not url:
        return None
    m = PRODUCT_ID_RE.search(url)
    if m:
        return m.group(1)
    m = PRODUCT_ID_FALLBACK_RE.search(url)
    return m.group(1) if m else None


def main(in_path: str, out_path: str | None = None) -> None:
    data = json.loads(Path(in_path).read_text())
    products = data['products']

    cleaned = []
    seen_keys = set()
    repaired_ids = 0
    skipped_empty = 0
    skipped_duplicates = 0

    for p in products:
        if not p.get('name') and not p.get('url'):
            skipped_empty += 1
            continue
        if not p.get('productId') and p.get('url'):
            pid = extract_product_id(p['url'])
            if pid:
                p['productId'] = pid
                repaired_ids += 1
        key = p.get('productId') or p.get('url')
        if key in seen_keys:
            skipped_duplicates += 1
            continue
        seen_keys.add(key)
        cleaned.append(p)

    data['products'] = cleaned
    data['collected'] = len(cleaned)
    out_path = out_path or in_path
    Path(out_path).write_text(json.dumps(data, ensure_ascii=False, indent=2))

    # Re-emit CSV
    csv_path = Path(out_path).with_suffix('.csv')
    headers = [
        'productId', 'name', 'brand', 'price', 'priceText',
        'originalPrice', 'originalPriceText',
        'pricePerUnit', 'pricePerUnitText',
        'catalog', 'documentType', 'discountText',
        'promoTitle', 'promoValidUntil', 'promoDescription', 'promoUrl',
        'url', 'imageUrl', 'accessible', 'redirectsTo', 'urlStatus',
        'pageNumber', 'positionOnPage',
    ]
    with csv_path.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(headers)
        for p in cleaned:
            promo = p.get('promo') or {}
            w.writerow([
                p.get('productId'), p.get('name'), p.get('brand'),
                p.get('price'), p.get('priceText'),
                p.get('originalPrice'), p.get('originalPriceText'),
                p.get('pricePerUnit'), p.get('pricePerUnitText'),
                p.get('catalog'), p.get('documentType'), p.get('discountText'),
                promo.get('title'), promo.get('validUntil'),
                promo.get('description'), promo.get('campaignUrl'),
                p.get('url'), p.get('imageUrl'),
                p.get('accessible'), p.get('redirectsTo'), p.get('urlStatus'),
                p.get('pageNumber'), p.get('positionOnPage'),
            ])

    print(f'  kept:               {len(cleaned)} products')
    print(f'  filtered empty:     {skipped_empty}')
    print(f'  filtered duplicate: {skipped_duplicates}')
    print(f'  productId repaired: {repaired_ids}')
    print(f'  → {out_path}')
    print(f'  → {csv_path}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'products.json')
