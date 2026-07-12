#!/usr/bin/env bash
# Scrape Carrefour offers and publish to ~/public/carrefour (dev.llera.eu/carrefour/).
# The whole pipeline — no Claude needed. Pass --force to re-scrape the same day.
# Rebuild the image first only if the repo changed: docker build -t carrefour-scraper .
set -euo pipefail

OUT=/home/gllera/public/carrefour

docker run --rm -v "$OUT":/output carrefour-scraper "$@"

# A skipped same-day run produces no products.html; keep the current page then.
if [ -f "$OUT/products.html" ]; then
  mv "$OUT/products.html" "$OUT/index.html"
  echo "published → https://dev.llera.eu/carrefour/"
else
  echo "no new products.html (same-day cache) — index.html left as-is"
fi
