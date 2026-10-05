// e2e/shots-c50.cjs — captures d'ecran des ecrans ajoutes par les cycles 41 a 50 (audit UX v13),
// memes conventions que ux-audit/shots.cjs : mobile 390x844 (2x, UA iPhone) et desktop 1280x900,
// metriques UX brutes par ecran (cibles < 44 px, textes < 12 px, contrastes, boutons sans nom),
// compteurs reseau, LCP, plus une sonde `homeLayout` (ordre et position des blocs de l'accueil).
// Lecture seule sur l'app : navigation, un login de test ("harness"), un pack de 1 h prepare dans
// le cache du navigateur (le meme geste que l'etape first_pack_card du harness), rien cote serveur.
// run (depuis la box) : cd /srv/beatbump/e2e && ./run.sh https://music.ekaii.fr "daft punk" shots-c50.cjs
// Ecrans :
//   contexte A (profil neuf, sans historique) : accueil premier jour (carte "Emporte 1 h", Bienvenue,
//     album du jour, artiste du jour, "Arrive en <mois>"), Tes stats vide, /bienvenue, A propos
//     (bibliotheque + lint + doublons), Albums "Sans annee", Genres rares (plie / ouvert), page artiste
//     avec puces "Aussi sous", liste des artistes avec "+N variantes", Reglages (economie de donnees),
//     Hors-ligne avec l'avis economie de donnees, albums "Arrive en <mois>".
//   contexte B (mobile seulement, profil neuf) : tap "Preparer 1 h" -> Hors-ligne avec le pack en cours,
//     puis "Rafraichir mon pack" et son apercu.
//   contexte C (mobile, UA iPhone, profil neuf) : premier son depuis la recherche -> barre d'installation,
//     accueil avec lecteur + barre, Tes stats apres une ecoute.
//   contexte D (login nomme "harness-shots-<ts>", deux ecoutes semees par me/history, memo whoami purge,
//     rechargement ; c53c B9-25) : Tes stats (Ton mois, serie, horloge, Ton annee, partager mon annee). Sur prod
//     les ecoutes du harness sont ignorees (X-Ytm-Harness) : l etat vide NOMME est capture ; sur staging
//     (YTM_STATS_INCLUDE_HARNESS=1) les ecrans pleins.
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
const OUT = arg("out", path.join(__dirname, "out", TS + "-c50"));
const ONLY = arg("only", "");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// c53c (B9-25): the fixture ids seed the logged-in profile's plays (same payload as share_year, steps-c45-stats.cjs).
const FIX = (() => { for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) { try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ } } return {}; })();
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const VIEWPORTS = [
  { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA },
  { name: "desktop", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
].filter((v) => !ONLY || v.name === ONLY);

const shots = [];
const metrics = {};
const consoleErrors = {};

// ---- compteurs reseau par ecran (identique a ux-audit/shots.cjs) ------------------------------
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
// Le lecteur est un Audio() hors DOM : on garde l'element au premier play().
function mediaHook() {
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return o.apply(this, arguments); };
}

// ---- metriques UX brutes (identique a ux-audit/shots.cjs) --------------------------------------
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
    };
  }).catch((e) => ({ error: String(e.message || e) }));
  if (page.__ux) Object.assign(m, await page.__ux.snapshot());
  m.lcpMs = await page.evaluate(() => (typeof window.__uxLcp === "number" ? Math.round(window.__uxLcp) : null)).catch(() => null);
  metrics[key] = m;
  return m;
}

