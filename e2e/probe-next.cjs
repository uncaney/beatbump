// probe-next.cjs — instrumente "morceau suivant" : lecture du 1er resultat, clic sur suivant,
// etat media + erreurs console toutes les secondes pendant 15 s. run.sh <url> <query> probe-next.cjs
const { chromium } = require("playwright");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));
const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const QUERY = arg("query", "daft punk");
const RESOLVER = arg("resolver", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const media = (page) => page.evaluate(() => { const el = window.__ytmMedia; return el ? { src: (el.currentSrc || el.src || "").slice(0, 90), t: +el.currentTime.toFixed(2), paused: el.paused, rs: el.readyState, ns: el.networkState, err: el.error ? el.error.code + ":" + (el.error.message || "") : null } : null; });
async function search(page) {
  await page.goto(URL + "/", { waitUntil: "networkidle", timeout: 45000 });
  const box = page.locator("input[type=search], input[placeholder*='earch' i], input").first();
  if (!(await box.isVisible().catch(() => false))) await page.locator("a[href*='search'], button[aria-label*='earch' i]").first().click({ timeout: 5000 }).catch(() => {});
  const b2 = page.locator("input[type=search], input[placeholder*='earch' i], input").first();
  await b2.click({ timeout: 8000 }); await b2.fill(QUERY); await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.getByText(/Song\s*•/).first().waitFor({ state: "visible", timeout: 15000 });
}
(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), headless: true, chromiumSandbox: false, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage", ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; window.__ytmPlays = (window.__ytmPlays || 0) + 1; return orig.apply(this, arguments); };
    const origLoad = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () { window.__ytmLoads = (window.__ytmLoads || 0) + 1; return origLoad.apply(this, arguments); };
  });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 220)); });
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e && e.message || e).slice(0, 220)));
  page.on("response", (r) => { if (/\/localf|\/aud\/|\/vp\?|player\.json/.test(r.url())) console.log("RESP", r.status(), r.fromServiceWorker() ? "SW" : "NET", (r.headers()["content-range"] || "-"), r.url().slice(URL.length, URL.length + 80)); });

  await search(page);
  await page.getByText(/Song\s*•/).first().click({ timeout: 8000 });
  let m = null; for (let i = 0; i < 30 && !(m && m.t > 1); i++) { await sleep(1000); m = await media(page); }
  console.log("PLAY1", JSON.stringify(m));
  await sleep(4000); // laisser le prefetch du suivant partir
  const cnt = await page.evaluate(() => ({ plays: window.__ytmPlays || 0, loads: window.__ytmLoads || 0 }));
  console.log("COUNTS_BEFORE_NEXT", JSON.stringify(cnt));
  const btn = page.locator("[aria-label=\"Morceau suivant\"], .player-btn:has(use[href*=\"skip-forward\"])").first();
  console.log("NEXT_BTN_COUNT", await btn.count());
  await btn.click({ timeout: 8000 });
  for (let i = 1; i <= 15; i++) {
    await sleep(1000);
    const st = await media(page);
    const c = await page.evaluate(() => ({ plays: window.__ytmPlays || 0, loads: window.__ytmLoads || 0 }));
    console.log("NEXT+" + i + "s", JSON.stringify(st), JSON.stringify(c));
  }
  await ctx.close(); await browser.close();
})();
