#!/usr/bin/env bash
# Scrape Carrefour offers into a throwaway temp dir, publish the five files to
# the web server with ./publish-dmz.sh, then delete the temp dir. Nothing is
# kept on this box: the web server holds the only copy.
# Run the scrape from a host carrefour.es actually serves — it challenges
# datacenter addresses; check a new host with probe.js first.
# The whole pipeline — no Claude needed. Extra args go to scrape.js.
# Rebuild the image first only if the repo changed: docker build -t carrefour-scraper .
# The Dockerfile covers both architectures; no per-host build flags.
# SCRAPE_WORKERS caps the concurrent campaign workers (default 3).
# Local settings (postal code, store, publish target) come from ./.env, which is
# gitignored; start one from .env.example.
#
# Every run is a full scrape (~20-40 min) and always republishes, even a second
# run the same day. SCRAPE_FORCE=1 is pinned below so the scraper's same-day
# cache can never short-circuit it (the temp dir starts empty anyway).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# set -a exports everything .env assigns, so both the valueless -e flags below
# and publish-dmz.sh see it.
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi

# mktemp gives a 0700 dir owned by us (uid 1000), which is also the image's
# uid, so the container can write into it. Removed on any exit, success or not.
OUT=$(mktemp -d -t carrefour.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# -e without a value forwards the variable only when the caller actually set it,
# so the container keeps scrape.js's own defaults otherwise.
docker run --rm -v "$OUT":/output -e SCRAPE_POSTAL_CODE -e SCRAPE_STORE_ID -e SCRAPE_WORKERS -e SCRAPE_FORCE=1 carrefour-scraper "$@"

# A fresh dir has no same-day cache, so a finished scrape always leaves
# products.html; a missing one means the scrape did not complete.
[ -f "$OUT/products.html" ] || { echo "$0: no products.html in $OUT — scrape did not finish" >&2; exit 1; }
mv "$OUT/products.html" "$OUT/index.html"

CARREFOUR_OUT="$OUT" "$HERE/publish-dmz.sh"
