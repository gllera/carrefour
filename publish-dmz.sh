#!/usr/bin/env bash
# Publish the finished dataset from this box to the web server that serves the page.
#
# The scrape itself has to stay on this box: carrefour.es serves it
# and answers a datacenter address with a Cloudflare interstitial. Measured
# 2026-09-26 — ten fresh loads of the offers hub from each box, same script, same
# minute: 403 "Just a moment..." 10/10 from the server, 200 10/10 from here. So only the
# five output files travel. run.sh calls this with CARREFOUR_OUT set to its temp
# scrape dir; it is idempotent, so re-running it on the same dir is harmless.
set -euo pipefail

OUT=${CARREFOUR_OUT:?set CARREFOUR_OUT to the dir holding the five files (run.sh does)}
DEST_HOST=${CARREFOUR_DMZ_HOST:-user@web-server}
DEST_DIR=${CARREFOUR_DMZ_DIR:-/var/www/carrefour}

# Everything run.sh publishes, and the only names the site serves.
FILES=(index.html products.json products.ai.json products.csv products.report.md)

for f in "${FILES[@]}"; do
  [ -s "$OUT/$f" ] || { echo "$0: $OUT/$f missing or empty — did run.sh finish?" >&2; exit 1; }
done

# The server has no rsync, and the parent dir is root-owned so a sibling staging dir is not ours
# to create. Stage inside $DEST_DIR (which we do own) under a dotted name the
# site hides, then move each file into place: mv within one directory is atomic,
# so a reader never gets a half-written page. The five renames are not atomic as
# a group, which for a once-a-day offers page is a millisecond of mixed vintage.
STAGE="$DEST_DIR/.incoming"

ssh "$DEST_HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"
tar -C "$OUT" -czf - "${FILES[@]}" | ssh "$DEST_HOST" "tar -C '$STAGE' -xzf -"
# 0640 against the directory's setgid web-server group: the server reads it, nobody else.
ssh "$DEST_HOST" "chmod 0640 '$STAGE'/* && mv -f '$STAGE'/* '$DEST_DIR'/ && rmdir '$STAGE'"

echo "published → $DEST_HOST:$DEST_DIR (${#FILES[@]} files)"
