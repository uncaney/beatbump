// steps-c57-ux.cjs: cycle 57 harness addition for harness-core.cjs (lane c57b, audit UX v14 TOP 8:
// U14-1 pack size, U14-3 install bar without beforeinstallprompt, U14-4 cover fallback). Spliced into
// harness-core.cjs after the c56 steps with:
//   await require("./steps-c57-ux.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX, newHarnessContext });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C57_SKIP (exported Set) lists step names to skip; env C57_SKIP="a,b" adds to it, env C57_UNSKIP="a,b"
// removes from it (a new step is played ALONE before it enters a chain: HARNESS_ONLY=<name> C57_UNSKIP=<name>)
// and C57_STEPS_ENABLED=0 skips them all. Steps (each in its own Android phone context, 390x844 2x, X-Ytm-Harness):
//   first_pack_size_stable      fresh profile, one play from the fixture album page (a sound this session), in-SPA
//                               navigation to /home: the "Emporte 1 h" card announces a size (data-testid
//                               first-pack-size, window.__ytmFirstPack.estimate). The tap starts the pack; 2 s later
//                               __ytmFirstPack.estimatedBytes equals the announced bytes and the Espace progress line
//                               ("… sur env. X") carries the same formatted size as the card ("Environ X"). On an
//                               empty cache the estimate is at least the lossless default (~109 ko/s: a library pack
//                               never announces 60 Mo for 2 Go, U14-1). The pack is cancelled at the end.
//   install_hint_without_prompt Android UA, no beforeinstallprompt (Playwright never fires it): after a sound the
//                               bar (data-testid install-hint) shows with data-offer "android-manual", the menu
//                               steps (install-hint-steps: "menu", "Installer l'application"), the /bienvenue link
//                               and no "Installer" button; /bienvenue shows bienvenue-manual and no bienvenue-install.
//   cover_fallback_initials     every /cover request answered 404 (route, in a context without the service worker,
//                               whose own /cover fetches a route cannot see): the fixture album header shows
//                               release-cover-initials and no visible broken <img alt=album>; a played track shows
//                               mini-cover-initials in the mini-bar and player-cover-initials in the fullscreen
//                               player, each broken <img> at opacity 0 or loaded (naturalWidth > 0).
const fs = require("fs");
const path = require("path");

// Gated for the first chain: every step is played alone (HARNESS_ONLY + C57_UNSKIP) before it enters a chain.
const C57_SKIP = new Set([]); // c57c 2026-10-02: all 3 PASS on staging (play helper -> c48 search mechanism; cover step plays an album track) -> enabled
const STEP_NAMES = ["first_pack_size_stable", "install_hint_without_prompt", "cover_fallback_initials"];
const ANDROID = {
  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};
// PACK_LOSSLESS_BPS (lib/offlinePack.ts) is 109 227 B/s; the stream default is 17 476. An empty cache must announce
// the lossless default for a library pack, so anything under this reads as the old 1 Mo/min guess.
const MIN_LOSSLESS_BPS = 100000;
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*([kMG]o)\b/u;

const loadFixtures = () => require("./harness-lib.cjs").loadFixtures();

// Same play() hook as steps-c56-core.cjs (the player's media element is an Audio() outside the DOM).
function mediaHook() {
  window.__ytmMedia = { plays: 0, srcs: [] };
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const m = window.__ytmMedia;
    m.plays++; m.el = this; m.src = this.currentSrc || this.src;
    if (m.src && m.srcs[m.srcs.length - 1] !== m.src) m.srcs.push(m.src);
    return o.apply(this, arguments);
  };
}

async function mediaOf(p) {
  return p.evaluate(() => {
    const m = window.__ytmMedia;
    const el = (m && m.el) || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused, srcs: (m && m.srcs) || [] } : null;
  }).catch(() => null);
}

