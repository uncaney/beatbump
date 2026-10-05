// access-audit/probe.cjs — audit "acces et comportement" de music.ekaii.fr (lecture seule).
// Lance DEPUIS la box via run-probe.sh (docker playwright --network host, resolver *.ekaii.fr -> 127.0.0.1,
// IP source interne => nopasaran ALLOW : le gate PoW n'est PAS exerce ici, voir gate-tor.cjs).
// Mesure : boot (navigation timing), SW (ready, controller, precache shell taille/nb), manifest,
// requetes externes (ytify/invidious/analytics.example.org), 404, API down (route abort), boot hors-ligne,
// lecture puis coupure reseau, changement de morceau hors-ligne.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));
const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const BASE = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const URL = BASE; // alias historique (les helpers utilisent global.URL via `new (require("url").URL)`)
const NodeURL = require("url").URL;
const OUT = arg("out", "/e2e/access-audit/out");
const QUERY = arg("query", "daft punk");
const RESOLVER = arg("resolver", "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
fs.mkdirSync(OUT, { recursive: true });
const R = { url: URL, steps: [], measures: {} };
let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, label) { const f = `${String(++n).padStart(2, "0")}-${label}.png`; await page.screenshot({ path: path.join(OUT, f) }).catch(() => {}); return f; }
async function step(page, name, fn) {
  const t0 = Date.now();
  try { const d = await fn(); R.steps.push({ name, ok: true, ms: Date.now() - t0, detail: d, shot: await shot(page, name) }); console.log("PASS", name, JSON.stringify(d)); return d; }
  catch (e) { const m = String((e && e.message) || e).split("\n")[0]; R.steps.push({ name, ok: false, ms: Date.now() - t0, detail: m, shot: await shot(page, "FAIL_" + name) }); console.log("FAIL", name, "-", m); return null; }
}
const audioState = (page) => page.evaluate(() => { const el = window.__ytmMedia || document.querySelector("audio,video"); return el ? { src: (el.currentSrc || el.src || "").slice(0, 100), t: el.currentTime, paused: el.paused, rs: el.readyState, err: el.error ? el.error.code : 0 } : null; });
const visibleText = (page) => page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400));

