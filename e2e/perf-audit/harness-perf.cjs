// ytm-e2e-perf: Web Vitals reels + inventaire reseau de music.ekaii.fr (staging), navigateur reel.
// Conventions de harness.cjs (--url, --out, --query, --resolver). Lance DEPUIS la box via
//   docker run --rm --network host -v $E2E:/e2e -w /e2e mcr.microsoft.com/playwright:v1.47.0-jammy \
//     node perf-audit/harness-perf.cjs --url=https://staging-music.ekaii.fr --out=/e2e/perf-audit/out/<ts> \
//     --resolver="MAP *.ekaii.fr 127.0.0.1" --repeat=3
// Mesures: navigation timing (TTFB, DCL, load), LCP/FCP via PerformanceObserver, transfert total,
// nb requetes par type, taille precache SW (cache ytm-shell-*), doublons d'API (player.json x N),
// requetes tierces (analytics.example.org), temps recherche->premier son (audio.currentTime>0).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));

const arg = (k, d = "") =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const OUT = arg("out", "/out");
const QUERY = arg("query", "daft punk");
const RESOLVER = arg("resolver", "");
const REPEAT = parseInt(arg("repeat", "3"), 10) || 3;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const VITALS_INIT = `
  window.__vitals = { lcp: null, fcp: null, cls: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__vitals.lcp = e.renderTime || e.loadTime || e.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__vitals.fcp = e.startTime; })
      .observe({ type: "paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__vitals.cls += e.value; })
      .observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
`;

async function launch() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"];
  if (RESOLVER) args.push(`--host-resolver-rules=${RESOLVER}`);
  return chromium.launch({ headless: true, args });
}

