// e2e/shots-c56.cjs : captures d'ecran pour l'audit UX v14 (prod 1924fa0 = cycle 56, correctifs des
// retours live de Camille sur la PWA installee, Vanadium / Android). Memes conventions que shots-c50.cjs
// (collect() : cibles < 44 px, textes < 12 px, contrastes, boutons sans nom, debordement horizontal,
// reseau, LCP ; sonde homeLayout) avec en plus, a chaque capture, un etat `state` : wrappers de
// transition (.app-transition-wrapper : nombre, opacites -> ecran noir), toasts visibles, libelle du
// bouton de pack ("Preparation..." fige ?), media (src, position, pause), URL.
// Lecture seule sur l'app : navigation, un login de test nomme, un album garde hors-ligne dans le cache
// du navigateur (fixture, 4 pistes), AUCUN pack lance (le week-end 2 h et Emporte 1 h ne sont que
// captures). Tous les contextes envoient X-Ytm-Harness: 1.
// run (depuis la box) : cd /srv/beatbump/e2e && ./run.sh https://music.ekaii.fr "daft punk" shots-c56.cjs
// Contextes : mobile = telephone Android (390x844, 2x, UA Chrome Android, tactile) ; desktop 1280x900.
// Profils : anon (profil neuf) et named (login par prenom + 2 ecoutes semees par me/history, memo whoami purge,
// rechargement ; sur prod les ecoutes du harness sont ignorees : `seeds[].ignored` le dit).
// Parcours (dans l'ordre, navigation SPA apres le premier son pour garder le lecteur) :
//   home_first -> premier son depuis une rangee (album / artiste du jour) -> barre d'installation ->
//   accueil apres le son (Emporte 1 h / week-end) -> carte week-end "Preparer 2 h" -> carte Espace ->
//   album garde -> Hors-ligne "Tout lire" -> Tes stats (30 / 7 / 365) -> /bienvenue -> Reglages
//   (economie de donnees + note) -> page artiste (puces Aussi sous) -> /about (carte lint) ->
//   plein ecran (aleatoire, repeter) -> tiroir de file -> toast dans le plein ecran.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));

const arg = (k, d = "") =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const QUERY = arg("query", "daft punk");
const RESOLVER = arg("resolver", "MAP *.ekaii.fr 127.0.0.1");
const TS = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const OUT = arg("out", path.join(__dirname, "out", TS + "-c56"));
const ONLY = arg("only", "");
const PROFILES = (arg("profiles", "anon,named")).split(",").map((s) => s.trim()).filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = (() => { for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) { try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ } } return {}; })();
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const VIEWPORTS = [
  { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ANDROID_UA },
  { name: "desktop", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
].filter((v) => !ONLY || v.name === ONLY);
const WEEKEND_PACK_HREF = "/library/downloads-offline?pack=dur:7200";

const shots = [];
const metrics = {};
const consoleErrors = {};
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---- compteurs reseau par ecran (identique a shots-c50.cjs) -----------------------------------
const IGNORED_FAIL_RE = /stats\.eternel\.eu/;
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
function lcpInitScript() {
  try {
    window.__uxLcp = null;
    new PerformanceObserver((list) => { const e = list.getEntries(); if (e.length) window.__uxLcp = e[e.length - 1].startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) { window.__uxLcp = null; }
}
// Le lecteur est un Audio() hors DOM : on garde l'element au premier play() ; on journalise aussi
// les toasts qui passent (MutationObserver sur [data-testid=alert-container]) et les player.json
// appeles avec un lid local (regle c56a : un lid local ne va jamais a player.json).
function tapInit() {
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return o.apply(this, arguments); };
  window.__toastLog = [];
  const seen = new Set();
  const scan = () => {
    const c = document.querySelector("[data-testid=alert-container]");
    if (!c) return;
    for (const el of c.querySelectorAll(".alert-msg")) {
      const t = (el.textContent || "").trim();
      if (!t || seen.has(el)) continue;
      seen.add(el);
      const r = (el.closest(".alert") || el).getBoundingClientRect();
      window.__toastLog.push({ t: Date.now(), msg: t.slice(0, 120), top: Math.round(r.top), bottom: Math.round(r.bottom), path: location.pathname + location.search });
    }
  };
  const start = () => { try { new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {} };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  window.__playerJsonLocal = [];
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const u = typeof input === "string" ? input : (input && input.url) || "";
      // un lid local = 11 hexas minuscules (ex. 6300e80e2e2) ; un videoId YouTube melange majuscules / - / _
      if (/player\.json/.test(u) && /videoId=[0-9a-f]{11}(&|$)/.test(u)) window.__playerJsonLocal.push(u.slice(0, 160));
    } catch (e) {}
    return of.apply(this, arguments);
  };
}

// ---- metriques UX brutes (identique a shots-c50.cjs) -------------------------------------------
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
      wrapper_scroll_w: (() => { const w = document.getElementById("wrapper"); return w ? w.scrollWidth : null; })(),
    };
  }).catch((e) => ({ error: String(e.message || e) }));
  if (page.__ux) Object.assign(m, await page.__ux.snapshot());
  m.lcpMs = await page.evaluate(() => (typeof window.__uxLcp === "number" ? Math.round(window.__uxLcp) : null)).catch(() => null);
  m.state = await state(page);
  metrics[key] = m;
  return m;
}

