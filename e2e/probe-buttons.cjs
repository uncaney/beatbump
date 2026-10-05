const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
  const albumId = await page.evaluate(async () => { const r = await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc"); const d = await r.json(); return d.items[0].browseId; });
  await page.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
  await page.locator('[data-testid="keep-offline"]').first().waitFor({ state: "visible", timeout: 20000 });
  const probe = (sel) => page.locator(sel).first().evaluate((el) => { const cs = getComputedStyle(el); return { color: cs.color, bg: cs.backgroundColor, tt: cs.textTransform, h: Math.round(el.getBoundingClientRect().height), cls: el.className }; }).catch((e) => String(e).slice(0, 60));
  console.log("KEEP", JSON.stringify(await probe('[data-testid="keep-offline"]')));
  const sheets = await page.evaluate(() => [...document.styleSheets].map((s) => (s.href || "inline").replace(/^https?:\/\/[^/]+/, "")).slice(0, 6));
  console.log("SHEETS", JSON.stringify(sheets));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