// Sonde accueil : les blocs directs de <main data-testid=home> dans l'ordre du DOM, avec leur
// position (px css, repere document : scrollTop de #wrapper ajoute), hauteur, testid / data-row,
// et le nombre de blocs personnels avant la premiere rangee YouTube.
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
        const head = (c.querySelector(".h2, h2, .week-card-title, .first-pack-card-title, .h1, h1, .subheading") || {}).innerText || "";
        rows.push({ tag: c.tagName.toLowerCase(), cls: String(c.className || "").slice(0, 40), testid: tid, row, head: String(head).trim().slice(0, 50), top: Math.round(r.top + sy), h: Math.round(r.height) });
      }
    };
    walk(main);
    const firstYt = rows.findIndex((r) => !r.row && !r.testid && /carousel/i.test(r.cls + " " + r.tag) || (r.tag === "section" && !r.row && !r.testid && r.h > 100));
    return { scrollTop: sy, blocks: rows, personalBlocksBeforeYouTube: firstYt >= 0 ? firstYt : rows.length, firstYouTubeTop: firstYt >= 0 ? rows[firstYt].top : null };
  }).catch((e) => ({ error: String(e.message || e) }));
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
  if (page.__ux) page.__ux.reset();
  const r = await page.goto(p.startsWith("http") ? p : URL + p, { waitUntil: wait, timeout: 45000 }).catch((e) => { console.log("goto", p, e.message.split("\n")[0]); return null; });
  await sleep(extra);
  return r;
}
// Navigation interne (SvelteKit intercepte le lien : la lecture et l'etat de session survivent).
async function spaGo(page, href, extra = 1500) {
  if (page.__ux) page.__ux.reset();
  await page.evaluate((h) => { const a = document.createElement("a"); a.href = h; a.style.position = "fixed"; a.style.left = "-9999px"; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 0); }, href);
  await sleep(extra);
}
async function scrollTo(page, sel, block = "center") {
  const ok = await page.evaluate(([s, b]) => { const e = document.querySelector(s); if (!e) return false; e.scrollIntoView({ block: b }); return true; }, [sel, block]).catch(() => false);
  await sleep(500);
  return ok;
}
async function scrollBottom(page) {
  await page.evaluate(() => { const w = document.getElementById("wrapper"); if (w) w.scrollTop = w.scrollHeight; else window.scrollTo(0, document.body.scrollHeight); }).catch(() => {});
  await sleep(600);
}
async function audioState(page) {
  return page.evaluate(() => { const el = window.__ytmMedia; return el ? { src: (el.currentSrc || el.src || "").slice(0, 60), t: el.currentTime, paused: el.paused } : null; }).catch(() => null);
}
async function pollUntil(fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  return last;
}
async function newPage(browser, vpdef, vp, tag) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ...vpdef, acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  consoleErrors[`${vp}/${tag}`] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors[`${vp}/${tag}`].push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors[`${vp}/${tag}`].push("PAGEERROR " + String((e && e.message) || e).slice(0, 200)));
  await page.addInitScript(mediaHook);
  await page.addInitScript(lcpInitScript);
  instrument(page);
  await page.route("**/analytics.example.org/**", (r) => r.abort()).catch(() => {});
  return { ctx, page };
}

