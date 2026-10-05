// steps-c56-core.cjs: cycle 56 harness addition for harness-core.cjs (lane c56a, offline play on the phone:
// integration d8054d4, dacdaa3, 3d63cbe). Spliced into harness-core.cjs after the c54 steps with:
//   await require("./steps-c56-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX, newHarnessContext });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C56_SKIP (exported Set) lists step names to skip; env C56_SKIP="a,b" adds to it and
// C56_STEPS_ENABLED=0 skips them all. Steps (each in its own Android phone context, 390x844 2x, X-Ytm-Harness):
//   weekend_pack_no_black_screen  fresh profile (loginAs), fixture album kept offline, one play seeded, then from
//                                 /home a client-side navigation to /library/downloads-offline?pack=dur:7200 (the
//                                 home "Préparer 2 h" card when it is rendered, Friday to Sunday, else an in-SPA
//                                 anchor click like the lane's probe). 1.5 s later: exactly one .app-transition-wrapper,
//                                 none with an inline style.animation, #wrapper.scrollTop < 100, pack-size "dur:7200",
//                                 the Espace heading visible, body text > 200 chars and the centre of a screenshot not
//                                 uniformly black (PNG decoded here, no dependency). Before dacdaa3 the outgoing home
//                                 page stayed in flow at opacity 0 for ever (Svelte 4 outro counter), black screen.
//   offline_local_never_youtube   kept album, /library/downloads-offline "Tout lire": no request to
//                                 /api/v1/player.json?videoId=<11 lowercase hex> (a library id never goes through the
//                                 YouTube path, d8054d4) and the media element src matches /localf; detail lists the srcs.
//   player_local_lid_404          fetch("/api/v1/player.json?videoId=0000000000a") from the page answers 404 with
//                                 JSON status "LOCAL_NOT_FOUND" (error "unplayable", backend/api/player.go
//                                 playerErrorResponse), twice: the second call is 404 as fast (no companion acquisition).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const C56_SKIP = new Set(); // enabled after the standalone validation run on staging 1924fa0
const STEP_NAMES = ["weekend_pack_no_black_screen", "offline_local_never_youtube", "player_local_lid_404"];
const ANDROID = {
  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};
const WEEKEND_HREF = "/library/downloads-offline?pack=dur:7200";
const LID_RE = /^[0-9a-f]{11}$/;
const UNKNOWN_LID = "0000000000a";

