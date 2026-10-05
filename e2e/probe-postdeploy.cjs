// Post-deploy window probe: for N minutes after a promote, open a FRESH context every 20 s and record
// whether the shell renders, whether the first SPA navigation works, the SW controller and any 404
// on _app assets. Usage via run.sh: ./run.sh https://music.ekaii.fr "daft punk" probe-postdeploy.cjs
const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const MINUTES = Number((process.argv.find((a) => a.startsWith("--minutes=")) || "--minutes=4").split("=")[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const end = Date.now() + MINUTES * 60000;
  let i = 0;
  while (Date.now() < end) {
    i++;
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const notFound = []; const errs = [];
    page.on("response", (r) => { if (r.status() === 404 && /\/_app\//.test(r.url())) notFound.push(r.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 70)); });
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 100)));
    const t0 = Date.now();
    try {
      await page.goto(URL + "/home", { waitUntil: "load", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      const homeLen = (await page.locator("main").first().innerText().catch(() => "")).length;
      // first SPA navigation like the offline harness does
      await page.evaluate(() => { const a = document.createElement("a"); a.href = "/search/daft%20punk?filter=all"; a.id = "__h"; a.textContent = "x"; document.body.appendChild(a); a.click(); });
      await sleep(6000);
      const songs = await page.getByText(/Song\s*•/).count();
      const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { ctl: !!navigator.serviceWorker.controller, waiting: !!(r && r.waiting), installing: !!(r && r.installing), active: !!(r && r.active) }; }).catch(() => null);
      console.log(`T+${Math.round((Date.now() - t0) / 1000)}s #${i}`, JSON.stringify({ homeLen, songs, sw, notFound: notFound.slice(0, 3), errs: errs.slice(0, 2) }));
    } catch (e) { console.log(`#${i} ERR`, String(e.message || e).slice(0, 120)); }
    await ctx.close();
    await sleep(20000);
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