// ---- contexte A : profil neuf, tous les nouveaux ecrans en lecture ------------------------------
async function contextA(browser, vpdef) {
  const vp = vpdef.name;
  const { ctx, page } = await newPage(browser, vpdef, vp, "A");
  try {
    // 1. accueil premier jour : carte "Emporte 1 h", Bienvenue, album / artiste du jour, Arrive en <mois>
    await go(page, "/home", "networkidle", 1500);
    await page.locator('[data-testid="first-pack-card"], [data-testid="artist-of-day"], [data-testid="album-of-day"]').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    await sleep(2500);
    await shot(page, vp, "home_dayone");
    await homeLayout(page, `${vp}/home_dayone_layout`);
    metrics[`${vp}/home_dayone_cards`] = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      return { first_pack: q("[data-testid=first-pack-card]"), first_run: q("[data-testid=first-run]"), weekend: q("[data-testid=weekend-card]"), week: q("[data-testid=week-card]"), album_of_day: q("[data-testid=album-of-day]"), artist_of_day: q("[data-testid=artist-of-day]"), arrived_month: q("[data-testid=row-arrived-month]"), recently_added: q("[data-testid=row-recently-added]"), never_played: q("[data-testid=row-never-played]"), new_in_library: q("[data-testid=row-new-in-library]"), more_rows: q("[data-testid=home-more-rows]"), install_hint: q("[data-testid=install-hint]"), rows: [...document.querySelectorAll("[data-row]")].map((e) => e.getAttribute("data-row") + (e.getAttribute("data-folded") ? "(plie)" : "")) };
    }).catch(() => null);
    await shot(page, vp, "home_dayone_full", { fullPage: true, metrics: false });
    // artiste du jour cadre (scroll)
    if (await scrollTo(page, "[data-testid=artist-of-day]", "start")) await shot(page, vp, "home_artist_of_day", { metrics: false });
    if (await scrollTo(page, "[data-testid=row-arrived-month]", "start")) await shot(page, vp, "home_arrived_month", { metrics: false });
    const arrivedHref = await page.evaluate(() => (document.querySelector('[data-testid=row-arrived-month] a[href*="added-month"]') || {}).getAttribute?.("href") || null).catch(() => null);
    metrics[`${vp}/arrived_month_href`] = arrivedHref;

    // 2. Tes stats, profil anonyme sans ecoute
    await go(page, "/library/stats");
    await shot(page, vp, "stats_anon");

    // 3. /bienvenue
    await go(page, "/bienvenue");
    await shot(page, vp, "bienvenue");
    await shot(page, vp, "bienvenue_full", { fullPage: true, metrics: false });
    const other = page.locator("[data-testid=bienvenue-other]").first();
    if (await other.count()) { await other.click({ timeout: 3000 }).catch(() => {}); await sleep(400); await shot(page, vp, "bienvenue_other_platform", { fullPage: true, metrics: false }); }

    // 4. A propos : bibliotheque + lint, doublons
    await go(page, "/about", "networkidle", 2500);
    await page.locator("[data-testid=about-duplicates][data-state=ready], [data-testid=about-duplicates-total], [data-testid=about-duplicates-empty]").first().waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    await shot(page, vp, "about_top");
    if (await scrollTo(page, "[data-testid=about-library-lint]", "center")) await shot(page, vp, "about_lint", { metrics: false });
    if (await scrollTo(page, "[data-testid=about-duplicates]", "start")) await shot(page, vp, "about_duplicates");
    await shot(page, vp, "about_full", { fullPage: true, metrics: false });
    metrics[`${vp}/about_dups`] = await page.evaluate(() => ({ state: (document.querySelector("[data-testid=about-duplicates]") || {}).getAttribute?.("data-state"), total: (document.querySelector("[data-testid=about-duplicates-total]") || {}).getAttribute?.("data-total"), groups: document.querySelectorAll("[data-testid=about-duplicates-group]").length, lint: (document.querySelector("[data-testid=about-library-lint]") || {}).innerText })).catch(() => null);

    // 5. Albums "Sans annee"
    await go(page, "/library/albums?filter=no-year", "networkidle", 2000);
    await shot(page, vp, "albums_no_year");
    // 5b. Albums "Arrive en <mois>" (lien Voir tout de la rangee)
    if (arrivedHref) { await go(page, arrivedHref, "networkidle", 2000); await shot(page, vp, "albums_arrived_month"); }

    // 6. Genres : pliage "Genres rares"
    await go(page, "/library/genres", "networkidle", 2000);
    await shot(page, vp, "genres_top");
    await scrollBottom(page);
    await shot(page, vp, "genres_rare_folded");
    const rare = page.locator("[data-testid=genres-rare-toggle]").first();
    if (await rare.count()) { await rare.click({ timeout: 3000 }).catch(() => {}); await sleep(600); await scrollTo(page, "[data-testid=genres-rare-toggle]", "start"); await shot(page, vp, "genres_rare_open"); }
    metrics[`${vp}/genres_counts`] = await page.evaluate(() => ({ common: document.querySelectorAll("[data-testid=genre-list] li").length, rare: document.querySelectorAll("[data-testid=genre-list-rare] li").length, toggle: (document.querySelector("[data-testid=genres-rare-toggle]") || {}).innerText })).catch(() => null);

    // 7. Page artiste avec puces "Aussi sous"
    const alias = await page.evaluate(async () => { try { const r = await fetch("/api/v1/local/artists/aliases?limit=3"); const d = await r.json(); const g = d && d.groups && d.groups[0]; return g ? { id: g.id, name: g.name, aliases: (g.aliases || []).map((a) => a.name), total: d.total } : null; } catch (e) { return null; } }).catch(() => null);
    metrics[`${vp}/alias_group`] = alias;
    if (alias && alias.id) {
      await go(page, "/artist/" + alias.id, "networkidle", 2500);
      await page.locator("[data-testid=artist-aliases]").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      await shot(page, vp, "artist_aliases");
      await scrollTo(page, "[data-testid=artist-aliases]", "start");
      await shot(page, vp, "artist_aliases_chips");
      await shot(page, vp, "artist_aliases_full", { fullPage: true, metrics: false });
      metrics[`${vp}/alias_chips`] = await page.evaluate(() => [...document.querySelectorAll("[data-testid=artist-alias-chip]")].map((c) => { const r = c.getBoundingClientRect(); return { text: c.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height) }; })).catch(() => null);
    }
    // 8. Liste des artistes avec "+N variantes"
    await go(page, "/library/artists?sort=albumCount:desc", "networkidle", 2500);
    await page.evaluate(() => { const b = [...document.querySelectorAll(".artist-stats")].find((e) => /variantes?/.test(e.innerText)); if (b) b.scrollIntoView({ block: "center" }); }).catch(() => {});
    await sleep(500);
    await shot(page, vp, "artists_variants_badge");
    metrics[`${vp}/artists_badges`] = await page.evaluate(() => [...document.querySelectorAll(".artist-stats")].map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter((t) => /variantes?/.test(t)).slice(0, 5)).catch(() => null);

    // 9. Reglages : economie de donnees (switch), puis l'avis sur Hors-ligne
    await go(page, "/settings");
    await scrollTo(page, "#data-saver", "center");
    await shot(page, vp, "settings_data_saver");
    metrics[`${vp}/data_saver_switch`] = await page.evaluate(() => { const i = document.getElementById("data-saver"); const l = document.querySelector('label.switch[for="data-saver"]'); const t = document.querySelector('label[for="data-saver"]:not(.switch)'); const r = l && l.getBoundingClientRect(); return { checked: i && i.checked, switch_w: r && Math.round(r.width), switch_h: r && Math.round(r.height), label: t && t.innerText.replace(/\s+/g, " ").slice(0, 200) }; }).catch(() => null);
    const sw = page.locator('label.switch[for="data-saver"]').first();
    if (await sw.count()) {
      await sw.click({ timeout: 3000 }).catch(() => {});
      await sleep(400);
      await shot(page, vp, "settings_data_saver_on", { metrics: false });
      await spaGo(page, "/library/downloads-offline", 2500);
      await shot(page, vp, "offline_data_saver_notice");
      metrics[`${vp}/data_saver_notice`] = await page.evaluate(() => { const e = document.querySelector("[data-testid=data-saver-notice]"); return e ? { text: e.innerText.replace(/\s+/g, " ").trim(), source: e.getAttribute("data-source") } : null; }).catch(() => null);
      // Espace deplie (carte neuve, sans pack)
      const tog = page.locator("[data-testid=space-toggle]").first();
      if (await tog.count() && (await tog.getAttribute("aria-expanded")) !== "true") { await tog.click({ timeout: 3000 }).catch(() => {}); await sleep(500); }
      await shot(page, vp, "offline_space_card_open");
    }
  } catch (e) { console.log("contextA fail", vp, String(e.message || e).slice(0, 160)); }
  await ctx.close();
}

