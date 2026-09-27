#!/usr/bin/env bash
# Publish the finished dataset from this box to the web server that serves the
# page.
#
# The scrape and the page can live on different hosts: carrefour.es answers a
# datacenter address with a Cloudflare interstitial (403 "Just a moment..."), so
# the scrape may have to run somewhere the site serves while the page is hosted
# elsewhere. So only the five output files travel. run.sh calls this with
# CARREFOUR_OUT set to its temp scrape dir; it is idempotent, so re-running it
# on the same dir is harmless. The destination comes from ./.env (gitignored).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi

OUT=${CARREFOUR_OUT:?set CARREFOUR_OUT to the dir holding the five files (run.sh does)}
DEST_HOST=${CARREFOUR_DMZ_HOST:?set CARREFOUR_DMZ_HOST (ssh destination, user@host) in .env}
DEST_DIR=${CARREFOUR_DMZ_DIR:?set CARREFOUR_DMZ_DIR (the directory the site serves) in .env}

# Everything run.sh publishes, and the only names the site serves.
FILES=(index.html products.json products.ai.json products.csv products.report.md)

for f in "${FILES[@]}"; do
  [ -s "$OUT/$f" ] || { echo "$0: $OUT/$f missing or empty — did run.sh finish?" >&2; exit 1; }
done

# No rsync needed, and no write access outside $DEST_DIR: stage inside it (which
# we do own) under a dotted name the site hides, then move each file into place:
# mv within one directory is atomic, so a reader never gets a half-written page.
# The five renames are not atomic as a group, which for a once-a-day offers page
# is a millisecond of mixed vintage.
STAGE="$DEST_DIR/.incoming"

ssh "$DEST_HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"
tar -C "$OUT" -czf - "${FILES[@]}" | ssh "$DEST_HOST" "tar -C '$STAGE' -xzf -"
# 0640 against a setgid directory owned by the web server's group: the server
# reads it, nobody else.
ssh "$DEST_HOST" "chmod 0640 '$STAGE'/* && mv -f '$STAGE'/* '$DEST_DIR'/ && rmdir '$STAGE'"

echo "published → $DEST_HOST:$DEST_DIR (${#FILES[@]} files)"
