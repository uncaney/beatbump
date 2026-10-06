// ux-audit/shots.cjs — captures d'ecran des ecrans cles de l'instance (staging) en mobile
// 390x844 et desktop 1280x900, + metriques UX brutes (zones tactiles < 44px, boutons sans nom
// accessible, contrastes faibles, textes < 12px, lang, manifest, erreurs console).
// Meme mecanique que e2e/harness-offline.cjs (Playwright dans l'image mcr playwright, --network host,
// --host-resolver-rules pour contourner le hairpin). Lecture seule sur l'app.
// PF3-13 / PF4-8 (cycle 38): each per-screen metrics object also carries the network counters of the
// screen, counted since the last go() navigation (several shots after one navigation share them):
//   requests   requests issued by the page (SW-served ones included, see swServed)
//   swServed   responses answered by the service worker (not network traffic, PF4-5)
//   bytes      transferred bytes (encoded body + headers) of finished requests NOT served by the SW
//   failed     requestfailed events + responses with status >= 400 (the aborted analytics excluded)
//   failedUrls first 5 of them, "<status|errorText> <url>"
//   lcpMs      largest-contentful-paint startTime of the current document (PerformanceObserver
//              injected before navigation), null when unsupported or nothing painted
// run: docker run --rm --network host -v "$PWD":/e2e -w /e2e \
//        -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright mcr.microsoft.com/playwright:v1.47.0-jammy node ux-audit/shots.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));

const arg = (k, d = "") =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "http://127.0.0.1:8080").replace(/\/$/, "");
const QUERY = arg("query", "daft punk");
const RESOLVER = arg("resolver", process.env.HARNESS_RESOLVER || ""); // e.g. "MAP *.example.org 127.0.0.1"
const BLOCK = arg("block", process.env.YTM_ANALYTICS_HOST ? new globalThis.URL(process.env.YTM_ANALYTICS_HOST).host : ""); // analytics host to abort (empty = none)
const TS = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const OUT = arg("out", path.join(__dirname, "out", TS));
const ONLY = arg("only", ""); // "mobile" | "desktop" | ""
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" },
  { name: "desktop", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
].filter((v) => !ONLY || v.name === ONLY);

const shots = [];
const metrics = {};
const consoleErrors = {};