// ---- contexte B (mobile) : "Preparer 1 h" puis "Rafraichir mon pack" ---------------------------
async function contextB(browser, vpdef) {
  const vp = vpdef.name;
  const { ctx, page } = await newPage(browser, vpdef, vp, "B");
  try {
    await go(page, "/home", "networkidle", 1500);
    const card = page.locator("[data-testid=first-pack-card]").first();
    await card.waitFor({ state: "visible", timeout: 40000 }).catch(() => {});
    if (!(await card.count())) { metrics[`${vp}/first_pack`] = "card absent"; await ctx.close(); return; }
    await page.locator("[data-testid=first-pack-start]").first().click({ timeout: 8000 }).catch(() => {});
    const plan = await pollUntil(async () => page.evaluate(() => { const p = window.__ytmFirstPack; return p && (p.started === true || p.reason) ? p : null; }).catch(() => null), 40000, 500);
    metrics[`${vp}/first_pack`] = plan ? { started: plan.started, count: plan.count, seconds: plan.seconds, reason: plan.reason || null } : "no plan";
    await pollUntil(async () => (/downloads-offline/.test(page.url()) ? true : null), 15000, 300);
    await sleep(1500);
    await shot(page, vp, "offline_first_pack_running");
    await shot(page, vp, "offline_first_pack_running_full", { fullPage: true, metrics: false });
    // on laisse le pack avancer (au plus 150 s), puis on capture l'etat atteint
    const done = await pollUntil(async () => page.evaluate(() => { const p = document.querySelector("[data-testid=pack-progress]"); const st = p && p.getAttribute("data-state"); const txt = (document.querySelector("[data-testid=offline-space]") || {}).innerText || ""; return !p || /done|finished|termin/i.test(String(st)) || /Pack terminé|prêts hors-ligne/.test(txt) ? (st || "no-progress") : null; }).catch(() => null), 150000, 3000);
    metrics[`${vp}/first_pack_state_after_wait`] = done || "still running";
    await go(page, "/library/downloads-offline", "networkidle", 2500);
    await shot(page, vp, "offline_after_first_pack");
    await shot(page, vp, "offline_after_first_pack_full", { fullPage: true, metrics: false });
    const tog = page.locator("[data-testid=space-toggle]").first();
    if (await tog.count() && (await tog.getAttribute("aria-expanded")) !== "true") { await tog.click({ timeout: 3000 }).catch(() => {}); await sleep(500); }
    const refresh = page.locator("[data-testid=pack-refresh]").first();
    metrics[`${vp}/pack_refresh_button`] = (await refresh.count()) ? { disabled: await refresh.isDisabled().catch(() => null), count: await refresh.getAttribute("data-pack-count").catch(() => null) } : "absent";
    if (await refresh.count()) {
      await scrollTo(page, "[data-testid=pack-refresh]", "center");
      await shot(page, vp, "offline_pack_refresh_button");
      if (!(await refresh.isDisabled().catch(() => true))) {
        await refresh.click({ timeout: 5000 }).catch(() => {});
        await page.locator("[data-testid=pack-refresh-preview]").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
        await sleep(500);
        await shot(page, vp, "offline_pack_refresh_preview");
        metrics[`${vp}/pack_refresh_preview`] = await page.evaluate(() => { const e = document.querySelector("[data-testid=pack-refresh-preview]"); return e ? { count: e.getAttribute("data-count"), add: e.getAttribute("data-add"), title: (e.querySelector("#offline-pack-refresh-preview") || {}).innerText, text: e.innerText.replace(/\s+/g, " ").slice(0, 300) } : null; }).catch(() => null);
        await page.locator("[data-testid=pack-refresh-cancel]").first().click({ timeout: 3000 }).catch(() => {});
      }
    }
    await go(page, "/home", "networkidle", 2500);
    await shot(page, vp, "home_after_first_pack");
    await homeLayout(page, `${vp}/home_after_first_pack_layout`);
  } catch (e) { console.log("contextB fail", vp, String(e.message || e).slice(0, 160)); }
  await ctx.close();
}

