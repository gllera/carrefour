#!/usr/bin/env bash
# Scrape Carrefour offers into a throwaway temp dir, publish the five files to
# the web server with ./publish-dmz.sh, then delete the temp
# dir. Nothing is kept on this box: the web server holds the only copy.
# The scrape runs on this box because carrefour.es challenges a datacenter
# address; see publish-dmz.sh.
# The whole pipeline — no Claude needed. Extra args go to scrape.js.
# Rebuild the image first only if the repo changed: docker build -t carrefour-scraper .
# The Dockerfile covers both architectures; no per-host build flags.
# SCRAPE_WORKERS caps the concurrent campaign workers (default 3).
#
# Every run is a full scrape (~20-40 min): the scraper's same-day cache lives in
# its output dir, and that dir starts empty each time.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

# mktemp gives a 0700 dir owned by us (uid 1000), which is also the image's
# uid, so the container can write into it. Removed on any exit, success or not.
OUT=$(mktemp -d -t carrefour.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# -e without a value forwards the variable only when the caller actually set it,
# so the container keeps scrape.js's own defaults otherwise.
docker run --rm -v "$OUT":/output -e SCRAPE_WORKERS -e SCRAPE_FORCE carrefour-scraper "$@"

# A fresh dir has no same-day cache, so a finished scrape always leaves
# products.html; a missing one means the scrape did not complete.
[ -f "$OUT/products.html" ] || { echo "$0: no products.html in $OUT — scrape did not finish" >&2; exit 1; }
mv "$OUT/products.html" "$OUT/index.html"

CARREFOUR_OUT="$OUT" "$HERE/publish-dmz.sh"
