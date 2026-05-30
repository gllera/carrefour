FROM ghcr.io/puppeteer/puppeteer:latest
ENV PUPPETEER_EXECUTABLE_PATH=/home/pptruser/.cache/puppeteer/chrome/linux-148.0.7778.167/chrome-linux64/chrome
ENV OUT_DIR=/output
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scrape.js analyze.js ./
USER 1000:1000
ENTRYPOINT ["node", "scrape.js"]