function classify(u, ct) {
  if (/stats\.eternel\.eu|umami|plausible/.test(u)) return "third-party";
  if (/\/api\/v1\//.test(u)) return "api";
  if (/\/(localf|vp|aud)\b/.test(u) || /googlevideo/.test(u)) return "audio";
  if (/\/cover\?|i\.ytimg|lh3\.googleusercontent|\.(png|jpe?g|webp|gif|svg)(\?|$)/.test(u) || /^image\//.test(ct || "")) return "image";
  if (/\.js(\?|$)/.test(u)) return "js";
  if (/\.css(\?|$)/.test(u)) return "css";
  if (/\.woff2?(\?|$)/.test(u)) return "font";
  return "other";
}

async function coldLoad(browser, label, opts = {}) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, userAgent: "Mozilla/5.0 (Macintosh) Chrome/128 ytm-perf", viewport: { width: 1280, height: 800 }, serviceWorkers: opts.sw === false ? "block" : "allow" });
  await ctx.addInitScript(VITALS_INIT);
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => reqs.push({ url: r.url(), method: r.method(), rt: r.resourceType(), t: Date.now(), sw: r.serviceWorker() != null }));
  const resps = new Map();
  page.on("response", async (r) => {
    try {
      const h = r.headers();
      let len = parseInt(h["content-length"] || "0", 10);
      if (!len) { try { len = (await r.body()).length; } catch { len = 0; } }
      resps.set(r.url(), { status: r.status(), enc: h["content-encoding"] || "", cc: h["cache-control"] || "", etag: h["etag"] || "", ct: h["content-type"] || "", len, fromSW: r.fromServiceWorker() });
    } catch {}
  });
  const t0 = Date.now();
  await page.goto(URL + "/", { waitUntil: "load", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await sleep(4000); // laisser le SW precache + home.json
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n ? { ttfb: n.responseStart - n.requestStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, transfer: n.transferSize } : null;
  });
  const vitals = await page.evaluate(() => window.__vitals);
  const swCache = await page.evaluate(async () => {
    try {
      const keys = await caches.keys();
      const out = {};
      for (const k of keys) { const c = await caches.open(k); const ks = await c.keys(); let bytes = 0; for (const r of ks) { const res = await c.match(r); if (res) { try { bytes += (await res.clone().arrayBuffer()).byteLength; } catch {} } } out[k] = { entries: ks.length, bytes }; }
      return out;
    } catch (e) { return { error: String(e) }; }
  });
  const byType = {};
  let total = 0;
  const apiCount = {};
  for (const r of reqs) {
    const res = resps.get(r.url) || {};
    const k = classify(r.url, res.ct);
    byType[k] = byType[k] || { n: 0, bytes: 0, fromSW: 0 };
    byType[k].n++; byType[k].bytes += res.len || 0; if (res.fromSW) byType[k].fromSW++;
    total += res.len || 0;
    if (k === "api") { const p = r.url.replace(URL, "").split("?")[0]; apiCount[p] = (apiCount[p] || 0) + 1; }
  }
  const headers = {};
  for (const [u, res] of resps) {
    const p = u.replace(URL, "");
    if (/^\/(_app\/immutable\/(entry|chunks)\/[^/]+|service-worker\.js|api\/v1\/home\.json|cover\?.*|localf.*)$/.test(p) || p === "/") headers[p.slice(0, 60)] = { st: res.status, enc: res.enc, cc: res.cc, etag: !!res.etag, len: res.len, sw: res.fromSW };
  }
  const shot = path.join(OUT, `${label}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  const result = { label, nav, vitals, requests: reqs.length, bytes: total, byType, apiCount, swCache, headers, wall: Date.now() - t0 };
  await ctx.close();
  return result;
}

async function warmLoad(browser, label) {
  // deux navigations dans le meme contexte: la 2e a le SW actif (shell depuis cache)
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, userAgent: "Mozilla/5.0 (Macintosh) Chrome/128 ytm-perf", viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(VITALS_INIT);
  const page = await ctx.newPage();
  await page.goto(URL + "/", { waitUntil: "load", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await sleep(5000);
  const reqs = [];
  const resps = new Map();
  page.on("request", (r) => reqs.push({ url: r.url() }));
  page.on("response", async (r) => { try { const h = r.headers(); let len = parseInt(h["content-length"] || "0", 10); if (!len) { try { len = (await r.body()).length; } catch {} } resps.set(r.url(), { len, fromSW: r.fromServiceWorker(), ct: h["content-type"] }); } catch {} });
  await page.goto(URL + "/", { waitUntil: "load", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await sleep(2000);
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return n ? { ttfb: n.responseStart - n.requestStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } : null; });
  const vitals = await page.evaluate(() => window.__vitals);
  const byType = {}; let total = 0; let fromSW = 0;
  for (const r of reqs) { const res = resps.get(r.url) || {}; const k = classify(r.url, res.ct); byType[k] = byType[k] || { n: 0, bytes: 0, fromSW: 0 }; byType[k].n++; byType[k].bytes += res.len || 0; if (res.fromSW) { byType[k].fromSW++; fromSW++; } total += res.len || 0; }
  const swControlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  await ctx.close();
  return { label, nav, vitals, requests: reqs.length, bytes: total, fromSW, swControlled, byType };
}

async function searchAndPlay(browser, label) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, userAgent: "Mozilla/5.0 (Macintosh) Chrome/128 ytm-perf", viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => reqs.push({ url: r.url(), t: Date.now() }));
  const timings = new Map();
  page.on("response", (r) => { try { timings.set(r.url(), Date.now()); } catch {} });
  await page.goto(URL + "/", { waitUntil: "load", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  const box = page.locator("input[type=search], input[role=searchbox], input[placeholder*='earch' i], input[name*='earch' i]").first();
  if (await box.count() === 0) await page.locator("a[href*='search'], button[aria-label*='earch' i]").first().click({ timeout: 5000 }).catch(() => {});
  const b2 = page.locator("input[type=search], input[placeholder*='earch' i], input").first();
  await b2.click({ timeout: 8000 }); await b2.fill(QUERY);
  const tSearch = Date.now();
  await page.keyboard.press("Enter");
  const sub = page.getByText(/Song\s*•/).first();
  await sub.waitFor({ state: "visible", timeout: 30000 });
  const tResults = Date.now();
  const nBefore = reqs.length;
  const tClick = Date.now();
  await sub.click({ timeout: 8000 });
  let tSound = null; let audio = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    audio = await page.evaluate(() => { const el = window.__ytmMedia || document.querySelector("audio,video"); return el ? { src: (el.currentSrc || el.src || "").slice(0, 120), t: el.currentTime, paused: el.paused, rs: el.readyState } : null; });
    if (audio && audio.t > 0 && !audio.paused) { tSound = Date.now(); break; }
    await sleep(200);
  }
  await sleep(6000); // observer prefetch / doublons apres le demarrage
  const after = reqs.slice(nBefore);
  const apiCount = {};
  for (const r of after) { if (/\/api\/v1\//.test(r.url)) { const p = r.url.replace(URL, "").split("?")[0]; apiCount[p] = (apiCount[p] || 0) + 1; } }
  const playerCalls = after.filter((r) => /player\.json/.test(r.url)).map((r) => r.url.replace(URL, "").slice(0, 90));
  const audioReqs = after.filter((r) => /\/(localf|vp|aud)\b|googlevideo/.test(r.url)).map((r) => r.url.replace(URL, "").slice(0, 80));
  const coverReqs = after.filter((r) => /\/cover\?|ytimg|googleusercontent/.test(r.url)).length;
  const imgs = await page.evaluate(() => Array.from(document.images).map((i) => ({ src: (i.currentSrc || i.src).slice(0, 80), lazy: i.loading, w: i.naturalWidth, h: i.naturalHeight, dw: i.width, dh: i.height })).filter((i) => i.src));
  await page.screenshot({ path: path.join(OUT, `${label}.png`) }).catch(() => {});
  await ctx.close();
  return { label, searchToResultsMs: tResults - tSearch, clickToSoundMs: tSound ? tSound - tClick : null, audio, apiCountAfterClick: apiCount, playerCalls, audioReqs, coverReqs, imgs: imgs.slice(0, 40), imgTotal: imgs.length, imgLazy: imgs.filter((i) => i.lazy === "lazy").length, imgOversized: imgs.filter((i) => i.w > 2 * i.dw && i.dw > 0).length };
}

(async () => {
  const browser = await launch();
  const report = { url: URL, at: new Date().toISOString(), cold: [], warm: [], play: [] };
  try {
    for (let i = 0; i < REPEAT; i++) { console.log("cold", i); report.cold.push(await coldLoad(browser, `cold-${i}`)); }
    for (let i = 0; i < Math.min(REPEAT, 2); i++) { console.log("warm", i); report.warm.push(await warmLoad(browser, `warm-${i}`)); }
    for (let i = 0; i < Math.min(REPEAT, 2); i++) { console.log("play", i); try { report.play.push(await searchAndPlay(browser, `play-${i}`)); } catch (e) { report.play.push({ error: String(e && e.message || e).split("\n")[0] }); } }
  } finally { await browser.close(); }
  const m = (arr, f) => median(arr.map(f).filter((x) => typeof x === "number"));
  report.summary = {
    cold: { ttfb: m(report.cold, (c) => c.nav && c.nav.ttfb), dcl: m(report.cold, (c) => c.nav && c.nav.dcl), load: m(report.cold, (c) => c.nav && c.nav.load), fcp: m(report.cold, (c) => c.vitals && c.vitals.fcp), lcp: m(report.cold, (c) => c.vitals && c.vitals.lcp), cls: m(report.cold, (c) => c.vitals && c.vitals.cls), requests: m(report.cold, (c) => c.requests), bytes: m(report.cold, (c) => c.bytes) },
    warm: { ttfb: m(report.warm, (c) => c.nav && c.nav.ttfb), dcl: m(report.warm, (c) => c.nav && c.nav.dcl), load: m(report.warm, (c) => c.nav && c.nav.load), fcp: m(report.warm, (c) => c.vitals && c.vitals.fcp), lcp: m(report.warm, (c) => c.vitals && c.vitals.lcp), requests: m(report.warm, (c) => c.requests), fromSW: m(report.warm, (c) => c.fromSW) },
    play: { searchToResultsMs: m(report.play, (p) => p.searchToResultsMs), clickToSoundMs: m(report.play, (p) => p.clickToSoundMs) },
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  for (const c of report.cold) console.log("COLD", c.label, JSON.stringify({ nav: c.nav, vitals: c.vitals, requests: c.requests, bytes: c.bytes, byType: c.byType, apiCount: c.apiCount, swCache: c.swCache }));
  for (const c of report.cold.slice(0, 1)) console.log("HEADERS", JSON.stringify(c.headers, null, 1));
  for (const w of report.warm) console.log("WARM", w.label, JSON.stringify({ nav: w.nav, vitals: w.vitals, requests: w.requests, bytes: w.bytes, fromSW: w.fromSW, swControlled: w.swControlled, byType: w.byType }));
  for (const p of report.play) console.log("PLAY", JSON.stringify(p));
})();
