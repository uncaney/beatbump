// access-audit/gate-tor.cjs — mesure du gate PoW nopasaran vu d'un VRAI navigateur externe.
// Chromium sort via le SOCKS Tor de la box (127.0.0.1:9055) => IP source = exit Tor (non interne)
// => CHALLENGE, UA Chrome normal (HeadlessChrome est DENY). Lecture seule (GET).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));
const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://music.ekaii.fr").replace(/\/$/, "");
const OUT = arg("out", "/e2e/access-audit/out-tor");
const PROXY = arg("proxy", "socks5://127.0.0.1:9055");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { url: URL, proxy: PROXY, events: [] };
(async () => {
  const browser = await chromium.launch({ proxy: { server: PROXY } });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const resp = [];
  page.on("response", (r) => { resp.push({ ms: Date.now() - t0, s: r.status(), u: r.url().slice(0, 140), ct: (r.headers()["content-type"] || "").slice(0, 40), setCookie: (r.headers()["set-cookie"] || "").slice(0, 160) }); });
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) R.events.push({ ms: Date.now() - t0, nav: f.url().slice(0, 140) }); });
  try {
    await page.goto(URL + "/", { waitUntil: "domcontentloaded", timeout: 120000 });
    R.first_doc = { ms: Date.now() - t0, status: resp[0] && resp[0].s, title: await page.title(), text: (await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300))) };
    await page.screenshot({ path: path.join(OUT, "01-challenge.png") }).catch(() => {});
    // attendre que le PoW se resolve et que l'app charge (title != page de challenge ou presence du manifest link)
    let passed = false;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const ok = await page.evaluate(() => !!document.querySelector('link[rel="manifest"]') || /Beatbump/i.test(document.title)).catch(() => false);
      if (ok) { passed = true; break; }
    }
    R.pow = { passed, ms_total: Date.now() - t0, title: await page.title().catch(() => ""), url: page.url() };
    await page.screenshot({ path: path.join(OUT, "02-after.png") }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    R.app_loaded_ms = Date.now() - t0;
    R.cookies = (await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires_days: c.expires > 0 ? +((c.expires - Date.now() / 1000) / 86400).toFixed(2) : c.expires }));
    // manifest tel que Chrome le fetche (sans cookies) vs avec cookies
    R.manifest = await page.evaluate(async () => {
      const f = async (cred) => { try { const r = await fetch("/manifest.json", { credentials: cred, cache: "no-store" }); const t = await r.text(); return { status: r.status, ct: r.headers.get("content-type"), isJson: t.trim().startsWith("{"), head: t.slice(0, 80) }; } catch (e) { return { error: String(e) }; } };
      return { omit: await f("omit"), same_origin: await f("same-origin") };
    }).catch((e) => ({ error: String(e) }));
    // sous-ressources : statuts != 200
    R.non200 = resp.filter((r) => r.s !== 200 && r.s !== 304 && r.s !== 206).slice(0, 30);
    R.setCookies = resp.filter((r) => r.setCookie).map((r) => ({ ms: r.ms, u: r.u, setCookie: r.setCookie })).slice(0, 10);
    R.responses_sample = resp.slice(0, 12);
    // revenir : nouvelle navigation, le cookie doit passer sans PoW
    const t1 = Date.now();
    await page.goto(URL + "/library", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    R.return_visit = { ms: Date.now() - t1, title: await page.title().catch(() => ""), hasManifest: await page.evaluate(() => !!document.querySelector('link[rel="manifest"]')).catch(() => null) };
  } catch (e) {
    R.error = String((e && e.message) || e).split("\n")[0];
    await page.screenshot({ path: path.join(OUT, "99-error.png") }).catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(R, null, 2));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
