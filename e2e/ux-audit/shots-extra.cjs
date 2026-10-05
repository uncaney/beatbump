// ux-audit/shots-extra.cjs — complement de shots.cjs : page album directe, /lyrics direct apres lecture,
// menu ⋮ d'une rangee de resultats, verification manifest/icônes PWA. Memes conventions.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const arg = (k, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const BASE = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const OUT = arg("out", path.join(__dirname, "out", new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-extra"));
const ALBUM = arg("album", "/release?id=MPREb_7ltM34kr0mH"); // Daft Punk - Discovery
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metrics = {};
(async () => {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  // PWA
  const c0 = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" } }); const p0 = await c0.newPage();
  const r = await p0.goto(BASE + "/manifest.json"); const man = await r.json();
  const icons = [];
  for (const ic of man.icons || []) { const rr = await p0.request.get(new globalThis.URL(ic.src, BASE + "/").href); icons.push({ src: ic.src, sizes: ic.sizes, purpose: ic.purpose || null, status: rr.status(), type: rr.headers()["content-type"] }); }
  metrics.pwa = { name: man.name, short_name: man.short_name, display: man.display, theme_color: man.theme_color, background_color: man.background_color, start_url: man.start_url, lang: man.lang || null, description: man.description, icons, maskable: (man.icons || []).some((i) => /maskable/.test(i.purpose || "")) };
  const html = await (await p0.goto(BASE + "/home")).text();
  metrics.head = { theme_color: (html.match(/name="theme-color"\s+content="([^"]+)"/) || [])[1], lang: (html.match(/<html[^>]*lang="([^"]+)"/) || [])[1], viewport: (html.match(/name="viewport"\s+content="([^"]+)"/) || [])[1], apple_status_bar: [...html.matchAll(/apple-mobile-web-app-status-bar-style"\s+content="([^"]+)"/g)].map((m) => m[1]) };
  await c0.close();
  for (const vp of [{ name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { name: "desktop", viewport: { width: 1280, height: 900 } }]) {
    const ctx = await browser.newContext({ ...vp, extraHTTPHeaders: { "X-Ytm-Harness": "1" } }); const page = await ctx.newPage();
    await page.addInitScript(() => { const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return o.apply(this, arguments); }; });
    await page.route("**/analytics.example.org/**", (r) => r.abort()).catch(() => {});
    const shot = async (l, full) => { const f = `${vp.name}-x-${l}.png`; await page.screenshot({ path: path.join(OUT, f), fullPage: !!full }).catch(() => {}); console.log("SHOT", f); };
    await page.goto(BASE + ALBUM, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {}); await sleep(2000);
    await shot("album"); await shot("album_full", true);
    metrics[vp.name + "/album_h1"] = await page.evaluate(() => [...document.querySelectorAll("h1,h2")].map((h) => h.innerText.trim().slice(0, 50)).slice(0, 4));
    // lecture depuis l'album : premiere rangee
    const row = page.locator("article.m-item").first();
    if (await row.count()) { await row.click({ timeout: 8000 }).catch(() => {}); await sleep(5000); }
    metrics[vp.name + "/album_played"] = await page.evaluate(() => { const el = window.__ytmMedia; return el ? { src: (el.currentSrc || "").slice(0, 60), t: el.currentTime } : null; });
    await shot("album_playing");
    // menu ⋮ d'une rangee
    const dd = page.locator("article.m-item .dd-button").first();
    if (await dd.count()) { await dd.click({ timeout: 4000 }).catch(() => {}); await sleep(700); await shot("row_menu"); await page.keyboard.press("Escape").catch(() => {}); await sleep(300); }
    // lyrics direct
    await page.goto(BASE + "/lyrics", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {}); await sleep(2500);
    await shot("lyrics"); await shot("lyrics_full", true);
    metrics[vp.name + "/lyrics_text"] = await page.evaluate(() => (document.querySelector("main") || document.body).innerText.slice(0, 300));
    // file d'attente : plein ecran puis panneau queue
    await page.locator(".player .now-playing").first().click({ timeout: 4000 }).catch(() => {}); await sleep(1500);
    await shot("fullscreen_again");
    metrics[vp.name + "/fullscreen_top_buttons"] = await page.evaluate(() => [...document.querySelectorAll(".fullscreen-player-popup button, .fullscreen-player-popup [role=button]")].filter((b) => { const r = b.getBoundingClientRect(); return r.top < 120 && r.width > 0; }).map((b) => { const r = b.getBoundingClientRect(); return { name: b.getAttribute("aria-label") || b.innerText.trim().slice(0, 20), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }));
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
  console.log("done ->", OUT);
})();