// Etat "Camille" : wrappers de transition (ecran noir = l'ancien wrapper reste a opacite 0 sans remplacant visible),
// toasts visibles, bouton de pack, media, tiroir / plein ecran.
async function state(page) {
  return page.evaluate(() => {
    const wr = [...document.querySelectorAll(".app-transition-wrapper")].map((el) => { const r = el.getBoundingClientRect(); return { op: getComputedStyle(el).opacity, h: Math.round(r.height), txt: (el.innerText || "").replace(/\s+/g, " ").slice(0, 30) }; });
    const visibleWrapper = wr.some((w) => parseFloat(w.op) > 0.5 && w.h > 50);
    const toasts = [...document.querySelectorAll("[data-testid=alert-container] .alert-msg")].map((e) => (e.textContent || "").trim().slice(0, 100));
    const ps = document.querySelector("[data-testid=pack-start]");
    const pp = document.querySelector("[data-testid=pack-progress]");
    const sel = document.querySelector("[data-testid=pack-size]");
    const el = window.__ytmMedia;
    const fsp = document.querySelector(".fullscreen-player-popup");
    const w = document.getElementById("wrapper");
    return {
      url: location.pathname + location.search,
      wrappers: wr, visibleWrapper, blackScreen: wr.length > 0 && !visibleWrapper,
      wrapperScrollTop: w ? Math.round(w.scrollTop) : null,
      toasts, toastLog: (window.__toastLog || []).slice(-8),
      packStart: ps ? { text: ps.innerText.trim(), disabled: ps.disabled || ps.getAttribute("aria-disabled") === "true" } : null,
      packProgress: pp ? { state: pp.getAttribute("data-state"), text: pp.innerText.replace(/\s+/g, " ").slice(0, 160) } : null,
      packSize: sel ? { value: sel.value, disabled: sel.disabled, label: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null } : null,
      media: el ? { src: (el.currentSrc || el.src || "").slice(0, 70), t: +el.currentTime.toFixed(1), paused: el.paused } : null,
      fullscreenOpen: !!(fsp && fsp.getBoundingClientRect().width > 0 && getComputedStyle(fsp).visibility !== "hidden"),
      playerJsonLocal: (window.__playerJsonLocal || []).slice(0, 5),
    };
  }).catch((e) => ({ error: String(e.message || e) }));
}

// Sonde accueil (identique a shots-c50.cjs).
async function homeLayout(page, key) {
  const m = await page.evaluate(() => {
    const main = document.querySelector("main[data-testid=home]");
    if (!main) return { error: "no main" };
    const w = document.getElementById("wrapper");
    const sy = w ? w.scrollTop : (window.scrollY || 0);
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rows = [];
    const walk = (el) => {
      for (const c of el.children) {
        const cs = getComputedStyle(c);
        if (cs.display === "contents") { walk(c); continue; }
        if (!vis(c)) continue;
        const r = c.getBoundingClientRect();
        const tid = c.getAttribute("data-testid") || (c.querySelector("[data-testid]") || {}).getAttribute?.("data-testid") || "";
        const row = c.getAttribute("data-row") || (c.closest("[data-row]") || {}).getAttribute?.("data-row") || "";
        const head = (c.querySelector(".h2, h2, .week-card-title, .weekend-card-title, .first-pack-card-title, .h1, h1, .subheading, .headline") || {}).innerText || "";
        rows.push({ tag: c.tagName.toLowerCase(), cls: String(c.className || "").slice(0, 40), testid: tid, row, head: String(head).trim().slice(0, 50), top: Math.round(r.top + sy), h: Math.round(r.height) });
      }
    };
    walk(main);
    const firstYt = rows.findIndex((r) => !r.row && !r.testid && /carousel/i.test(r.cls + " " + r.tag) || (r.tag === "section" && !r.row && !r.testid && r.h > 100));
    const chips = [...document.querySelectorAll("main[data-testid=home] .chips a, main[data-testid=home] .chips button, main[data-testid=home] [class*=chip] a, main[data-testid=home] [class*=chip] button")].map((e) => e.innerText.trim()).filter(Boolean).slice(0, 20);
    return { scrollTop: sy, chips, blocks: rows, personalBlocksBeforeYouTube: firstYt >= 0 ? firstYt : rows.length, firstYouTubeTop: firstYt >= 0 ? rows[firstYt].top : null };
  }).catch((e) => ({ error: String(e.message || e) }));
  metrics[key] = m;
  return m;
}

