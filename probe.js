// Cheapest possible reachability check: does carrefour.es serve a headless
// browser from THIS box's IP? Bot protection reacts to the egress address, so
// a residential IP answering says nothing about a datacenter one — run this
// before assuming a new host can scrape at all. Two page loads, no output files.
//
//   node probe.js [url]
//
// Exits 0 and prints "VERDICT: served" when both pages return 200 and the
// campaign grid renders product cards; exits 1 on a block, a challenge or an
// empty grid. Mirrors scrape.js's browser and page setup (stealth, UA, viewport,
// postal-code cookies) so the answer is about the IP and not about the client.

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const ORIGIN = 'https://www.carrefour.es';
const HUB_URL = process.argv[2] || `${ORIGIN}/supermercado/ofertas/cat20968591/c`;
const POSTAL_CODE = '00000';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SEL_CARD = '.product-card-list__item';
const NAV_TIMEOUT_MS = 90_000;
const SELECTOR_TIMEOUT_MS = 30_000;

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setCookie(
    { name: 'postalCode',     value: POSTAL_CODE, domain: '.carrefour.es', path: '/' },
    { name: 'userPostalCode', value: POSTAL_CODE, domain: '.carrefour.es', path: '/' },
  );
  return page;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  let ok = true;
  try {
    const page = await newPage(browser);

    const hubRes = await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const hubStatus = hubRes?.status();
    const title = await page.title();
    // A challenge page answers 200 with a body that is not the shop, so the
    // status alone is not the verdict — what rendered is.
    const campaigns = await page.evaluate(() => [...new Set(
      [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => /\/g(?:[?#].*)?$/.test(h || '')),
    )]);
    console.log(`hub      ${hubStatus}  "${title}"  ${campaigns.length} /g campaign links`);
    if (hubStatus !== 200) ok = false;

    if (campaigns.length === 0) {
      console.log('hub rendered no campaign links — treat as NOT served');
      ok = false;
    } else {
      const campaignUrl = new URL(campaigns[0], ORIGIN).toString();
      const res = await page.goto(campaignUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      const status = res?.status();
      let cards = 0;
      try {
        await page.waitForSelector(SEL_CARD, { timeout: SELECTOR_TIMEOUT_MS });
        cards = await page.evaluate((sel) => document.querySelectorAll(sel).length, SEL_CARD);
      } catch { /* no cards within the timeout — reported as 0 below */ }
      const names = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
        .slice(0, 3)
        .map((el) => (el.innerText || '').split('\n').filter(Boolean)[0] || ''), SEL_CARD);
      console.log(`campaign ${status}  ${campaignUrl}`);
      console.log(`         ${cards} product cards; first: ${names.join(' | ')}`);
      if (status !== 200 || cards === 0) ok = false;
    }
  } catch (e) {
    console.log('probe failed:', e.message);
    ok = false;
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(ok ? 'VERDICT: served' : 'VERDICT: NOT served');
  process.exit(ok ? 0 : 1);
})();