// ---- contexte C (mobile, UA iPhone) : premier son -> barre d'installation, stats apres ecoute ----
async function contextC(browser, vpdef) {
  const vp = vpdef.name;
  const { ctx, page } = await newPage(browser, vpdef, vp, "C");
  try {
    await go(page, "/home", "networkidle", 2500);
    metrics[`${vp}/install_hint_on_first_paint`] = await page.locator("[data-testid=install-hint]").count();
    await go(page, "/search/" + encodeURIComponent(QUERY) + "?filter=library", "networkidle", 2000);
    let row = page.getByText(/Song\s*•/).first();
    if (!(await row.isVisible({ timeout: 8000 }).catch(() => false))) { await go(page, "/search/" + encodeURIComponent(QUERY), "networkidle", 2000); row = page.getByText(/Song\s*•/).first(); }
    await shot(page, vp, "search_before_sound");
    await row.click({ position: { x: 8, y: 8 }, timeout: 8000 }).catch((e) => console.log("row click", e.message.split("\n")[0]));
    const played = await pollUntil(async () => { const s = await audioState(page); return s && s.src && s.t > 1 ? s : null; }, 30000, 500);
    metrics[`${vp}/played`] = played;
    await page.locator("[data-testid=install-hint]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await sleep(800);
    await shot(page, vp, "search_install_hint_after_sound");
    metrics[`${vp}/install_hint`] = await page.evaluate(() => { const e = document.querySelector("[data-testid=install-hint]"); if (!e) return null; const r = e.getBoundingClientRect(); const f = document.querySelector("footer"); const fr = f && f.getBoundingClientRect(); return { text: e.innerText.replace(/\s+/g, " ").trim(), top: Math.round(r.top), h: Math.round(r.height), dock: e.getAttribute("data-dock"), footer_top: fr && Math.round(fr.top), reserve: getComputedStyle(document.documentElement).getPropertyValue("--install-hint-reserve") }; }).catch(() => null);
    await spaGo(page, "/home", 3000);
    await page.locator('[data-row="pour-toi"], [data-row="recemment-acquis"], [data-testid=album-of-day]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await sleep(800);
    await shot(page, vp, "home_player_install_hint");
    await homeLayout(page, `${vp}/home_player_install_hint_layout`);
    await shot(page, vp, "home_player_install_hint_full", { fullPage: true, metrics: false });
    // une ecoute compte apres 30 s : on attend puis Tes stats
    await sleep(32000);
    await spaGo(page, "/library/stats", 3000);
    await shot(page, vp, "stats_after_one_play");
    await shot(page, vp, "stats_after_one_play_full", { fullPage: true, metrics: false });
    // Hors-ligne avec le lecteur et la barre (empilement en bas)
    await spaGo(page, "/library/downloads-offline", 2500);
    await shot(page, vp, "offline_player_install_hint");
  } catch (e) { console.log("contextC fail", vp, String(e.message || e).slice(0, 160)); }
  await ctx.close();
}

// ---- contexte D : login "harness" -> Tes stats avec historique (Ton mois, serie, horloge, annee) --
async function contextD(browser, vpdef) {
  const vp = vpdef.name;
  const { ctx, page } = await newPage(browser, vpdef, vp, "D");
  try {
    await go(page, "/home", "networkidle", 1000);
    // c53c (B9-25): loginAs pattern of harness-core.cjs (POST me/login + drop the 5 min "ytm-whoami" memo, else the
    // page keeps the anonymous whoami), two seeded plays on the fixture ids, then a reload so the app logs in.
    const name = "harness-shots-" + Date.now().toString(36);
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
    metrics[`${vp}/login_harness`] = { name, status: login, seeds, stored: seeds.filter((s) => s.status === 200 && !s.ignored).length };
    await go(page, "/library/stats", "networkidle", 3000);
    await page.locator("[data-testid=stats-summary]").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    await page.locator("[data-testid=stats-year], [data-testid=stats-summary].empty").first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
    await sleep(1000);
    await shot(page, vp, "stats_month");
    for (const d of [7, 365]) {
      const b = page.locator(`[data-testid=stats-period-${d}]`).first();
      if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(2500); await shot(page, vp, `stats_period_${d}`); }
    }
    if (await scrollTo(page, "[data-testid=stats-streak]", "start")) await shot(page, vp, "stats_streak_clock");
    if (await scrollTo(page, "[data-testid=stats-year]", "start")) await shot(page, vp, "stats_year");
    if (await scrollTo(page, "[data-testid=stats-decades]", "center")) await shot(page, vp, "stats_decades", { metrics: false });
    await shot(page, vp, "stats_full", { fullPage: true, metrics: false });
    metrics[`${vp}/stats_sections`] = await page.evaluate(() => ({ summary: !!document.querySelector("[data-testid=stats-summary]"), streak: !!document.querySelector("[data-testid=stats-streak]"), clock: !!document.querySelector("[data-testid=stats-clock]"), year: !!document.querySelector("[data-testid=stats-year]"), decades: !!document.querySelector("[data-testid=stats-decades]"), share_week: document.querySelectorAll("[data-testid=share-week]").length, share_year: document.querySelectorAll("[data-testid=share-year]").length, h2: [...document.querySelectorAll("main h2, main h1")].map((h) => h.innerText.trim().slice(0, 40)) })).catch(() => null);
    // accueil connecte : carte semaine / artiste du jour (nomme) / rangees
    await go(page, "/home", "networkidle", 3000);
    await shot(page, vp, "home_logged_in");
    await homeLayout(page, `${vp}/home_logged_in_layout`);
    await shot(page, vp, "home_logged_in_full", { fullPage: true, metrics: false });
    // Compte (prenom conserve, c48)
    await go(page, "/library/account", "networkidle", 1500);
    await shot(page, vp, "account_logged_in");
  } catch (e) { console.log("contextD fail", vp, String(e.message || e).slice(0, 160)); }
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({
    headless: true, chromiumSandbox: false,
    channel: process.env.PW_CHANNEL || undefined,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage", ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])],
  });
  for (const v of VIEWPORTS) {
    console.log("=== viewport", v.name);
    try { await contextA(browser, v); } catch (e) { console.log("A FAIL", v.name, e.message); }
    if (v.name === "mobile") {
      try { await contextC(browser, v); } catch (e) { console.log("C FAIL", v.name, e.message); }
      try { await contextB(browser, v); } catch (e) { console.log("B FAIL", v.name, e.message); }
    }
    try { await contextD(browser, v); } catch (e) { console.log("D FAIL", v.name, e.message); }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(OUT, "console.json"), JSON.stringify(consoleErrors, null, 2));
  fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify(shots, null, 2));
  fs.writeFileSync(path.join(OUT, "index.md"), shots.map((s) => `- ${s.file}  (${s.url})`).join("\n") + "\n");
  console.log(`\n${shots.length} captures -> ${OUT}`);
})();