async function shot(page, tag, label, opts = {}) {
  const f = `${tag}-${String(shots.filter((s) => s.tag === tag).length + 1).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: path.join(OUT, f), fullPage: !!opts.fullPage }).catch((e) => console.log("shot fail", f, e.message));
  shots.push({ tag, label, file: f, url: page.url() });
  log("SHOT", f);
  if (opts.metrics !== false) await collect(page, `${tag}/${label}`);
  else metrics[`${tag}/${label}_state`] = await state(page);
  return f;
}
async function go(page, p, wait = "domcontentloaded", extra = 2000) {
  if (page.__ux) page.__ux.reset();
  const r = await page.goto(p.startsWith("http") ? p : URL + p, { waitUntil: wait, timeout: 45000 }).catch((e) => { log("goto", p, e.message.split("\n")[0]); return null; });
  await sleep(extra);
  return r;
}
// Navigation interne (SvelteKit intercepte le lien : la lecture et l'etat de session survivent).
async function spaGo(page, href, extra = 2000) {
  if (page.__ux) page.__ux.reset();
  await page.evaluate((h) => { const a = document.createElement("a"); a.href = h; a.style.position = "fixed"; a.style.left = "-9999px"; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 0); }, href).catch(() => {});
  await sleep(extra);
}
async function scrollTo(page, sel, block = "center") {
  const ok = await page.evaluate(([s, b]) => { const e = document.querySelector(s); if (!e) return false; e.scrollIntoView({ block: b }); return true; }, [sel, block]).catch(() => false);
  await sleep(500);
  return ok;
}
async function audioState(page) {
  return page.evaluate(() => { const el = window.__ytmMedia; return el ? { src: (el.currentSrc || el.src || "").slice(0, 70), t: el.currentTime, paused: el.paused } : null; }).catch(() => null);
}
async function pollUntil(fn, timeoutMs, everyMs = 1000) {
  const t = Date.now(); let last;
  while (Date.now() - t < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  return last;
}
async function waitSound(page, ms = 30000) {
  return pollUntil(async () => { const s = await audioState(page); return s && s.src && s.t > 1 && !s.paused ? s : null; }, ms, 500);
}
async function clickFirst(page, selectors, timeout = 4000) {
  for (const sel of selectors) {
    const l = page.locator(sel).first();
    if (await l.count() && await l.isVisible().catch(() => false)) {
      const ok = await l.click({ timeout }).then(() => true).catch((e) => { log("click fail", sel, e.message.split("\n")[0]); return false; });
      if (ok) return sel;
    }
  }
  return null;
}
async function newPage(browser, vpdef, tag) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" }, ...vpdef, acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  consoleErrors[tag] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors[tag].push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors[tag].push("PAGEERROR " + String((e && e.message) || e).slice(0, 200)));
  await page.addInitScript(tapInit);
  await page.addInitScript(lcpInitScript);
  instrument(page);
  await page.route("**/analytics.example.org/**", (r) => r.abort()).catch(() => {});
  return { ctx, page };
}

// loginAs (motif harness-core / steps-c45-stats) : POST me/login + purge du memo whoami, deux ecoutes
// semees sur les fixtures, puis rechargement pour que la SPA se connecte.
async function loginNamed(page, tag) {
  const name = "ux14-" + Date.now().toString(36);
  const login = await page.evaluate(async (n) => { const r = await fetch("/api/v1/me/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }); try { sessionStorage.removeItem("ytm-whoami"); sessionStorage.removeItem("ytm-remote-consumed"); } catch {} return r.status; }, name).catch((e) => String(e));
  const seeds = [];
  for (const t of [
    { videoId: FIX.localLid || "harness-lid", title: FIX.localLidTitle || "Harness seed", length: "7:09" },
    { videoId: FIX.acquiredVideoId || "harness-vid", title: FIX.acquiredVideoTitle || "Harness seed 2", length: "5:20" },
  ]) {
    const s = await page.evaluate(async (body) => { const r = await fetch("/api/v1/me/history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, ignored: !!(j && j.ignored) }; }, {
      videoId: t.videoId, title: t.title, length: t.length,
      album: { text: FIX.localAlbumTitle || "Harness album", browseId: FIX.localAlbumId || "lb-harness" },
      artistInfo: { artist: [{ text: FIX.localArtistName || "Harness artist", browseId: FIX.localArtistId || "la-harness" }] },
    }).catch((e) => ({ status: String(e), ignored: null }));
    seeds.push(s);
  }
  metrics[`${tag}/login`] = { name, status: login, seeds, stored: seeds.filter((s) => s.status === 200 && !s.ignored).length };
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
  metrics[`${tag}/whoami`] = await page.evaluate(async () => { try { const r = await fetch("/api/v1/me/whoami"); return await r.json(); } catch (e) { return String(e); } }).catch(() => null);
}

// ---- le parcours complet d'un contexte --------------------------------------------------------
async function journey(browser, vpdef, profile) {
  const tag = `${vpdef.name}-${profile}`;
  const light = vpdef.name === "desktop" && profile === "named"; // desktop connecte : pas d'album garde (deja fait en anon)
  const { ctx, page } = await newPage(browser, vpdef, tag);
  try {
    // 1. premier accueil
    await go(page, "/home", "domcontentloaded", 2500);
    if (profile === "named") await loginNamed(page, tag);
    await page.locator('[data-testid="first-run"], [data-testid="album-of-day"], [data-testid="artist-of-day"], [data-row]').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    await sleep(2000);
    metrics[`${tag}/install_hint_on_first_paint`] = await page.locator("[data-testid=install-hint]").count();
    await shot(page, tag, "home_first");
    await homeLayout(page, `${tag}/home_first_layout`);
    metrics[`${tag}/home_first_cards`] = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      return { first_run: q("[data-testid=first-run]"), first_pack: q("[data-testid=first-pack-card]"), weekend: q("[data-testid=weekend-card]"), week: q("[data-testid=week-card]"), today_row: q("[data-testid=today-row]"), album_of_day: q("[data-testid=album-of-day]"), artist_of_day: q("[data-testid=artist-of-day]"), resume: q("[data-testid=resume-row-compact], [data-testid=resume-card]"), more_rows: q("[data-testid=home-more-rows]"), rows: [...document.querySelectorAll("[data-row]")].map((e) => e.getAttribute("data-row") + (e.getAttribute("data-folded") ? "(plie)" : "")), skeleton: q("[data-testid=home-yt-skeleton]"), error: q("[data-testid=home-error]") };
    }).catch(() => null);
    if (await scrollTo(page, "[data-testid=album-of-day], [data-testid=today-row]", "start")) await shot(page, tag, "home_today_cards", { metrics: false });

    // 2. premier son depuis une rangee (album du jour, sinon artiste du jour, sinon Reprendre, sinon le mix de Bienvenue)
    const playSel = await clickFirst(page, ["[data-testid=album-of-day-play]", "[data-testid=artist-of-day-play]", "[data-testid=resume-card-play]", "[data-testid=first-run-mix]"], 5000);
    const played = await waitSound(page, 30000);
    metrics[`${tag}/first_play`] = { via: playSel, played, state: await state(page) };
    await sleep(1500);
    await scrollTo(page, "main[data-testid=home]", "start");
    await shot(page, tag, "home_first_play");

    // 3. barre d'installation apres le premier son
    await page.locator("[data-testid=install-hint]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await sleep(800);
    metrics[`${tag}/install_hint`] = await page.evaluate(() => { const e = document.querySelector("[data-testid=install-hint]"); if (!e) return null; const r = e.getBoundingClientRect(); const f = document.querySelector("footer"); const fr = f && f.getBoundingClientRect(); const b = e.querySelector("button.install"); const br = b && b.getBoundingClientRect(); return { text: e.innerText.replace(/\s+/g, " ").trim(), top: Math.round(r.top), h: Math.round(r.height), dock: e.getAttribute("data-dock"), footer_top: fr && Math.round(fr.top), reserve: getComputedStyle(document.documentElement).getPropertyValue("--install-hint-reserve"), install_btn: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null, how_link: !!e.querySelector("[data-testid=install-hint-how]") }; }).catch(() => null);
    await shot(page, tag, "install_hint");

    // 4. accueil apres le son : Emporte 1 h (profil neuf) / Prepare ton week-end
    await spaGo(page, "/library", 800);
    await spaGo(page, "/home", 3500);
    await page.locator('[data-testid="first-pack-card"], [data-testid="weekend-card"], [data-row]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await sleep(1000);
    await shot(page, tag, "home_after_sound");
    await homeLayout(page, `${tag}/home_after_sound_layout`);
    metrics[`${tag}/home_after_sound_cards`] = await page.evaluate(() => { const q = (s) => document.querySelector(s); const fp = q("[data-testid=first-pack-card]"); const wk = q("[data-testid=weekend-card]"); return { first_run: !!q("[data-testid=first-run]"), first_pack: fp ? fp.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : null, first_pack_size: (q("[data-testid=first-pack-size]") || {}).innerText || null, weekend: wk ? wk.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : null, resume: !!q("[data-testid=resume-row-compact], [data-testid=resume-card]"), install_hint: !!q("[data-testid=install-hint]") }; }).catch(() => null);
    if (await scrollTo(page, "[data-testid=first-pack-card], [data-testid=weekend-card]", "center")) await shot(page, tag, "home_pack_cards", { metrics: false });

    // 5. carte week-end -> "Preparer 2 h" -> carte Espace (le chemin de l'ecran noir de Camille). Rien n'est lance.
    await scrollTo(page, "main[data-testid=home]", "start");
    const wkStart = page.locator("[data-testid=weekend-card-start]").first();
    const viaCard = (await wkStart.count()) && (await wkStart.isVisible().catch(() => false));
    if (viaCard) { await wkStart.scrollIntoViewIfNeeded().catch(() => {}); await wkStart.click({ timeout: 5000 }).catch((e) => log("weekend click", e.message.split("\n")[0])); }
    else await spaGo(page, WEEKEND_PACK_HREF, 0);
    const timeline = [];
    let tAcc = 0;
    for (const at of [300, 1500, 4000]) { await sleep(at - tAcc); tAcc = at; timeline.push({ at, ...(await state(page)) }); }
    metrics[`${tag}/weekend_nav`] = { viaCard: !!viaCard, timeline };
    await shot(page, tag, "weekend_space_card");
    metrics[`${tag}/weekend_space`] = await page.evaluate(() => { const q = (s) => document.querySelector(s); const tog = q("[data-testid=space-toggle]"); const sp = q("[data-testid=offline-space]"); return { expanded: tog && tog.getAttribute("aria-expanded"), space_text: sp ? sp.innerText.replace(/\s+/g, " ").trim().slice(0, 400) : null, has_progress: !!q("[data-testid=pack-progress]"), empty_state: !!document.querySelector("main .empty-state, [data-testid=browse-empty]"), notice: (q("[data-testid=data-saver-notice]") || {}).innerText || null }; }).catch(() => null);
    if (await scrollTo(page, "[data-testid=pack-start]", "center")) await shot(page, tag, "weekend_space_card_cta", { metrics: false });

    // 6. album garde -> Hors-ligne -> "Tout lire" (la lecture hors-ligne de Camille)
    if (!light) {
      await spaGo(page, "/release?id=" + encodeURIComponent(FIX.localAlbumId || ""), 2500);
      const keep = page.locator('[data-testid="keep-offline"]').first();
      await keep.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      let keepState = await keep.getAttribute("data-state").catch(() => null);
      if (keepState !== "ready") {
        await keep.click({ timeout: 5000 }).catch((e) => log("keep click", e.message.split("\n")[0]));
        await sleep(1500);
        await shot(page, tag, "release_keeping");
        keepState = await pollUntil(async () => { const s = await keep.getAttribute("data-state").catch(() => null); return s === "ready" ? s : null; }, 110000, 2000);
      }
      metrics[`${tag}/keep`] = { state: await keep.getAttribute("data-state").catch(() => null), text: await keep.innerText().catch(() => null), toasts: (await state(page)).toastLog };
      await shot(page, tag, "release_kept");
      await spaGo(page, "/library/downloads-offline", 3000);
      await shot(page, tag, "offline_kept");
      metrics[`${tag}/offline_kept`] = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Tout lire/.test(x.innerText)); const r = document.getElementById("offline-ready"); return { tout_lire: b ? { disabled: b.disabled, aria_disabled: b.getAttribute("aria-disabled"), title: b.title } : null, ready: r ? r.innerText.replace(/\s+/g, " ").trim() : null, counter: (document.querySelector("#offline-persisted") || {}).innerText || null, badges: document.querySelectorAll("[data-offline=ready]").length }; }).catch(() => null);
      const before = (await state(page)).toastLog.length;
      await clickFirst(page, ['main button:has-text("Tout lire")'], 5000);
      const snd = await pollUntil(async () => { const s = await audioState(page); return s && /localf|\/aud|blob/.test(s.src) && s.t > 0.5 ? s : null; }, 20000, 500);
      await sleep(1500);
      const st = await state(page);
      metrics[`${tag}/tout_lire`] = { sound: snd, media: st.media, newToasts: st.toastLog.slice(before), playerJsonLocal: st.playerJsonLocal };
      await shot(page, tag, "offline_tout_lire");
    }

    // 7. Tes stats : 30 jours, puis 7 et 365
    await spaGo(page, "/library/stats", 3000);
    await page.locator("[data-testid=stats-summary]").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    await sleep(800);
    await shot(page, tag, "stats_30");
    for (const d of [7, 365]) {
      const b = page.locator(`[data-testid=stats-period-${d}]`).first();
      if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(2500); await shot(page, tag, `stats_${d}`); }
    }
    metrics[`${tag}/stats_sections`] = await page.evaluate(() => ({ periods: [...document.querySelectorAll("[data-testid^=stats-period-]")].map((b) => ({ t: b.innerText.trim(), pressed: b.getAttribute("aria-pressed"), cls: String(b.className).slice(0, 40) })), sub: (document.querySelector("[data-testid=stats-period-sub]") || {}).innerText || null, empty: !!document.querySelector("[data-testid=stats-summary].empty"), streak: !!document.querySelector("[data-testid=stats-streak]"), clock: !!document.querySelector("[data-testid=stats-clock]"), year: !!document.querySelector("[data-testid=stats-year]"), h: [...document.querySelectorAll("main h1, main h2")].map((h) => h.innerText.trim().slice(0, 40)) })).catch(() => null);
    if (await scrollTo(page, "[data-testid=stats-year], [data-testid=stats-streak]", "start")) await shot(page, tag, "stats_year", { metrics: false });

    // 8. /bienvenue (Android : etapes Android en premier ?)
    await spaGo(page, "/bienvenue", 2500);
    await shot(page, tag, "bienvenue");
    metrics[`${tag}/bienvenue`] = await page.evaluate(() => ({ ios: !!document.querySelector("[data-testid=steps-ios]"), android: !!document.querySelector("[data-testid=steps-android]"), first_steps: ((document.querySelector("[data-testid=steps-android], [data-testid=steps-ios]") || {}).getAttribute || (() => null)).call(document.querySelector("[data-testid=steps-android], [data-testid=steps-ios]") || document.body, "data-testid"), other: (document.querySelector("[data-testid=bienvenue-other]") || {}).innerText || null, install_btn: (document.querySelector("[data-testid=bienvenue-install]") || {}).innerText || null, installed: (document.querySelector("[data-testid=bienvenue-installed]") || {}).innerText || null, hint: (document.querySelector("[data-testid=install-hint]") || {}).innerText || null })).catch(() => null);

    // 9. Reglages : economie de donnees + note "Suspendu..." puis l'avis Hors-ligne
    await spaGo(page, "/settings", 2500);
    await scrollTo(page, "#data-saver", "center");
    await shot(page, tag, "settings_data_saver");
    const sw = page.locator('label.switch[for="data-saver"]').first();
    if (await sw.count()) {
      await sw.click({ timeout: 3000 }).catch(() => {});
      await sleep(600);
      metrics[`${tag}/data_saver_on`] = await page.evaluate(() => ({ checked: (document.getElementById("data-saver") || {}).checked, note: (document.querySelector("[data-testid=offline-autocache-suspended]") || {}).innerText || null, note_visible: (() => { const e = document.querySelector("[data-testid=offline-autocache-suspended]"); if (!e) return false; const r = e.getBoundingClientRect(); return r.height > 0; })() })).catch(() => null);
      if (await scrollTo(page, "[data-testid=offline-autocache-suspended]", "center")) await shot(page, tag, "settings_data_saver_note");
      else await shot(page, tag, "settings_data_saver_on", { metrics: false });
      await spaGo(page, "/library/downloads-offline", 2500);
      await shot(page, tag, "offline_data_saver_notice");
      metrics[`${tag}/data_saver_notice`] = await page.evaluate(() => { const e = document.querySelector("[data-testid=data-saver-notice]"); const m = document.querySelector("[data-testid=data-saver-modify]"); const r = m && m.getBoundingClientRect(); return e ? { text: e.innerText.replace(/\s+/g, " ").trim(), source: e.getAttribute("data-source"), modify: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null } : null; }).catch(() => null);
      // on remet l'interrupteur a zero (le contexte est jetable, mais la suite du parcours lit l'etat par defaut)
      await spaGo(page, "/settings", 2000);
      await scrollTo(page, "#data-saver", "center");
      await sw.click({ timeout: 3000 }).catch(() => {});
      await sleep(400);
    }

    // 10. page artiste avec puces "Aussi sous"
    const alias = await page.evaluate(async () => { try { const r = await fetch("/api/v1/local/artists/aliases?limit=3"); const d = await r.json(); const g = d && d.groups && d.groups[0]; return g ? { id: g.id, name: g.name, aliases: (g.aliases || []).map((a) => a.name), total: d.total } : null; } catch (e) { return null; } }).catch(() => null);
    metrics[`${tag}/alias_group`] = alias;
    if (alias && alias.id) {
      await spaGo(page, "/artist/" + alias.id, 3000);
      await page.locator("[data-testid=artist-aliases]").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      await scrollTo(page, "[data-testid=artist-aliases]", "center");
      await shot(page, tag, "artist_aliases");
      metrics[`${tag}/alias_chips`] = await page.evaluate(() => ({ chips: [...document.querySelectorAll("[data-testid=artist-alias-chip]")].map((c) => { const r = c.getBoundingClientRect(); return { text: c.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height) }; }), more: (document.querySelector("[data-testid=artist-aliases-more]") || {}).innerText || null, box_h: (() => { const e = document.querySelector("[data-testid=artist-aliases]"); return e ? Math.round(e.getBoundingClientRect().height) : null; })(), songs_head: (document.querySelector("main .h2") || {}).innerText || null })).catch(() => null);
      const more = page.locator("[data-testid=artist-aliases-more]").first();
      if (await more.count()) { await more.click({ timeout: 3000 }).catch(() => {}); await sleep(500); await shot(page, tag, "artist_aliases_open", { metrics: false }); }
    }

    // 11. A propos : carte lint
    await spaGo(page, "/about", 3000);
    await page.locator("[data-testid=about-library-lint]").first().waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    await scrollTo(page, "[data-testid=about-library-lint]", "center");
    await shot(page, tag, "about_lint");
    metrics[`${tag}/about_lint`] = await page.evaluate(() => { const e = document.querySelector("[data-testid=about-library-lint]"); return e ? { text: e.innerText.replace(/\s+/g, " ").trim().slice(0, 300), links: [...e.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")), items: [...e.querySelectorAll("li")].map((li) => li.innerText.replace(/\s+/g, " ").trim().slice(0, 80)) } : null; }).catch(() => null);

    // 12. plein ecran : aleatoire / repeter, tiroir de file, toast dans le plein ecran
    await spaGo(page, "/home", 2500);
    await page.locator('[data-row], [data-testid=album-of-day]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    const med = await audioState(page);
    if (!med || !med.src) { await clickFirst(page, ["[data-testid=album-of-day-play]", "[data-testid=artist-of-day-play]", "[data-testid=resume-card-play]"], 5000); await waitSound(page, 20000); }
    const fsSel = await clickFirst(page, vpdef.name === "mobile" ? ["footer img", ".player img", ".now-playing"] : ["footer img", ".player img", "[aria-label*='expand' i]", ".now-playing"], 4000);
    await sleep(1500);
    let fsOpen = (await state(page)).fullscreenOpen;
    if (!fsOpen) { await clickFirst(page, ['footer [aria-label="File d\'attente"]'], 3000); await sleep(1200); fsOpen = (await state(page)).fullscreenOpen; }
    metrics[`${tag}/fullscreen_opened`] = { via: fsSel, open: fsOpen };
    await shot(page, tag, "player_fullscreen");
    const ctl = async () => page.evaluate(() => { const b = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { label: e.getAttribute("aria-label"), pressed: e.getAttribute("aria-pressed"), w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity, color: cs.color }; }; return { shuffle: b('.fullscreen-player-popup [aria-label="Aléatoire"], .fullscreen-player-popup button[aria-label^="Aléatoire"]'), repeat: b('.fullscreen-player-popup .player-controls .buttons > button:last-of-type, .fullscreen-player-popup button[aria-label^="Rép"], .fullscreen-player-popup button[aria-label*="épét"]'), mode: (document.querySelector('.fullscreen-player-popup [aria-label="Mode de lecture"]') || {}).innerText || null, context: (document.querySelector("[data-testid=playback-context]") || {}).innerText || null, nextUp: (document.querySelector("[data-testid=fullscreen-next-up]") || {}).innerText || null }; }).catch(() => null);
    metrics[`${tag}/fs_controls_before`] = await ctl();
    const shuf = page.locator('.fullscreen-player-popup button[aria-label="Aléatoire"]').first();
    if (await shuf.count()) { await shuf.click({ timeout: 3000 }).catch(() => {}); await sleep(700); await shot(page, tag, "player_shuffle_on"); }
    const rep = page.locator('.fullscreen-player-popup button[aria-label^="Rép"], .fullscreen-player-popup button[aria-label*="épét"], .fullscreen-player-popup button[aria-label^="Repeat"]').first();
    if (await rep.count()) { await rep.click({ timeout: 3000 }).catch(() => {}); await sleep(700); await shot(page, tag, "player_repeat_on"); }
    metrics[`${tag}/fs_controls_after`] = await ctl();
    // tiroir de file
    const handle = page.locator('.fullscreen-player-popup .handle.horizontal[aria-label="Afficher la file d\'attente"], .fullscreen-player-popup .handle.horizontal').first();
    if (await handle.count()) { await handle.click({ timeout: 3000 }).catch((e) => log("handle", e.message.split("\n")[0])); await sleep(1000); }
    metrics[`${tag}/queue_drawer`] = await page.evaluate(() => { const b = document.querySelector("[data-testid=queue-drawer-body]"); const r = b && b.getBoundingClientRect(); const c = document.querySelector("[data-testid=queue-clear]"); return { inert: b && b.getAttribute("data-inert"), hidden: b && b.getAttribute("data-no-inert-hidden"), top: r && Math.round(r.top), h: r && Math.round(r.height), count: (document.querySelector("[data-testid=queue-count]") || {}).innerText || null, rows: document.querySelectorAll("[data-testid=queue-row]").length, removes: document.querySelectorAll("[data-testid=queue-row-remove]").length, clear_disabled: c ? c.disabled : null, handle: (document.querySelector(".fullscreen-player-popup .handle.horizontal") || {}).getAttribute?.("aria-expanded") }; }).catch(() => null);
    await shot(page, tag, "queue_drawer");
    // toast : retirer la 2e ligne de la file -> "« ... » retire de la file" ; ou est le toast ?
    const removes = page.locator("[data-testid=queue-row-remove]");
    const nRem = await removes.count();
    if (nRem > 1) {
      const before = (await state(page)).toastLog.length;
      await removes.nth(1).click({ timeout: 3000 }).catch((e) => log("remove", e.message.split("\n")[0]));
      await page.locator("[data-testid=alert-container] .alert-msg").first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      await sleep(150);
      await shot(page, tag, "toast_in_fullscreen");
      metrics[`${tag}/toast_fs`] = await page.evaluate(() => { const c = document.querySelector("[data-testid=alert-container]"); const a = c && (c.querySelector(".alert") || c.querySelector(".alert-msg")); const r = a && a.getBoundingClientRect(); const h = document.querySelector(".fullscreen-player-popup .handle.horizontal"); const hr = h && h.getBoundingClientRect(); const ctr = document.querySelector(".fullscreen-player-popup .player-controls"); const cr = ctr && ctr.getBoundingClientRect(); return { msg: a && a.textContent.trim().slice(0, 100), top: r && Math.round(r.top), bottom: r && Math.round(r.bottom), innerHeight, handle_top: hr && Math.round(hr.top), controls_top: cr && Math.round(cr.top), controls_bottom: cr && Math.round(cr.bottom), overlapsControls: !!(r && cr && r.bottom > cr.top && r.top < cr.bottom) }; }).catch(() => null);
      metrics[`${tag}/toast_fs`] = { ...(metrics[`${tag}/toast_fs`] || {}), newToasts: (await state(page)).toastLog.slice(before) };
    }
    // fermer tiroir et plein ecran
    await clickFirst(page, ['.fullscreen-player-popup .handle.horizontal[aria-label="Masquer la file d\'attente"]'], 2000);
    await sleep(400);
    await clickFirst(page, ['button[aria-label="Fermer le lecteur"]', "button[aria-label='Close player']"], 2000);
    await sleep(800);
    await shot(page, tag, "home_end", { metrics: false });
    metrics[`${tag}/console`] = consoleErrors[tag].slice(0, 30);
  } catch (e) { log("journey fail", tag, String(e.stack || e.message || e).slice(0, 300)); metrics[`${tag}/journey_error`] = String(e.message || e).slice(0, 200); }
  await ctx.close().catch(() => {});
}

(async () => {
  const browser = await chromium.launch({
    headless: true, chromiumSandbox: false,
    channel: process.env.PW_CHANNEL || undefined,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage", ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])],
  });
  for (const v of VIEWPORTS) {
    for (const p of PROFILES) {
      log("=== contexte", v.name, p);
      try { await journey(browser, v, p); } catch (e) { log("FAIL", v.name, p, e.message); }
      fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(OUT, "console.json"), JSON.stringify(consoleErrors, null, 2));
  fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(shots, null, 2));
  fs.writeFileSync(path.join(OUT, "index.md"), shots.map((s) => `- ${s.file}  (${s.url})`).join("\n") + "\n");
  log(`\n${shots.length} captures -> ${OUT}`);
})();