// ---- compteurs reseau par ecran (PF3-13) : remis a zero a chaque go() ------------------------
const IGNORED_FAIL_RE = BLOCK ? new RegExp(BLOCK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /(?!)/; // aborted on purpose (page.route below)
function instrument(page) {
  const st = { gen: 0, requests: 0, swServed: 0, bytes: 0, failed: 0, failedUrls: [], pending: new Set() };
  const genOf = new WeakMap();
  const fail = (what, url) => { st.failed++; if (st.failedUrls.length < 5) st.failedUrls.push(`${what} ${url.slice(0, 160)}`); };
  page.on("request", (r) => { genOf.set(r, st.gen); st.requests++; });
  page.on("response", (r) => {
    const req = r.request();
    if (genOf.get(req) !== st.gen) return;
    if (r.fromServiceWorker()) st.swServed++;
    if (r.status() >= 400 && !IGNORED_FAIL_RE.test(r.url())) fail(String(r.status()), r.url());
  });
  page.on("requestfinished", (r) => {
    const g = genOf.get(r);
    if (g !== st.gen) return;
    const p = (async () => {
      const resp = await r.response().catch(() => null);
      if (resp && resp.fromServiceWorker()) return;
      const s = await r.sizes().catch(() => null);
      if (s && g === st.gen) st.bytes += Math.max(0, s.responseBodySize || 0) + Math.max(0, s.responseHeadersSize || 0);
    })().catch(() => {});
    st.pending.add(p); p.finally(() => st.pending.delete(p));
  });
  page.on("requestfailed", (r) => {
    if (genOf.get(r) !== st.gen || IGNORED_FAIL_RE.test(r.url())) return;
    fail((r.failure() && r.failure().errorText) || "failed", r.url());
  });
  st.reset = () => { st.gen++; st.requests = 0; st.swServed = 0; st.bytes = 0; st.failed = 0; st.failedUrls = []; st.pending = new Set(); };
  st.snapshot = async () => {
    await Promise.race([Promise.all([...st.pending]), sleep(3000)]);
    return { requests: st.requests, swServed: st.swServed, bytes: st.bytes, failed: st.failed, failedUrls: st.failedUrls.slice() };
  };
  page.__ux = st;
  return st;
}
// Injected before every navigation: the latest LCP candidate of the document, null if none.
function lcpInitScript() {
  try {
    window.__uxLcp = null;
    new PerformanceObserver((list) => { const e = list.getEntries(); if (e.length) window.__uxLcp = e[e.length - 1].startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) { window.__uxLcp = null; }
}

// ---- metriques UX brutes, evaluees dans la page ---------------------------------------------
async function collect(page, key) {
  const m = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    };
    const name = (el) =>
      (el.getAttribute("aria-label") || el.getAttribute("title") || (el.querySelector("img[alt]") || {}).alt || el.innerText || "").trim().slice(0, 40);
    const inter = [...document.querySelectorAll("a[href],button,[role=button],input,select,textarea,[tabindex='0']")].filter(vis);
    const small = inter
      .map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), name: name(el), w: Math.round(r.width), h: Math.round(r.height), cls: (el.className && String(el.className).slice(0, 40)) || "" }; })
      .filter((x) => x.w < 44 || x.h < 44);
    const unlabeled = inter.filter((el) => /^(button|a)$/i.test(el.tagName) || el.getAttribute("role") === "button").filter((el) => !name(el))
      .map((el) => ({ tag: el.tagName.toLowerCase(), cls: (el.className && String(el.className).slice(0, 60)) || "", html: el.outerHTML.slice(0, 120) }));
    const imgsNoAlt = [...document.querySelectorAll("img")].filter(vis).filter((i) => !i.hasAttribute("alt")).length;
    // textes petits + contrastes
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const bgOf = (el) => {
      let e = el; let acc = null;
      while (e && e !== document.documentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) { acc = acc ? blend(acc, c) : c; if (c.a >= 1 || (acc && acc.a >= 1)) return acc; }
        e = e.parentElement;
      }
      const root = parse(getComputedStyle(document.body).backgroundColor) || { r: 14, g: 17, b: 23, a: 1 };
      return acc ? blend(acc, root) : root;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const small_text = [], low_contrast = []; const seen = new Set(); let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent.trim(); if (!t || t.length < 2) continue;
      const el = n.parentElement; if (!el || !vis(el) || seen.has(el)) continue; seen.add(el);
      const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize);
      const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) continue;
      if (fs < 12) small_text.push({ text: t.slice(0, 40), px: fs });
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el); const f2 = fg.a < 1 ? blend(fg, bg) : fg;
      // opacity heritee approx : on applique l'opacite de l'element et de ses 3 parents
      let op = 1, e2 = el; for (let i = 0; i < 4 && e2; i++, e2 = e2.parentElement) op *= parseFloat(getComputedStyle(e2).opacity || "1");
      const f3 = op < 1 ? blend({ ...f2, a: op }, bg) : f2;
      const L1 = lum(f3), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) low_contrast.push({ text: t.slice(0, 40), px: fs, ratio: +ratio.toFixed(2), fg: cs.color, op: +op.toFixed(2) });
    }
    return {
      url: location.href, title: document.title, lang: document.documentElement.lang,
      h1: [...document.querySelectorAll("h1")].map((h) => h.innerText.trim().slice(0, 60)),
      interactive: inter.length, small_targets: small.length, small_sample: small.slice(0, 25),
      unlabeled_buttons: unlabeled.length, unlabeled_sample: unlabeled.slice(0, 12),
      imgs_without_alt: imgsNoAlt, small_text: small_text.slice(0, 15), low_contrast: low_contrast.slice(0, 25),
      body_scroll_w: document.documentElement.scrollWidth, inner_w: innerWidth,
      hscroll: document.documentElement.scrollWidth > innerWidth + 1,
    };
  }).catch((e) => ({ error: String(e.message || e) }));
  if (page.__ux) Object.assign(m, await page.__ux.snapshot());
  m.lcpMs = await page.evaluate(() => (typeof window.__uxLcp === "number" ? Math.round(window.__uxLcp) : null)).catch(() => null);
  metrics[key] = m;
  return m;
}