(async () => {
  const args = ["--autoplay-policy=no-user-gesture-required"];
  if (RESOLVER) args.push(`--host-resolver-rules=${RESOLVER}`);
  const browser = await chromium.launch({ args, ignoreHTTPSErrors: true });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  userAgent: UA, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  // Beatbump joue via un Audio() detache (pas de <audio> dans le DOM) : on capture l'element via play().
  await page.addInitScript(() => { const orig = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); }; });
  const reqs = [], failed = [], consoleErr = [];
  page.on("request", (r) => reqs.push({ u: r.url(), m: r.method(), t: r.resourceType() }));
  page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url().slice(0, 140)} :: ${r.failure() && r.failure().errorText}`));
  page.on("response", (r) => { const q = reqs.find((x) => x.u === r.url() && x.s === undefined); if (q) q.s = r.status(); });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErr.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });

  // 1. boot
  await step(page, "boot_home", async () => {
    const t0 = Date.now();
    await page.goto(URL + "/", { waitUntil: "load", timeout: 45000 });
    const load = Date.now() - t0;
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    const idle = Date.now() - t0;
    const nav = await page.evaluate(() => { const e = performance.getEntriesByType("navigation")[0]; return e ? { ttfb: Math.round(e.responseStart), dcl: Math.round(e.domContentLoadedEventEnd), load: Math.round(e.loadEventEnd), transfer: e.transferSize } : null; });
    const fcp = await page.evaluate(() => { const p = performance.getEntriesByName("first-contentful-paint")[0]; return p ? Math.round(p.startTime) : null; });
    const firstApi = reqs.find((r) => /\/api\//.test(r.u));
    R.measures.boot = { load_ms: load, networkidle_ms: idle, nav, fcp_ms: fcp, requests: reqs.length, first_api: firstApi && firstApi.u.replace(URL, "") };
    return R.measures.boot;
  });
  await step(page, "head_meta", async () => page.evaluate(() => ({
    title: document.title,
    themeColor: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content),
    manifest: [...document.querySelectorAll('link[rel="manifest"]')].map((l) => ({ href: l.getAttribute("href"), crossorigin: l.getAttribute("crossorigin") })),
    lang: document.documentElement.lang,
    icons: [...document.querySelectorAll('link[rel*="icon"]')].map((l) => l.getAttribute("href")),
    externalScripts: [...document.scripts].map((s) => s.src).filter((s) => s && !s.startsWith(location.origin)),
  })));
  await step(page, "manifest_fetch", async () => {
    // Chrome fetche le manifest SANS cookies (credentials omit) sauf crossorigin="use-credentials"
    const r = await page.evaluate(async () => { const res = await fetch("/manifest.json", { credentials: "omit" }); const ct = res.headers.get("content-type"); const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { status: res.status, ct, len: txt.length, name: j && j.name, start_url: j && j.start_url, display: j && j.display, icons: j && j.icons && j.icons.map((i) => `${i.sizes}${i.purpose ? "/" + i.purpose : ""}`), hasMaskable: !!(j && j.icons && j.icons.some((i) => /maskable/.test(i.purpose || ""))), id: j && j.id, screenshots: !!(j && j.screenshots) }; });
    return r;
  });
  await step(page, "sw_ready_and_precache", async () => {
    const t0 = Date.now();
    const r = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("sw.ready timeout 20s")), 20000))]);
      let waited = 0; while (!navigator.serviceWorker.controller && waited < 20000) { await new Promise((r) => setTimeout(r, 250)); waited += 250; }
      const out = { scope: reg.scope, controlled: !!navigator.serviceWorker.controller, waiting: !!reg.waiting, updateViaCache: reg.updateViaCache, caches: {} };
      // laisser le precache se terminer
      let stable = 0, last = -1;
      for (let i = 0; i < 60; i++) { const ks = await caches.keys(); const sh = ks.find((k) => k.startsWith("ytm-shell-")); const c = sh ? await caches.open(sh) : null; const nn = c ? (await c.keys()).length : 0; if (nn === last) stable++; else stable = 0; last = nn; if (stable >= 6) break; await new Promise((r) => setTimeout(r, 500)); }
      for (const k of await caches.keys()) { const c = await caches.open(k); const keys = await c.keys(); let bytes = 0; for (const key of keys) { const res = await c.match(key); if (res) { try { bytes += (await res.clone().blob()).size; } catch {} } } out.caches[k] = { entries: keys.length, bytes, sample: keys.slice(0, 3).map((x) => x.url.replace(location.origin, "")) }; }
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      out.storageEstimate = est && { usage: est.usage, quota: est.quota };
      return out;
    });
    r.ms_to_stable = Date.now() - t0;
    R.measures.sw = r;
    return r;
  });
  await step(page, "external_hosts", async () => {
    const origin = new NodeURL(BASE).host;
    const ext = {}; for (const r of reqs) { const h = new NodeURL(r.u).host; if (h !== origin) ext[h] = (ext[h] || 0) + 1; }
    const legacy = reqs.filter((r) => /ytify\.ekaii|invidious\.ekaii|stats\.eternel|googlevideo/.test(r.u)).map((r) => `${r.s || "?"} ${r.u.slice(0, 120)}`);
    const non200 = reqs.filter((r) => r.s && r.s >= 400).map((r) => `${r.s} ${r.u.replace(URL, "").slice(0, 120)}`);
    R.measures.external = { hosts: ext, legacy, non200, failed: failed.slice(0, 20), consoleErr: consoleErr.slice(0, 20) };
    return R.measures.external;
  });
  await step(page, "not_found_page", async () => {
    await page.goto(URL + "/cette-page-nexiste-pas", { waitUntil: "networkidle", timeout: 30000 });
    const t = await visibleText(page); const st = reqs.filter((r) => /cette-page-nexiste-pas/.test(r.u)).map((r) => r.s);
    await sleep(7000); // +error.svelte : "Redirecting in 6"
    return { http: st, text: t.slice(0, 200), url_after_7s: page.url() };
  });
  // API down : contexte SANS service worker (Playwright n'intercepte pas les fetch faits par le SW),
  // donc c'est le comportement "premiere visite / SW absent" face a un companion/bridge HS.
  {
    const ctx2 = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  userAgent: UA, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
    const p2 = await ctx2.newPage();
    const errs2 = []; p2.on("console", (m) => { if (m.type() === "error") errs2.push(m.text().slice(0, 160)); }); p2.on("pageerror", (e) => errs2.push("PAGEERROR " + String(e.message || e).slice(0, 160)));
    await step(p2, "api_down_502_home", async () => {
      await ctx2.route("**/api/v1/**", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>502 Bad Gateway</h1>" }));
      await p2.goto(BASE + "/home", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      await sleep(2500);
      return { text: (await visibleText(p2)).slice(0, 250), errors: errs2.slice(-3) };
    });
    await step(p2, "api_down_refused_search", async () => {
      await ctx2.unroute("**/api/v1/**");
      await ctx2.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
      await p2.goto(BASE + "/search/" + encodeURIComponent(QUERY) + "?filter=", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      await sleep(2500);
      return { text: (await visibleText(p2)).slice(0, 250), errors: errs2.slice(-3) };
    });
    await step(p2, "audio_bridge_down_play", async () => {
      await ctx2.unroute("**/api/v1/**");
      await ctx2.route(/\/(localf|vp|aud)\b/, (route) => route.fulfill({ status: 502, contentType: "text/html", body: "bridge down" }));
      await p2.addInitScript(() => { const orig = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); }; });
      await p2.goto(BASE + "/search/" + encodeURIComponent(QUERY) + "?filter=", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      const sub = p2.getByText(/Song\s*•/).first(); await sub.waitFor({ state: "visible", timeout: 15000 }); await sub.click({ timeout: 8000 });
      await sleep(8000);
      return { audio: await audioState(p2), text: (await visibleText(p2)).slice(0, 250), errors: errs2.slice(-3) };
    });
    await ctx2.close();
  }
  // 2. hors-ligne : boot depuis le SW
  await step(page, "offline_boot_home", async () => {
    await page.goto(URL + "/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
    await ctx.setOffline(true);
    const t0 = Date.now();
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await sleep(2500);
    const t = await visibleText(page);
    const r = { load_ms: Date.now() - t0, text: t.slice(0, 250), url: page.url() };
    await ctx.setOffline(false);
    return r;
  });
  await step(page, "offline_boot_deep_link", async () => {
    await ctx.setOffline(true);
    const t0 = Date.now();
    await page.goto(URL + "/library", { waitUntil: "load", timeout: 30000 });
    await sleep(2500);
    const t = await visibleText(page);
    const r = { load_ms: Date.now() - t0, text: t.slice(0, 250), url: page.url() };
    await ctx.setOffline(false);
    return r;
  });
  await step(page, "offline_uncached_route_ux", async () => {
    await ctx.setOffline(true);
    await page.goto(URL + "/trending", { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const t = await visibleText(page);
    await ctx.setOffline(false);
    return { text: t.slice(0, 250) };
  });
  // 3. lecture + coupure reseau
  await step(page, "play_track", async () => {
    await page.goto(URL + "/", { waitUntil: "networkidle", timeout: 30000 });
    const box = page.locator("input[type=search], input[role=searchbox], input[placeholder*='earch' i], input[name*='earch' i]").first();
    if ((await box.count()) === 0) await page.locator("a[href*='search'], button[aria-label*='earch' i]").first().click({ timeout: 5000 }).catch(() => {});
    const b2 = page.locator("input[type=search], input[placeholder*='earch' i], input").first();
    await b2.click({ timeout: 8000 }); await b2.fill(QUERY); await page.keyboard.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const sub = page.getByText(/Song\s*•/).first();
    await sub.waitFor({ state: "visible", timeout: 15000 });
    await sub.click({ timeout: 8000 });
    let st = null; for (let i = 0; i < 60; i++) { await sleep(500); st = await audioState(page); if (st && st.t > 1 && !st.paused) break; }
    if (!st || !st.src) throw new Error("no media after click: " + JSON.stringify(st));
    // laisser l'auto-cache + prefetch du suivant travailler
    await sleep(8000);
    const cached = await page.evaluate(async () => { const c = await caches.open("ytm-offline-audio"); return (await c.keys()).map((k) => k.url.replace(location.origin, "").slice(0, 80)); });
    return { audio: st, cached };
  });
  await step(page, "network_cut_during_playback", async () => {
    const a = await audioState(page);
    await ctx.setOffline(true);
    await sleep(6000);
    const b = await audioState(page);
    const t = await visibleText(page);
    return { before: a, after6s_offline: b, still_advancing: b && a && b.t > a.t + 3, text: t.slice(0, 200) };
  });
  await step(page, "next_track_offline", async () => {
    const before = await audioState(page);
    const nextBtn = page.locator("[aria-label*='next' i], [title*='next' i], [aria-label*='suivant' i]").first();
    const n = await nextBtn.count();
    if (n) await nextBtn.click({ timeout: 5000 });
    else await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /next|suivant/i.test(x.getAttribute("aria-label") || x.title || x.textContent || "")); if (b) b.click(); else throw new Error("no next button"); });
    await sleep(8000);
    const st = await audioState(page); const t = await visibleText(page);
    return { before, after: st, src_changed: !!(before && st && before.src !== st.src), text: t.slice(0, 200), consoleErrTail: consoleErr.slice(-3) };
  });
  await step(page, "network_back_resume", async () => {
    await ctx.setOffline(false);
    await sleep(6000);
    const st = await audioState(page);
    return st;
  });
  // 4. sessions
  await step(page, "session_cookies", async () => {
    const cs = await ctx.cookies();
    return cs.map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires_days: c.expires > 0 ? Math.round((c.expires - Date.now() / 1000) / 86400) : c.expires }));
  });
  await step(page, "account_page", async () => {
    await page.goto(URL + "/library/account", { waitUntil: "networkidle", timeout: 30000 });
    const t = await visibleText(page);
    const ls = await page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${(localStorage.getItem(k) || "").length}B`));
    return { text: t.slice(0, 350), localStorageKeys: ls };
  });
  R.measures.requests_total = reqs.length;
  R.measures.failed_total = failed.length;
  R.measures.console_errors = consoleErr;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(R, null, 2));
  await browser.close();
  console.log("REPORT", path.join(OUT, "report.json"));
})();