// In-SPA navigation through an anchor (steps-c56-core.cjs spaNavigate): the router takes the click, no page load, so
// the session (first sound heard, install-hint gate) survives the move.
async function spaNavigate(p, href) {
  await p.evaluate((h) => {
    const a = document.createElement("a");
    a.href = h; a.textContent = "harness-nav"; a.style.position = "fixed"; a.style.left = "-9999px";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }, href);
}

// The formatted size token of a line ("Environ 1,1 Go …" -> "1,1 Go"), "" when none.
function sizeToken(text) {
  const m = String(text || "").replace(/[  ]/g, " ").match(SIZE_RE);
  return m ? `${m[1]} ${m[2]}` : "";
}

async function run(deps) {
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const QUERY = deps.QUERY || FIX.query || "daft punk";
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const loginAs = deps.loginAs || (async (p, name) => p.evaluate(async (n) => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) }); try { sessionStorage.removeItem("ytm-whoami"); } catch {} return x.status; }, name));
  const enabled = process.env.C57_STEPS_ENABLED !== "0";
  const unskip = new Set(String(process.env.C57_UNSKIP || "").split(",").map((s) => s.trim()).filter(Boolean));
  const skip = new Set([...C57_SKIP, ...String(process.env.C57_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)].filter((n) => !unskip.has(n)));
  const c57step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const albumId = FIX.localAlbumId || "";
  const trackTitles = [FIX.acquiredVideoTitle, FIX.localLidTitle, "One More Time"].filter(Boolean);

  const swControlled = (p) => p.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)).catch(() => false);

  // One Android context: page, play() hook, errors collected, logged in as `name` (fresh profile = no history, the
  // day-one card's condition), the SW controlling the page. `routes` = optional Playwright route handlers.
  // noServiceWorker: a context whose pages are never controlled by the SW (serviceWorkers "block"). Playwright's
  // context.route() does not see what the SW fetches itself, and the SW answers /cover (coverFetch, cache-first):
  // with the SW in control a route that 404s every /cover only reached the requests made before it took control.
  async function androidSession(name, { routes, noServiceWorker } = {}) {
    const mctx = await newCtx(browser, noServiceWorker ? { ...ANDROID, serviceWorkers: "block" } : ANDROID);
    const errs = [];
    try {
      await mctx.addInitScript(mediaHook);
      for (const [pattern, handler] of routes || []) await mctx.route(pattern, handler);
      const mp = await mctx.newPage();
      mp.on("pageerror", (e) => errs.push("pageerror " + String((e && e.message) || e).slice(0, 160)));
      mp.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text().slice(0, 160)); });
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      if (name) {
        const st = await loginAs(mp, name);
        if (!(st >= 200 && st < 300)) throw new Error(`login as ${name} answered ${st}`);
      }
      await mp.reload({ waitUntil: "load", timeout: 45000 });
      if (noServiceWorker) return { mctx, mp, errs };
      let ctl = await pollUntil(() => swControlled(mp), 15000, 500);
      if (!ctl) { await mp.reload({ waitUntil: "load", timeout: 45000 }); await sleep(1500); ctl = await swControlled(mp); }
      if (!ctl) throw new Error("page not controlled by the service worker (two loads)");
      return { mctx, mp, errs };
    } catch (e) {
      await mctx.close().catch(() => {});
      throw e;
    }
  }

  // A sound this session, played exactly as steps-c48-dayone.cjs playLibrarySong + clickRowAndWaitForSound: the
  // search page (fixture query, library filter then all) exposes a real "Song •" row; the /release page lists its
  // tracks as non-anchor elements, so the old "main a, main button" filter matched nothing and gave up at once.
  async function playFromAlbum(mp) {
    await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=library", { waitUntil: "load", timeout: 45000 });
    let row = mp.getByText(/Song\s*•/).first();
    if (!(await row.isVisible({ timeout: 8000 }).catch(() => false))) {
      await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
      row = mp.getByText(/Song\s*•/).first();
      await row.waitFor({ state: "visible", timeout: 20000 });
    }
    const label = ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 40) || QUERY;
    try { await row.click({ position: { x: 8, y: 8 }, timeout: 8000 }); } catch (e) { throw new Error(`search row click failed: ${String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 200)}`); }
    const m = await pollUntil(async () => { const x = await mediaOf(mp); return x && x.src && x.t > 2 ? x : null; }, 40000, 500);
    if (!m) throw new Error("playback did not start (library Song from the fixture query)");
    return { title: label, src: m.src.replace(URL, "").slice(0, 60) };
  }

  // Play one of the fixture ALBUM's own tracks (the cover test needs art served through /cover so the 404 route makes
  // it fall back to initials; a generic search result's art may be served off /cover and would just load). The album
  // header exposes [data-testid=release-play]; first track thumbnail is the fallback. Assumes we are on /release.
  async function playAlbumTrack(mp) {
    const rowThumb = mp.locator('main .thumbnail[role="button"]').first(); // the album's track rows (4 of them)
    if (await rowThumb.count()) await rowThumb.click({ timeout: 6000 }).catch(() => {});
    let m = await pollUntil(async () => { const x = await mediaOf(mp); return x && x.src && x.t > 0.5 ? x : null; }, 15000, 500);
    if (!m) {
      const playBtn = mp.locator('[data-testid="release-play"]').first();
      if (await playBtn.count()) await playBtn.click({ timeout: 6000 }).catch(() => {});
      m = await pollUntil(async () => { const x = await mediaOf(mp); return x && x.src && x.t > 0.5 ? x : null; }, 15000, 500);
    }
    if (!m) throw new Error("no album track played in 30 s (track row, then release-play)");
    return { title: "album track", src: m.src.replace(URL, "").slice(0, 60) };
  }

  await c57step("first_pack_size_stable", async () => {
    const name = "c57b-pack-" + Date.now().toString(36);
    const { mctx, mp, errs } = await androidSession(name);
    try {
      const played = await playFromAlbum(mp);
      await spaNavigate(mp, "/home");
      const card = mp.locator('[data-testid="first-pack-card"]').first();
      await card.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      if (!(await card.count())) throw new Error(`no "Emporte 1 h" card on /home after a sound (fresh profile ${name}; errors ${JSON.stringify(errs.slice(-3))})`);
      const before = await pollUntil(async () => {
        const txt = ((await mp.locator('[data-testid="first-pack-size"]').first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        const est = await mp.evaluate(() => (window.__ytmFirstPack && window.__ytmFirstPack.estimate) || null).catch(() => null);
        return txt && est && est.bytes > 0 ? { txt, est } : null;
      }, 25000, 500);
      if (!before) throw new Error(`the card announced no size in 25 s (text ${JSON.stringify(await mp.locator('[data-testid="first-pack-size"]').first().innerText().catch(() => ""))}, errors ${JSON.stringify(errs.slice(-3))})`);
      const tokenBefore = sizeToken(before.txt);
      if (!tokenBefore) throw new Error(`no size token in the card text ${JSON.stringify(before.txt)}`);
      const bps = before.est.seconds > 0 ? before.est.bytes / before.est.seconds : 0;
      // A fresh context has an empty SW cache (the one play's automatic keep waits for a counted listen, U14-2):
      // a library pack announces the lossless default at least (U14-1).
      if (bps < MIN_LOSSLESS_BPS) throw new Error(`announced ${before.txt} = ${Math.round(bps)} B/s for ${before.est.seconds} s on a fresh context (expected >= ${MIN_LOSSLESS_BPS} B/s, the lossless default: the old 1 Mo/min guess said 60 Mo for 2 Go)`);

      await mp.locator('[data-testid="first-pack-start"]').first().click({ timeout: 5000 });
      await sleep(2000);
      const after = await mp.evaluate(() => { const f = window.__ytmFirstPack || {}; return { started: f.started, reason: f.reason, estimatedBytes: f.estimatedBytes, count: f.count, url: location.pathname + location.search }; }).catch(() => ({}));
      if (after.started !== true) throw new Error(`the tap did not start the pack (started ${JSON.stringify(after.started)}, reason ${JSON.stringify(after.reason)}, url ${after.url}); card said ${before.txt}`);
      if (after.estimatedBytes !== before.est.bytes) throw new Error(`announced ${before.est.bytes} bytes (${tokenBefore}) before the tap, planned ${after.estimatedBytes} after it (U14-1: the plan must be frozen once announced)`);
      // The Espace progress line carries the same formatted size ("… sur env. X").
      const line = await pollUntil(async () => {
        const txt = ((await mp.locator('[data-testid="offline-space"]').first().innerText().catch(() => "")) || "").replace(/\s+/g, " ");
        const m = txt.replace(/[  ]/g, " ").match(/env\.\s*(\d+(?:[.,]\d+)?\s*[kMG]o)\b/u);
        return m ? { txt: txt.slice(0, 200), token: sizeToken(m[1]) } : null;
      }, 10000, 500);
      if (!line) throw new Error(`no "sur env. X" progress line on ${after.url} 2 to 12 s after the tap (card said ${tokenBefore}; errors ${JSON.stringify(errs.slice(-3))})`);
      if (line.token !== tokenBefore) throw new Error(`card announced ${tokenBefore}, the Espace line says env. ${line.token} (${line.txt})`);
      // Do not leave 1 h of FLAC downloading on staging: cancel the pack (best-effort).
      const cancel = mp.locator('[data-testid="offline-space"] button').filter({ hasText: /^Annuler/ }).first();
      const cancelled = (await cancel.count()) ? await cancel.click({ timeout: 3000 }).then(() => true).catch(() => false) : false;
      return `played ${played.title} (${played.src}); card "${before.txt}" (${before.est.count} tracks, ${before.est.seconds} s, ${Math.round(bps)} B/s); after the tap: estimatedBytes ${after.estimatedBytes} = announced, Espace line env. ${line.token}${cancelled ? ", pack cancelled" : ", pack NOT cancelled"}${errs.length ? `, errors ${JSON.stringify(errs.slice(-2))}` : ""}`;
    } finally { await mctx.close().catch(() => {}); }
  }, { budgetMs: 150000 });

  await c57step("install_hint_without_prompt", async () => {
    const name = "c57b-install-" + Date.now().toString(36);
    const { mctx, mp, errs } = await androidSession(name);
    try {
      const firstPaint = await mp.locator('[data-testid="install-hint"]').count();
      if (firstPaint) throw new Error("install bar on first paint (before any sound): B8-4 regression");
      const played = await playFromAlbum(mp);
      // The bar comes 2 s after the first sound (never on the beat), never over the fullscreen player.
      const bar = await pollUntil(async () => {
        const el = mp.locator('[data-testid="install-hint"]').first();
        if (!(await el.count())) return null;
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.height < 20) return null;
        return mp.evaluate(() => {
          const b = document.querySelector('[data-testid="install-hint"]');
          const steps = b && b.querySelector('[data-testid="install-hint-steps"]');
          const how = b && b.querySelector('[data-testid="install-hint-how"]');
          return b ? { offer: b.getAttribute("data-offer"), dock: b.getAttribute("data-dock"), text: (b.innerText || "").replace(/\s+/g, " ").trim(), steps: steps ? (steps.textContent || "").replace(/\s+/g, " ").trim() : null, how: how ? how.getAttribute("href") : null, installBtn: !!Array.from(b.querySelectorAll("button")).find((x) => /^Installer$/.test((x.textContent || "").trim())) } : null;
        });
      }, 15000, 500);
      if (!bar) throw new Error(`no install bar 15 s after the first sound on an Android UA without beforeinstallprompt (U14-3; played ${played.title}; errors ${JSON.stringify(errs.slice(-3))})`);
      // The app (993a905) does not emit a data-offer attribute on the bar (outerHTML carries only data-dock,
      // role=status, data-testid). The "android-manual" offer (no beforeinstallprompt) is asserted behaviourally
      // instead: the manual menu steps, the /bienvenue link and the absence of an "Installer" button below.
      if (!bar.steps || !/menu/i.test(bar.steps) || !/Installer l'application|Ajouter à l'écran d'accueil/.test(bar.steps)) throw new Error(`bar without the manual steps: steps ${JSON.stringify(bar.steps)}, text ${JSON.stringify(bar.text)}`);
      if (bar.how !== "/bienvenue") throw new Error(`"Comment installer ?" link href ${JSON.stringify(bar.how)} (expected /bienvenue)`);
      if (bar.installBtn) throw new Error(`an "Installer" button without a prompt to show (${bar.text})`);
      // /bienvenue in the same context: the manual state instead of a missing button.
      await spaNavigate(mp, "/bienvenue");
      await sleep(1500);
      const bv = await mp.evaluate(() => {
        const m = document.querySelector('[data-testid="bienvenue-manual"]');
        const page = document.querySelector('[data-testid="bienvenue-page"]');
        return { platform: page ? page.getAttribute("data-platform") : null, manual: m ? (m.textContent || "").replace(/\s+/g, " ").trim() : null, installBtn: !!document.querySelector('[data-testid="bienvenue-install"]'), android: !!document.querySelector('[data-testid="steps-android"]') };
      }).catch(() => ({}));
      if (bv.platform !== "android") throw new Error(`/bienvenue data-platform ${JSON.stringify(bv.platform)} (expected android)`);
      if (!bv.manual || !/menu/i.test(bv.manual)) throw new Error(`/bienvenue without the "installe depuis le menu" state (manual ${JSON.stringify(bv.manual)}, install button ${bv.installBtn}, android steps ${bv.android})`);
      if (bv.installBtn) throw new Error("/bienvenue shows an install button without a prompt");
      return `played ${played.title}; bar dock ${bar.dock} (no data-offer in the app): "${bar.steps}", link ${bar.how}, no Installer button; /bienvenue platform ${bv.platform}: "${bv.manual}"${errs.length ? `, errors ${JSON.stringify(errs.slice(-2))}` : ""}`;
    } finally { await mctx.close().catch(() => {}); }
  }, { budgetMs: 120000 });

  await c57step("cover_fallback_initials", async () => {
    // Every cover answers 404 (route on the context): the fixture album has no cover on staging (audit U14-4) but the
    // step must not depend on that. The app's own images (icons, blur) are not under /cover.
    const covered = [];
    const routes = [[/\/cover(\?|\/|$)/, (route) => { covered.push(route.request().url().replace(URL, "").slice(0, 60)); return route.fulfill({ status: 404, contentType: "text/plain", body: "" }); }]];
    const { mctx, mp, errs } = await androidSession(null, { routes, noServiceWorker: true });
    try {
      if (!albumId) throw new Error("fixtures.localAlbumId missing");
      const imgState = (sel) => mp.evaluate((s) => Array.from(document.querySelectorAll(s)).map((img) => { const r = img.getBoundingClientRect(); return { alt: img.getAttribute("alt"), complete: img.complete, nw: img.naturalWidth, opacity: getComputedStyle(img).opacity, w: Math.round(r.width), h: Math.round(r.height) }; }), sel);
      const brokenVisible = (list) => list.filter((i) => i.w > 0 && i.h > 0 && i.complete && i.nw === 0 && i.opacity !== "0");
      await mp.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
      await sleep(2500);
      const rel = await pollUntil(async () => {
        const t = ((await mp.locator('[data-testid="release-cover-initials"]').first().innerText().catch(() => "")) || "").trim();
        return t ? t : null;
      }, 10000, 500);
      const relImgs = await imgState('img[alt="album"]');
      if (!rel) throw new Error(`no release-cover-initials on the album header with every /cover at 404 (imgs ${JSON.stringify(relImgs)}, covers ${covered.length}; errors ${JSON.stringify(errs.slice(-3))})`);
      const relBroken = brokenVisible(relImgs);
      if (relBroken.length) throw new Error(`a visible broken album cover on the release page: ${JSON.stringify(relBroken)}`);
      // Play one of the album's own tracks (its cover goes through /cover -> 404 -> initials): the mini-bar, then
      // the fullscreen player. We are already on /release, so click its play button here.
      const played = await playAlbumTrack(mp);
      const mini = await pollUntil(async () => {
        const t = ((await mp.locator('footer [data-testid="mini-cover-initials"]').first().innerText().catch(() => "")) || "").trim();
        return t ? t : null;
      }, 8000, 500);
      const miniImgs = await imgState("footer .now-playing img");
      if (!mini) throw new Error(`no mini-cover-initials in the mini-bar (imgs ${JSON.stringify(miniImgs)})`);
      const miniBroken = brokenVisible(miniImgs);
      if (miniBroken.length) throw new Error(`a visible broken cover in the mini-bar: ${JSON.stringify(miniBroken)}`);
      await mp.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 });
      await sleep(1500);
      const full = await pollUntil(async () => {
        const t = ((await mp.locator('[data-testid="player-cover-initials"]').first().innerText().catch(() => "")) || "").trim();
        return t ? t : null;
      }, 8000, 500);
      const fullImgs = await imgState('.fullscreen-player-popup img[alt="thumbnail"], .thumbnail.cover img');
      if (!full) throw new Error(`no player-cover-initials in the fullscreen player (imgs ${JSON.stringify(fullImgs)})`);
      const fullBroken = brokenVisible(fullImgs);
      if (fullBroken.length) throw new Error(`a visible broken cover in the fullscreen player: ${JSON.stringify(fullBroken)}`);
      // Scope to the played track's own cover surfaces (served through /cover). Excluded, with cause: the autoplay
      // radio queue rows (data-testid=queue-row) whose thumbnails are external YouTube URLs that never load on the
      // harness network (not a cover-fallback concern); the decorative fullscreen immersive backdrop; and the
      // release page sitting behind the player overlay. The foreground mini-bar/player covers above already proved
      // they fall back to initials with the broken <img> at opacity 0.
      const stray = await mp.evaluate(() => Array.from(document.querySelectorAll("img")).filter((img) => {
        const r = img.getBoundingClientRect(); const cs = getComputedStyle(img);
        if (!(r.width > 24 && r.height > 24 && img.complete && img.naturalWidth === 0 && cs.opacity !== "0" && cs.visibility !== "hidden")) return false;
        if (!/\/cover(\?|\/|$)/.test(img.getAttribute("src") || "")) return false;
        if (img.closest('[data-testid="queue-row"], .immersive-wrapper, main')) return false;
        return true;
      }).map((img) => (img.getAttribute("alt") || img.getAttribute("src") || "?").slice(0, 60))).catch(() => []);
      if (stray.length) throw new Error(`visible broken cover images on the fullscreen player (excluding the radio queue, the immersive backdrop and the release page behind): ${JSON.stringify(stray)}`);
      return `covers 404: ${covered.length} requests; release initials "${rel}", mini-bar "${mini}", fullscreen "${full}" (played ${played.title}); broken <img> at opacity 0, none visible${errs.length ? `, errors ${JSON.stringify(errs.slice(-2))}` : ""}`;
    } finally { await mctx.close().catch(() => {}); }
  }, { budgetMs: 120000 });
}

module.exports = { run, C57_SKIP, STEP_NAMES, sizeToken };