async function shot(page, vp, label, opts = {}) {
  const f = `${vp}-${String(shots.filter((s) => s.vp === vp).length + 1).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: path.join(OUT, f), fullPage: !!opts.fullPage }).catch((e) => console.log("shot fail", f, e.message));
  shots.push({ vp, label, file: f, url: page.url() });
  console.log("SHOT", f);
  if (opts.metrics !== false) await collect(page, `${vp}/${label}`);
  return f;
}
async function go(page, p, wait = "networkidle", extra = 1200) {
  if (page.__ux) page.__ux.reset(); // per-screen counters start with the navigation
  const r = await page.goto(p.startsWith("http") ? p : URL + p, { waitUntil: wait, timeout: 45000 }).catch((e) => { console.log("goto", p, e.message.split("\n")[0]); return null; });
  await sleep(extra);
  return r;
}
async function audioState(page) {
  return page.evaluate(() => { const el = window.__ytmMedia; return el ? { src: (el.currentSrc || el.src || "").slice(0, 60), t: el.currentTime, paused: el.paused } : null; });
}
async function pollUntil(fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  return last;
}

async function runViewport(browser, vpdef) {
  const vp = vpdef.name;
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ...vpdef, acceptDownloads: true });
  const page = await ctx.newPage();
  consoleErrors[vp] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors[vp].push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors[vp].push("PAGEERROR " + String((e && e.message) || e).slice(0, 200)));
  await page.addInitScript(() => {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); };
  });
  await page.addInitScript(lcpInitScript);
  instrument(page);
  if (BLOCK) await page.route(`**/${BLOCK}/**`, (r) => r.abort()).catch(() => {});

  // 1. accueil
  await go(page, "/home");
  await shot(page, vp, "home");
  await shot(page, vp, "home_full", { fullPage: true, metrics: false });
  // focus visible : 3 tabulations
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await sleep(300);
  metrics[`${vp}/focus_after_3_tabs`] = await page.evaluate(() => {
    const a = document.activeElement; if (!a) return null; const cs = getComputedStyle(a);
    return { tag: a.tagName, name: a.getAttribute("aria-label") || a.innerText.slice(0, 30), outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor, boxShadow: cs.boxShadow.slice(0, 60) };
  });
  await shot(page, vp, "home_focus_tab3", { metrics: false });
  // overlay de recherche (bouton loupe)
  await page.locator("button[aria-label='Search']").first().click({ timeout: 5000 }).catch(() => {});
  await sleep(700);
  await shot(page, vp, "search_overlay");
  await page.keyboard.press("Escape").catch(() => {});

  // "Plus pour toi" toggle (audit v11 §2.11 / brief): open, capture, then re-collapse
  // so later home captures (home_with_player) keep the default, pre-toggle layout.
  const moreRows = page.locator("[data-testid=home-more-rows]").first();
  if (await moreRows.count()) {
    await moreRows.click({ timeout: 4000 }).catch(() => {});
    await sleep(500);
    await shot(page, vp, "home_more_rows_open");
    await moreRows.click({ timeout: 4000 }).catch(() => {}); // re-collapse
    await sleep(300);
  }

  // 2. bibliotheque, hors-ligne (vide), reglages, 404
  await go(page, "/library");
  await shot(page, vp, "library");
  await go(page, "/library/albums");
  await shot(page, vp, "library_albums");
  await go(page, "/library/albums?filter=never-played");
  await shot(page, vp, "library_albums_never_played");
  await go(page, "/library/for-you");
  await shot(page, vp, "library_for_you");
  await go(page, "/library/genres");
  await shot(page, vp, "library_genres");
  await go(page, "/library/mixes");
  await shot(page, vp, "library_mixes");
  await go(page, "/library/rediscover");
  await shot(page, vp, "library_rediscover");
  await go(page, "/about");
  await shot(page, vp, "about");
  // page playlist serveur (audit v11 §2.11): logge "harness" seulement si la liste est
  // vide sans session (profil invite par defaut), puis ouvre une playlist si l'API en rend une.
  await go(page, "/library/playlists-srv");
  await shot(page, vp, "library_playlists_srv");
  try {
    let pls = await page.evaluate(async () => { const r = await fetch("/api/v1/me/playlists"); return r.ok ? r.json() : null; });
    if (!pls || !Array.isArray(pls.playlists) || !pls.playlists.length) {
      await page.evaluate(async () => { await fetch("/api/v1/me/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "harness" }) }); }).catch(() => {});
      await go(page, "/library/playlists-srv");
      await shot(page, vp, "library_playlists_srv_loggedin");
      pls = await page.evaluate(async () => { const r = await fetch("/api/v1/me/playlists"); return r.ok ? r.json() : null; });
    }
    const list = (pls && Array.isArray(pls.playlists)) ? pls.playlists : [];
    metrics[`${vp}/playlists_srv_count`] = list.length;
    const pl0 = list[0];
    if (pl0 && pl0.id) {
      await go(page, "/library/playlists-srv/" + encodeURIComponent(pl0.id));
      await shot(page, vp, "library_playlists_srv_detail");
    }
  } catch (e) { metrics[`${vp}/playlists_srv_error`] = String(e.message || e).slice(0, 120); }
  await go(page, "/library/downloads-offline");
  await shot(page, vp, "offline_empty");
  await go(page, "/settings");
  await shot(page, vp, "settings");
  // le conteneur de scroll reel est #wrapper (overflow-y:auto, voir _layout.scss) ; document.body
  // ne defile jamais, d'ou la capture "bas de Reglages" identique au haut (notes harness v11 §4).
  await page.evaluate(() => { const w = document.getElementById("wrapper"); if (w) w.scrollTop = w.scrollHeight; }).catch(() => {});
  await sleep(600);
  await shot(page, vp, "settings_bottom");
  metrics[`${vp}/offline_persisted`] = await page.locator("#offline-persisted").first().innerText().then((t) => t.replace(/\s+/g, " ").trim()).catch(() => null);
  const r404 = await go(page, "/cette-page-n-existe-pas", "domcontentloaded", 600);
  metrics[`${vp}/404_status`] = r404 ? r404.status() : null;
  await shot(page, vp, "not_found");
  const rBadId = await go(page, "/artist/UCxxxxxxxxxxxxxxxxxxxxxx", "domcontentloaded", 1500);
  metrics[`${vp}/artist_bad_id_status`] = rBadId ? rBadId.status() : null;
  await shot(page, vp, "artist_bad_id");
  await go(page, "/lyrics");
  await shot(page, vp, "lyrics_no_track");

  // 3. recherche
  await go(page, "/search/" + encodeURIComponent(QUERY), "networkidle", 2000);
  await shot(page, vp, "search_results");
  await shot(page, vp, "search_results_full", { fullPage: true, metrics: false });
  const hrefs = await page.evaluate(() => ({
    artist: ([...document.querySelectorAll("a[href^='/artist/']")][0] || {}).getAttribute?.("href") || null,
    album: ([...document.querySelectorAll("a[href^='/release'],a[href^='/playlist/']")][0] || {}).getAttribute?.("href") || null,
    chips: [...document.querySelectorAll("a,button")].map((e) => e.innerText.trim()).filter((t) => /^(Songs|Albums|Artists|Videos|Playlists|Community|Featured|Top result|All)$/i.test(t)),
  }));
  metrics[`${vp}/search_links`] = hrefs;

  // 4. artiste
  if (hrefs.artist) {
    await go(page, hrefs.artist, "networkidle", 2000);
    await shot(page, vp, "artist");
    await shot(page, vp, "artist_full", { fullPage: true, metrics: false });
    if (!hrefs.album) hrefs.album = await page.evaluate(() => ([...document.querySelectorAll("a[href^='/release']")][0] || {}).getAttribute?.("href") || null);
  }
  // 5. album
  if (hrefs.album) {
    await go(page, hrefs.album, "networkidle", 2000);
    await shot(page, vp, "album");
    await shot(page, vp, "album_full", { fullPage: true, metrics: false });
  }

  // 6. lecture depuis les resultats de recherche
  await go(page, "/search/" + encodeURIComponent(QUERY), "networkidle", 1500);
  const row = page.getByText(/Song\s*•/).first();
  let played = null;
  if (await row.count()) {
    await row.click({ position: { x: 8, y: 8 }, timeout: 8000 }).catch((e) => console.log("row click", e.message.split("\n")[0])); // left edge: artist links have a 26 px tap box
    played = await pollUntil(async () => { const s = await audioState(page); return s && s.src ? s : null; }, 25000);
  }
  metrics[`${vp}/played`] = played;
  await sleep(4000);
  await shot(page, vp, "player_bar");
  // menu contextuel ⋮ d'une rangee (si present)
  // plein ecran : zone "now playing" de la barre
  // footer img first: since cycle 17 the artist link in the mini-bar navigates instead of toggling (harness parity)
  const fsTriggers = ["footer img", ".player img", ".now-playing", "[aria-label*='expand' i]", "[aria-label*='fullscreen' i]"];
  for (const sel of fsTriggers) {
    const l = page.locator(sel).first();
    if (await l.count()) { await l.click({ timeout: 4000 }).catch(() => {}); await sleep(1500); break; }
  }
  const fsOpen = await page.evaluate(() => { const el = document.querySelector(".fullscreen-player-popup"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).opacity !== "0"; });
  metrics[`${vp}/fullscreen_opened`] = fsOpen;
  await shot(page, vp, "player_fullscreen");
  // Related tab (audit v3 3.6): the fullscreen is open here
  try {
    const rel = page.getByText(/^related$/i).first();
    if (await rel.count()) { await rel.click({ timeout: 4000 }); await sleep(2500); await shot(page, vp, "related_tab"); }
    const up = page.getByText(/^up next$/i).first();
    if (await up.count()) await up.click({ timeout: 3000 }).catch(() => {});
  } catch (e) { /* no related tab */ }
  // paroles depuis le plein ecran / la barre
  const lyr = page.locator("button[aria-label='Lyrics']").last();
  if (await lyr.count()) { await lyr.click({ timeout: 4000 }).catch(() => {}); await sleep(2500); }
  await shot(page, vp, "lyrics");
  // Lyrics with a track (audit v3 3.7): go through the fullscreen Paroles button so the queue survives
  try {
    const fsl = page.locator('[data-testid="fullscreen-lyrics"]').first();
    if (await fsl.isVisible().catch(() => false)) {
      await fsl.click({ timeout: 4000 }); await sleep(3000); await shot(page, vp, "lyrics_with_track");
      // Audit UX v5 TOP 1: record whether the fullscreen popup is still painted over /lyrics.
      metrics[`${vp}/fullscreen_over_lyrics`] = await page.evaluate(() => {
        const el = document.querySelector(".fullscreen-player-popup"); if (!el) return null;
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        return { url: location.pathname, over: r.height > 300 && r.top < innerHeight - 100 && r.bottom > 100 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.5, top: Math.round(r.top), vis: cs.visibility, state: el.getAttribute("data-state") };
      }).catch(() => null);
    }
    else {
      // Desktop: the mini-bar link (aria-label "Paroles"); close the fullscreen first so the click lands.
      await page.locator("button[aria-label='Close player']").first().click({ timeout: 2000 }).catch(() => {});
      const bar = page.locator('[data-testid="player-lyrics"], a[aria-label="Paroles"]').first();
      if (await bar.isVisible().catch(() => false)) { await bar.click({ timeout: 4000 }); await sleep(3000); await shot(page, vp, "lyrics_with_track"); }
    }
  } catch (e) { /* ignore */ }
  // fermer le plein ecran si encore ouvert
  await page.locator("button[aria-label='Close player']").first().click({ timeout: 2000 }).catch(() => {});
  // file d'attente / immersive queue (desktop : panneau ; mobile : dans le plein ecran)
  await go(page, "/home", "networkidle", 800);
  // Wait for the personal rows before the capture: a shot taken right after load showed a black
  // page (audit UX v7 regression 1), which real Chrome never does (e2e/probe-home.cjs).
  await page.locator('[data-row="pour-toi"], [data-row="recemment-acquis"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await sleep(800);
  await shot(page, vp, "home_with_player");
  // Cycle 18: "Reprendre la file" button on home, playback context line in the fullscreen
  metrics[`${vp}/resume_queue_button`] = await page.locator('[data-testid="resume-queue"]').count().catch(() => null);
  let playbackContextFsOpen = false;
  try {
    await page.locator("footer img").first().click({ timeout: 4000 });
    await sleep(1500);
    playbackContextFsOpen = true;
    const pc = page.locator('[data-testid="playback-context"]').first();
    metrics[`${vp}/playback_context`] = (await pc.count()) ? (await pc.innerText()).replace(/\s+/g, " ").trim() : null;
    await shot(page, vp, "playback_context_fs");
  } catch (e) { metrics[`${vp}/playback_context`] = "err " + String(e.message || e).slice(0, 60); }
  // bouton ⋮ de la barre du player (notes harness v11 §4: le menu ne s'ouvrait jamais sur mobile).
  // Desktop: le mini-lecteur a un `.menu-container` PopperButton. Mobile: le mini-lecteur n'a PAS
  // de ⋮ (Player.svelte `{#if !$isMobileMQ}` / `{:else}` n'affiche que PlayerButton + "suivant") ;
  // le seul ⋮ mobile vit dans le plein ecran, `.menu-mobile .more-options .dd-button[aria-label="More options"]`
  // (Fullscreen.svelte). Donc sur mobile on ouvre/garde le plein ecran et on clique ce bouton-la.
  if (vp === "mobile") {
    if (!playbackContextFsOpen) {
      await page.locator("footer img").first().click({ timeout: 4000 }).catch(() => {});
      await sleep(1200);
    }
    const dotsMobile = page.locator('.menu-mobile .more-options .dd-button[aria-label="More options"], .menu-mobile .dd-button[aria-label="More options"]').first();
    if (await dotsMobile.count()) { await dotsMobile.click({ timeout: 3000 }).catch(() => {}); await sleep(600); await shot(page, vp, "player_menu"); await page.keyboard.press("Escape").catch(() => {}); }
    await page.locator("button[aria-label='Close player'], button[aria-label='Fermer le lecteur']").first().click({ timeout: 2000 }).catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator("button[aria-label='Close player']").first().click({ timeout: 2000 }).catch(() => {});
    const dots = page.locator('footer .dd-button[aria-label], footer [aria-label="More options"], .player .menu-container button, .player-right button:not([aria-label])').first();
    if (await dots.count()) { await dots.click({ timeout: 3000 }).catch(() => {}); await sleep(600); await shot(page, vp, "player_menu"); await page.keyboard.press("Escape").catch(() => {}); }
  }

  // 7. hors-ligne peuple
  await go(page, "/library/downloads-offline", "networkidle", 1500);
  await shot(page, vp, "offline_populated");
  const chev = page.locator("button.chev").first();
  if (await chev.count()) { await chev.click({ timeout: 3000 }).catch(() => {}); await sleep(500); await shot(page, vp, "offline_album_expanded"); }
  for (const v of ["artists", "recent"]) {
    const b = page.locator(".views button", { hasText: v === "artists" ? "Artistes" : "Récents" }).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(500); await shot(page, vp, "offline_" + v); }
  }
  // 8. trending + explore (nav principale)
  await go(page, "/trending");
  await shot(page, vp, "trending");
  // album / release page (audit-ux-v2 1.6) and a public playlist (1.7)
  await go(page, "/release?id=MPREb_K8qWMWVqXGi");
  await shot(page, vp, "release");
  try {
    await go(page, "/home");
    const pl = page.locator("a[href*='/playlist/']").first();
    const href = (await pl.count()) ? await pl.getAttribute("href") : null;
    if (href) { await go(page, href); await shot(page, vp, "playlist"); }
  } catch (e) { /* no playlist card on home */ }
  // Cycle 18: keep-offline button on a local album, play-all bar on a local artist, history by day
  try {
    const albumId = await page.evaluate(async () => { const r = await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc"); const d = await r.json(); return d && d.items && d.items[0] && d.items[0].browseId; });
    if (albumId) {
      await go(page, "/release?id=" + encodeURIComponent(albumId));
      metrics[`${vp}/keep_offline_button`] = await page.locator('[data-testid="keep-offline"]').count();
      metrics[`${vp}/offline_badges`] = await page.locator('[data-offline="ready"]').count();
      await shot(page, vp, "local_album_keep");
    }
    const artistHref = await page.evaluate(async () => { const r = await fetch("/api/v1/local/artists?limit=1"); const d = await r.json(); const it = d && d.items && d.items[0]; return it && (it.browseId || (it.endpoint && it.endpoint.browseId)) ? "/artist/" + (it.browseId || it.endpoint.browseId) : null; });
    if (artistHref) {
      await go(page, artistHref);
      metrics[`${vp}/play_all_bar`] = await page.locator('[data-testid="play-all-bar"]').count();
      await shot(page, vp, "local_artist_playall");
    }
    await go(page, "/library/recent");
    metrics[`${vp}/recent_days`] = await page.locator('[data-testid="recent-day"]').count();
    await shot(page, vp, "recent_by_day");
  } catch (e) { console.log("c18 captures", String(e.message || e).slice(0, 80)); }
  // /favorites redirige maintenant client-side vers /library/saved (routes/(app)/favorites/+page.svelte,
  // F10) ; la vieille navigation `go(page,"/favorites")` suivie d'autres `go()` plus bas faisait que
  // ce shot capturait en realite /library/recent (notes harness v11 §4). On va direct sur la cible.
  await go(page, "/library/saved");
  await shot(page, vp, "favorites");
  await go(page, "/library/account");
  await shot(page, vp, "account");

  // reduced-motion : les transitions sont-elles neutralisees ?
  await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => {});
  metrics[`${vp}/reduced_motion`] = await page.evaluate(() => {
    const pick = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).transitionDuration : null; };
    return { footer: pick(".footer-container"), nav: pick("nav.nav"), matches: matchMedia("(prefers-reduced-motion: reduce)").matches };
  });
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({
    headless: true, chromiumSandbox: false,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage", ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])],
  });
  // manifest / PWA (une fois)
  try {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" } });
    const p = await ctx.newPage();
    const r = await p.goto(URL + "/manifest.json", { timeout: 20000 });
    const man = r && r.ok() ? await r.json().catch(() => null) : null;
    const icons = man && man.icons ? man.icons : [];
    const iconChecks = [];
    for (const ic of icons.slice(0, 8)) {
      const u = new (require("url").URL)(ic.src, URL + "/").href;
      const rr = await p.request.get(u).catch(() => null);
      iconChecks.push({ src: ic.src, sizes: ic.sizes, purpose: ic.purpose || null, status: rr ? rr.status() : null, type: rr ? rr.headers()["content-type"] : null });
    }
    const appleIcon = await p.request.get(URL + "/apple-touch-icon.png").catch(() => null);
    const mask = await p.request.get(URL + "/assets/safari-pinned-tab.svg").catch(() => null);
    const fav = await p.request.get(URL + "/assets/favicon.ico").catch(() => null);
    metrics.pwa = { manifest_status: r ? r.status() : null, name: man && man.name, short_name: man && man.short_name, display: man && man.display, theme_color: man && man.theme_color, start_url: man && man.start_url, lang: man && man.lang, icons: iconChecks, maskable: icons.some((i) => /maskable/.test(i.purpose || "")), apple_touch_icon: appleIcon && appleIcon.status(), safari_pinned_tab: mask && mask.status(), favicon_ico: fav && fav.status() };
    await ctx.close();
  } catch (e) { metrics.pwa = { error: String(e.message || e) }; }

  for (const v of VIEWPORTS) {
    console.log("=== viewport", v.name);
    try { await runViewport(browser, v); } catch (e) { console.log("VIEWPORT FAIL", v.name, e.message); }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(OUT, "console.json"), JSON.stringify(consoleErrors, null, 2));
  fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(shots, null, 2));
  fs.writeFileSync(path.join(OUT, "index.md"), shots.map((s) => `- ${s.file}  (${s.url})`).join("\n") + "\n");
  console.log(`\n${shots.length} captures -> ${OUT}`);
})();
