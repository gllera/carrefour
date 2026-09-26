#!/usr/bin/env bash
# Scrape Carrefour offers and publish to $CARREFOUR_OUT (default:
# ~/public/carrefour, served as a static site). On the web server the pipeline
# runs with its own CARREFOUR_OUT.
# The whole pipeline — no Claude needed. Pass --force to re-scrape the same day.
# Rebuild the image first only if the repo changed: docker build -t carrefour-scraper .
# On aarch64 build with -f Dockerfile.arm64 — the base image differs.
set -euo pipefail

OUT=${CARREFOUR_OUT:-$HOME/public/carrefour}

docker run --rm -v "$OUT":/output carrefour-scraper "$@"

# A skipped same-day run produces no products.html; keep the current page then.
if [ -f "$OUT/products.html" ]; then
  mv "$OUT/products.html" "$OUT/index.html"
  echo "published → $OUT/index.html"
else
  echo "no new products.html (same-day cache) — index.html left as-is"
fi
