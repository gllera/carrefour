# One image, both architectures. The only thing that differs between them is
# where Chrome comes from: upstream's puppeteer base bundles Chrome for Testing
# but publishes an amd64 manifest only (Chrome for Testing has no linux/arm64
# build), so on aarch64 Debian's chromium stands in. Both arms end by
# exposing whatever browser they installed at the same stable path, so every
# step after the split is shared and cannot drift between the two.
ARG TARGETARCH

FROM ghcr.io/puppeteer/puppeteer:latest AS chrome-amd64
# The base image bundles Chrome under a version-stamped dir that bumps whenever
# the base advances (148 -> 149 -> ...). Hardcoding that version path is fragile
# and silently breaks the launch on the next base bump. Resolve whatever Chrome
# is actually present and expose it at a stable, version-independent path.
USER root
RUN ln -sf "$(find /home/pptruser/.cache/puppeteer/chrome -maxdepth 3 -name chrome -type f | head -1)" /usr/local/bin/chrome

FROM node:22-bookworm-slim AS chrome-arm64
# Debian's chromium is the maintained headless Chrome on arm64. The slim base
# ships no fonts, and Chromium refuses to paint text without at least one family.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/chromium /usr/local/bin/chrome

FROM chrome-${TARGETARCH}
ENV OUT_DIR=/output
WORKDIR /app
COPY package.json package-lock.json ./
# Chrome is already installed by the stage above; without this, puppeteer's
# postinstall downloads a second ~300 MB copy that nothing uses — and on arm64
# there is no copy to download at all.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci
COPY scrape.js analyze.js probe.js ./
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome
# Both bases already own uid 1000 (pptruser / node), so /output files land with
# identical ownership whichever arch built the image.
USER 1000:1000
ENTRYPOINT ["node", "scrape.js"]
