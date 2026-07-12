FROM ghcr.io/puppeteer/puppeteer:latest
ENV OUT_DIR=/output
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scrape.js analyze.js ./
# The base image bundles Chrome under a version-stamped dir that bumps whenever
# the base advances (148 -> 149 -> ...). Hardcoding that version path is fragile
# and silently breaks the launch on the next base bump. Resolve whatever Chrome
# is actually present and expose it at a stable, version-independent path.
USER root
RUN ln -sf "$(find /home/pptruser/.cache/puppeteer/chrome -maxdepth 3 -name chrome -type f | head -1)" /usr/local/bin/chrome
USER 1000:1000
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome
ENTRYPOINT ["node", "scrape.js"]
