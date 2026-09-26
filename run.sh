#!/usr/bin/env bash
# Scrape Carrefour offers and publish to $CARREFOUR_OUT (default:
# ~/public/carrefour, served as a static site). The scrape runs here on
# this box because carrefour.es challenges a datacenter address; ./publish-dmz.sh
# then copies the finished files to the web server, which serves the page. See that script.
# The whole pipeline — no Claude needed. Pass --force to re-scrape the same day.
# Rebuild the image first only if the repo changed: docker build -t carrefour-scraper .
# The Dockerfile covers both architectures; no per-host build flags.
# SCRAPE_WORKERS caps the concurrent campaign workers (default 3) — a box with
# few cores wants less than that, e.g. SCRAPE_WORKERS=2 on four.
set -euo pipefail

OUT=${CARREFOUR_OUT:-$HOME/public/carrefour}

# -e without a value forwards the variable only when the caller actually set it,
# so the container keeps scrape.js's own defaults otherwise.
docker run --rm -v "$OUT":/output -e SCRAPE_WORKERS -e SCRAPE_FORCE carrefour-scraper "$@"

# A skipped same-day run produces no products.html; keep the current page then.
# The rename is the last thing this script does and `mv` within $OUT is atomic,
# so index.html is never half-written — publish-dmz.sh reading $OUT mid-scrape
# would copy the previous complete page, not a torn one.
if [ -f "$OUT/products.html" ]; then
  mv "$OUT/products.html" "$OUT/index.html"
  echo "published → $OUT/index.html"
else
  echo "no new products.html (same-day cache) — index.html left as-is"
fi