function loadFixtures() {
  for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

// Same play() hook as harness-core.cjs / steps-c43-ux.cjs (the player's media element is an Audio() outside the
// DOM), plus the list of every src that reached play() so the detail can name them all.
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

// In-SPA navigation through an anchor (steps-c45-stats.cjs spaNavigate): SvelteKit's router takes the click, no
// page load, so the root layout's keyed crossfade runs exactly as from the home card.
async function spaNavigate(p, href) {
  await p.evaluate((h) => {
    const a = document.createElement("a");
    a.href = h; a.textContent = "harness-nav"; a.style.position = "fixed"; a.style.left = "-9999px";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }, href);
}

// Luminance statistics of the centre half of a Playwright PNG (8-bit RGB/RGBA, non-interlaced; null otherwise).
// Enough to tell a painted page from the black outgoing block: a black screen has brightFrac ~0 and std ~0.
function pngCentreStats(buf) {
  try {
    if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
    const idat = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
      else if (type === "IDAT") idat.push(data);
      else if (type === "IEND") break;
      off += 12 + len;
    }
    if (depth !== 8 || interlace !== 0 || !(ctype === 2 || ctype === 6) || !w || !h) return null;
    const bpp = ctype === 6 ? 4 : 3;
    const stride = w * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (raw.length < h * (stride + 1)) return null;
    const out = Buffer.alloc(h * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)];
      const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const row = out.subarray(y * stride, (y + 1) * stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v = src[i];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        row[i] = v & 255;
      }
      prev = row;
    }
    let n = 0, sum = 0, sq = 0, bright = 0;
    for (let y = Math.floor(h / 4); y < Math.floor((3 * h) / 4); y += 4) {
      for (let x = Math.floor(w / 4); x < Math.floor((3 * w) / 4); x += 4) {
        const i = y * stride + x * bpp;
        const l = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
        n++; sum += l; sq += l * l; if (l > 40) bright++;
      }
    }
    if (!n) return null;
    const mean = sum / n;
    return { w, h, n, mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), brightFrac: bright / n };
  } catch { return null; }
}

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const loginAs = deps.loginAs || (async (p, name) => p.evaluate(async (n) => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) }); try { sessionStorage.removeItem("ytm-whoami"); } catch {} return x.status; }, name));
  const enabled = process.env.C56_STEPS_ENABLED !== "0";
  const skip = new Set([...C56_SKIP, ...String(process.env.C56_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c56step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const albumId = FIX.localAlbumId || "";
  const trackTitles = [FIX.acquiredVideoTitle, FIX.localLidTitle, "One More Time"].filter(Boolean);

  const swControlled = (p) => p.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)).catch(() => false);

  // One Android context: page, play() hook, page errors collected; logged in as `name`; the fixture album kept
  // offline (the SW cache is per context, so every step keeps it again: 4 tracks, served from /localf); optionally
  // one play seeded from the album page (the Espace card and the home card read favourites / recent plays).
  async function androidSession(name, { seedPlay } = {}) {
    if (!albumId) throw new Error("fixtures.localAlbumId missing (no album to keep offline)");
    const mctx = await newCtx(browser, ANDROID);
    const errs = [];
    const notes = [];
    try {
      await mctx.addInitScript(mediaHook);
      const mp = await mctx.newPage();
      mp.on("pageerror", (e) => errs.push("pageerror " + String((e && e.message) || e).slice(0, 160)));
      mp.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text().slice(0, 160)); });
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const st = await loginAs(mp, name);
      if (!(st >= 200 && st < 300)) throw new Error(`login as ${name} answered ${st}`);
      await mp.reload({ waitUntil: "load", timeout: 45000 });
      // The SW must control the client before the keep (cache-audio goes through it) and before "Tout lire".
      let ctl = await pollUntil(() => swControlled(mp), 15000, 500);
      if (!ctl) { await mp.reload({ waitUntil: "load", timeout: 45000 }); await sleep(1500); ctl = await swControlled(mp); }
      if (!ctl) throw new Error("page not controlled by the service worker after login (two loads)");

      await mp.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
      const keep = mp.locator('[data-testid="keep-offline"]').first();
      await keep.waitFor({ state: "visible", timeout: 20000 });
      const before = await keep.getAttribute("data-state").catch(() => null);
      if (before !== "ready") {
        await keep.click({ timeout: 5000 });
        const fin = await pollUntil(async () => ((await keep.getAttribute("data-state").catch(() => null)) === "ready" ? "ready" : null), 90000, 1000);
        if (fin !== "ready") throw new Error(`keep of ${albumId} not ready after 90 s (data-state=${await keep.getAttribute("data-state").catch(() => "?")}, ${await keep.getAttribute("data-ready").catch(() => "?")}/${await keep.getAttribute("data-total").catch(() => "?")})`);
      }
      notes.push(`album ${albumId} ${before === "ready" ? "already ready" : "kept"}`);

      if (seedPlay) {
        let played = null;
        for (const title of trackTitles) {
          const row = mp.locator("main a, main button").filter({ hasText: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
          if (!(await row.count())) continue;
          await row.click({ timeout: 5000 }).catch(() => {});
          const m = await pollUntil(async () => { const x = await mediaOf(mp); return x && x.t > 1 ? x : null; }, 15000, 500);
          if (m) { played = { title, src: m.src }; break; }
        }
        notes.push(played ? `play seeded (${played.title}, src ${played.src.replace(URL, "").slice(0, 60)})` : "play NOT seeded (no track row played in 15 s)");
      }
      return { mctx, mp, errs, notes };
    } catch (e) {
      await mctx.close().catch(() => {});
      throw e;
    }
  }

  await c56step("weekend_pack_no_black_screen", async () => {
    const name = "c56b-weekend-" + Date.now().toString(36);
    const s = await androidSession(name, { seedPlay: true });
    const { mctx, mp, errs, notes } = s;
    try {
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      // The home settles (personal rows, the weekend card decides whether to show) before the in-SPA navigation.
      await sleep(3000);
      const homeBefore = await mp.evaluate(() => ({ wrappers: document.querySelectorAll(".app-transition-wrapper").length, card: !!document.querySelector('[data-testid="weekend-card-start"]') }));
      // The card's own link when it is rendered (Friday to Sunday, pack material present): a programmatic click,
      // so the home scroll position is left alone (Playwright's click would scroll the card into view first).
      // Otherwise an anchor click, the exact sequence of the lane's probe (probe-c56a-stall.cjs).
      let via;
      if (homeBefore.card) {
        via = "weekend-card-start";
        await mp.evaluate(() => document.querySelector('[data-testid="weekend-card-start"]').click());
      } else {
        via = "anchor";
        await spaNavigate(mp, WEEKEND_HREF);
      }
      await sleep(1500);
      const st = await mp.evaluate(() => {
        const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom > 0 && r.top < innerHeight; };
        const wrappers = Array.from(document.querySelectorAll(".app-transition-wrapper")).map((el) => ({
          anim: el.style.animation || "", op: getComputedStyle(el).opacity,
          running: el.getAnimations ? el.getAnimations().filter((a) => a.playState === "running").length : -1,
          txt: (el.innerText || "").replace(/\s+/g, " ").slice(0, 30),
        }));
        const w = document.getElementById("wrapper");
        const se = document.scrollingElement;
        const sel = document.querySelector('[data-testid="pack-size"]');
        const hd = document.getElementById("offline-space-heading");
        return {
          url: location.pathname + location.search, wrappers,
          scrollOwner: w ? "#wrapper" : "scrollingElement", scrollTop: w ? w.scrollTop : se ? se.scrollTop : 0,
          packSize: sel ? sel.value : null, packSizeVisible: vis(sel),
          heading: hd ? (hd.textContent || "").replace(/\s+/g, " ").trim() : null, headingVisible: vis(hd),
          textLen: (document.body && document.body.innerText || "").length,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      });
      const shotBuf = await mp.screenshot({ type: "png" }).catch(() => null);
      const px = pngCentreStats(shotBuf);
      const pxTxt = px ? `centre pixels mean ${px.mean.toFixed(1)} std ${px.std.toFixed(1)} bright ${(px.brightFrac * 100).toFixed(1)}%` : "centre pixels n/a (png not decoded)";
      const ctxTxt = `via ${via}, url ${st.url}, wrappers ${JSON.stringify(st.wrappers)}, ${st.scrollOwner}.scrollTop ${st.scrollTop}, ${pxTxt}, errors ${JSON.stringify(errs.slice(-3))}`;

      if (!/^\/library\/downloads-offline/.test(st.url)) throw new Error(`not on the Espace page 1.5 s after the click (${ctxTxt})`);
      if (st.wrappers.length !== 1) throw new Error(`${st.wrappers.length} .app-transition-wrapper elements 1.5 s after the navigation (expected 1: the outgoing home page never left, c56a black screen); ${ctxTxt}`);
      const animating = st.wrappers.filter((x) => x.anim);
      if (animating.length) throw new Error(`transition wrapper still carries style.animation "${animating[0].anim}" after 1.5 s; ${ctxTxt}`);
      if (!(st.scrollTop < 100)) throw new Error(`${st.scrollOwner} scrolled to ${st.scrollTop}px right after the navigation (expected < 100: scrollIntoView ran during the crossfade); ${ctxTxt}`);
      if (st.packSize !== "dur:7200") throw new Error(`[data-testid=pack-size] value ${JSON.stringify(st.packSize)} (expected dur:7200 from ?pack=); ${ctxTxt}`);
      if (!st.headingVisible) throw new Error(`Espace heading (#offline-space-heading) not visible: ${JSON.stringify(st.heading)}; ${ctxTxt}`);
      if (!(st.textLen > 200)) throw new Error(`body text ${st.textLen} chars (expected > 200: page not painted); ${ctxTxt}`);
      if (px && px.brightFrac < 0.01 && px.std < 6) throw new Error(`screen is black at the centre (${pxTxt}); ${ctxTxt}`);

      return `${notes.join(", ")}; ${via}: 1 wrapper (no style.animation, ${st.wrappers[0].running} running animations), ${st.scrollOwner}.scrollTop ${st.scrollTop}, pack-size ${st.packSize}${st.packSizeVisible ? " visible" : ""}, heading "${st.heading}" visible, text ${st.textLen} chars, ${pxTxt}, body bg ${st.bodyBg}${errs.length ? `, errors ${JSON.stringify(errs.slice(-2))}` : ""}`;
    } finally { await mctx.close().catch(() => {}); }
  }, { budgetMs: 150000 });

  await c56step("offline_local_never_youtube", async () => {
    const name = "c56b-offline-" + Date.now().toString(36);
    const s = await androidSession(name, { seedPlay: false });
    const { mctx, mp, errs, notes } = s;
    try {
      const playerReqs = [];
      let recording = false;
      mp.on("request", (r) => { const u = r.url(); if (recording && /\/api\/v1\/player\.json/.test(u)) playerReqs.push(u.replace(URL, "")); });
      await mp.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
      if (!(await swControlled(mp))) { await mp.reload({ waitUntil: "load", timeout: 45000 }); await sleep(1500); }
      if (!(await swControlled(mp))) throw new Error("Espace page not controlled by the service worker (\"Tout lire\" would answer Recharge l'application)");
      const playAll = mp.locator('[role="group"][aria-label="Lecture hors-ligne"] button:has-text("Tout lire")').first();
      await playAll.waitFor({ state: "visible", timeout: 20000 });
      // Enabled once a cached track is listed (readyCount > 0): the kept album's tracks.
      const ready = await pollUntil(async () => ((await playAll.getAttribute("aria-disabled").catch(() => null)) === "false" ? true : null), 20000, 500);
      if (!ready) throw new Error(`"Tout lire" stays disabled (title ${JSON.stringify(await playAll.getAttribute("title").catch(() => null))}): no cached track listed although ${notes.join(", ")}`);
      recording = true;
      await playAll.click({ timeout: 5000 });
      const m = await pollUntil(async () => { const x = await mediaOf(mp); return x && x.src ? x : null; }, 20000, 500);
      await sleep(1500); // late requests (next-track prefetch) land in the log too
      recording = false;
      const toasts = await mp.evaluate(() => Array.from(document.querySelectorAll('[data-testid="alert-container"] .alert')).map((e) => (e.textContent || "").trim()).filter(Boolean)).catch(() => []);
      const srcs = ((m && m.srcs) || []).map((u) => u.replace(URL, ""));
      const srcTxt = `srcs ${JSON.stringify(srcs)}`;
      if (!m) throw new Error(`no media src 20 s after "Tout lire" (toasts ${JSON.stringify(toasts.slice(-2))}, player.json requests ${JSON.stringify(playerReqs)}, errors ${JSON.stringify(errs.slice(-3))}); ${notes.join(", ")}`);
      const ytReqs = playerReqs.filter((u) => { const q = (u.split("?")[1] || "").split("&").find((kv) => kv.startsWith("videoId=")); const id = q ? decodeURIComponent(q.slice(8)) : ""; return LID_RE.test(id); });
      if (ytReqs.length) throw new Error(`a library id went through player.json (${ytReqs.join(", ")}) while playing offline: YouTube path for a local track (d8054d4); ${srcTxt}`);
      const cur = m.src.replace(URL, "");
      if (!/\/localf\b/.test(cur)) throw new Error(`media src ${cur.slice(0, 120)} is not a /localf library file; ${srcTxt}; player.json requests ${JSON.stringify(playerReqs)}`);
      const nonLocal = srcs.filter((u) => !/\/localf\b/.test(u));
      return `${notes.join(", ")}; "Tout lire": media src ${cur.slice(0, 90)} (t ${m.t.toFixed(1)} s, paused ${m.paused}), ${srcTxt}${nonLocal.length ? ` (non-localf: ${nonLocal.length})` : ""}, player.json requests ${playerReqs.length}${playerReqs.length ? " " + JSON.stringify(playerReqs) : ""} (none with a library id)${toasts.length ? `, toasts ${JSON.stringify(toasts.slice(-2))}` : ""}`;
    } finally { await mctx.close().catch(() => {}); }
  }, { budgetMs: 150000 });

  await c56step("player_local_lid_404", async () => {
    // From the main harness page (same origin): an unknown owned-library id is answered 404 at once, twice, with
    // the PlayerError JSON (error "unplayable", status "LOCAL_NOT_FOUND", reason, videoId). Before d8054d4 the lid
    // fell through to the YouTube companion ("Video unavailable" after a round trip).
    // Standalone runs (HARNESS_ONLY) reach this step with the main page still on about:blank: a relative fetch
    // cannot be parsed there, so make sure the page is on the app origin first.
    if (!String(page.url() || "").startsWith(URL)) await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    const res = await page.evaluate(async (lid) => {
      const out = [];
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        const r = await fetch("/api/v1/player.json?videoId=" + lid, { cache: "no-store" });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        out.push({ status: r.status, ms: Math.round(performance.now() - t0), ct: r.headers.get("content-type") || "", json, text: text.slice(0, 160) });
      }
      return out;
    }, UNKNOWN_LID);
    const [a, b] = res;
    const fmt = (x) => `${x.status} in ${x.ms} ms ${x.json ? JSON.stringify(x.json) : JSON.stringify(x.text)}`;
    if (a.status !== 404) throw new Error(`player.json?videoId=${UNKNOWN_LID} answered ${fmt(a)} (expected 404 LOCAL_NOT_FOUND)`);
    if (!a.json) throw new Error(`404 body is not JSON (${a.ct}): ${JSON.stringify(a.text)}`);
    if (a.json.status !== "LOCAL_NOT_FOUND") throw new Error(`404 JSON status ${JSON.stringify(a.json.status)}, error ${JSON.stringify(a.json.error)} (expected status LOCAL_NOT_FOUND): ${fmt(a)}`);
    if (a.json.error !== "unplayable") throw new Error(`404 JSON error ${JSON.stringify(a.json.error)} (expected "unplayable"): ${fmt(a)}`);
    if (b.status !== 404 || !b.json || b.json.status !== "LOCAL_NOT_FOUND") throw new Error(`second fetch answered ${fmt(b)} (expected 404 LOCAL_NOT_FOUND again: no companion acquisition triggered by the first)`);
    return `videoId=${UNKNOWN_LID}: ${fmt(a)}; again: ${b.status} in ${b.ms} ms, status ${b.json.status}`;
  }, { budgetMs: 20000 });
}

module.exports = { run, C56_SKIP, STEP_NAMES, pngCentreStats };
