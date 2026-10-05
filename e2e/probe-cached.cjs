// probe-cached.cjs — reproduit la reprise d un morceau deja en cache et mesure ce que le SW renvoie.
// run.sh <url> <query> probe-cached.cjs
const { chromium } = require("playwright");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));
const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const QUERY = arg("query", "daft punk");
const RESOLVER = arg("resolver", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const media = (page) => page.evaluate(() => { const el = window.__ytmMedia; return el ? { src: el.currentSrc || el.src, t: el.currentTime, paused: el.paused, rs: el.readyState, err: el.error ? el.error.code + ":" + (el.error.message || "") : null } : null; });
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
  await page.addInitScript(() => { const orig = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); }; });
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 200)); });
  page.on("response", (r) => { if (/\/localf|\/aud\/|\/vp\?/.test(r.url())) console.log("RESP", r.status(), r.fromServiceWorker() ? "SW" : "NET", (r.headers()["content-range"] || "-"), (r.headers()["content-type"] || "-"), r.url().slice(0, 70)); });

  console.log("--- 1) premiere lecture (met en cache) ---");
  await search(page);
  await page.getByText(/Song\s*•/).first().click({ timeout: 8000 });
  let m = null; for (let i = 0; i < 30 && !(m && m.src); i++) { await sleep(1000); m = await media(page); }
  console.log("media1", JSON.stringify(m));
  const src1 = m && m.src;
  // attendre que le cache soit alimente
  let cached = [];
  for (let i = 0; i < 40; i++) { cached = await page.evaluate(async () => { const c = await caches.open("ytm-offline-audio"); return (await c.keys()).map((k) => k.url); }); if (cached.length) break; await sleep(1500); }
  console.log("cache", JSON.stringify(cached.map((u) => u.slice(0, 80))));

  console.log("--- 2) sondes fetch via SW sur l URL cachee ---");
  const probeUrl = cached.find((u) => u === src1) || cached[0] || src1;
  for (const range of [null, "bytes=0-1", "bytes=0-", "bytes=100-199"]) {
    const r = await page.evaluate(async ([u, rg]) => {
      try { const res = await fetch(u, rg ? { headers: { Range: rg } } : {}); const b = await res.arrayBuffer(); return { rg, status: res.status, cr: res.headers.get("content-range"), cl: res.headers.get("content-length"), ct: res.headers.get("content-type"), ar: res.headers.get("accept-ranges"), bytes: b.byteLength }; } catch (e) { return { rg, error: String(e) }; }
    }, [probeUrl, range]);
    console.log("PROBE", JSON.stringify(r));
  }

  console.log("--- 3) reprise apres rechargement (meme morceau, en cache) ---");
  await search(page);
  await page.getByText(/Song\s*•/).first().click({ timeout: 8000 });
  m = null; for (let i = 0; i < 20; i++) { await sleep(1000); m = await media(page); if (m && (m.err || m.t > 1)) break; }
  console.log("media2", JSON.stringify(m));
  await sleep(3000); console.log("media2b", JSON.stringify(await media(page)));
  await ctx.close(); await browser.close();
})();
