// steps-c47-core.cjs: cycle 47 harness addition for harness-core.cjs (lane c47c: B8-11 preview before
// "Rafraichir mon pack", B8-1 data saver). Spliced into harness-core.cjs after the c45 steps with:
//   await require("./steps-c47-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
// Note: `URL` handed over is harness-core's string constant; the constructor is globalThis.URL (unused here).
//
// Gating: C47_SKIP (exported Set) lists step names to skip; env C47_SKIP="a,b" adds to it and
// C47_STEPS_ENABLED=0 skips them all. Each step runs in its OWN fresh context (own origin storage, SW,
// anonymous profile), closed at the end: nothing is pinned, uncached or toggled in the main context.
// Steps:
//   pack_refresh_preview   a 100 Mo pack completes; 2 of its pinned tracks are marked listened (listen log
//                          "ytm-listen-log" seeded the way Player.svelte writes it + POST me/history);
//                          "Rafraichir mon pack" -> [data-testid=pack-refresh-preview] lists the tracks that
//                          WOULD go ([pack-refresh-row] x N, title non-empty), N = data-count =
//                          window.__ytmPackRefresh.dropped.length = the 2 listened ids; nothing is uncached
//                          yet (SW list-audio unchanged); "Annuler" closes it (still nothing uncached);
//                          then preview again + "Rafraichir" (pack-refresh-confirm) -> applied, the 2 are
//                          uncached, new ids downloaded + pinned, every other pin intact.
//   data_saver_no_prefetch Reglages > Lecture "Economie de donnees" ON ([data-testid=setting-data-saver],
//                          persisted in localStorage settings.playback["Data Saver"]); the fixture local
//                          album (>= 2 tracks) played from /release ("Tout lire"); within 20 s of the first
//                          sound: no player.json prefetch request (X-Ytm-Prefetch), the SW audio list gained
//                          no entry (neither the played track nor the next one is auto-cached), playback
//                          itself advances; /library/downloads-offline shows [data-testid=data-saver-notice].
const fs = require("fs");
const path = require("path");

// c47a: enable with chain 55. Staging serves fdcd7a4 while the c47c UI (pack-refresh-preview / -row / -confirm /
// -cancel, setting-data-saver, data-saver-notice) is at f257daa: neither step can pass before the chain builds it.
const C47_SKIP = new Set(); // chain 55: pack_refresh_preview, data_saver_no_prefetch enabled (cycle 47 build)
// c52c (B9-21): pack_refresh_preview declares tier "full" (played on prod after a promotion only, SKIP in chains).
const STEP_NAMES = ["pack_refresh_preview", "data_saver_no_prefetch"];
const NO_PREFETCH_WINDOW_MS = 20000;

function loadFixtures() {
  for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

// Same play() hook as harness-core.cjs: window.__ytmMedia IS the media element (deps.media reads it).
function mediaHook() {
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); };
}
const mediaOf = (p) => p.evaluate(() => {
  const el = window.__ytmMedia || document.querySelector("audio,video");
  return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
});

// SW audio list (raw entries + quota); the SW replies on the MessageChannel port or on event.source.
const swListRaw = (p) => p.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  const ctl = navigator.serviceWorker.controller || reg.active;
  if (!ctl) return null;
  return await new Promise((resolve) => {
    const done = (d) => { navigator.serviceWorker.removeEventListener("message", on); resolve(d); };
    const on = (ev) => { if (ev.data && ev.data.type === "audio-list") done(ev.data); };
    navigator.serviceWorker.addEventListener("message", on);
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => done(e.data);
    ctl.postMessage({ type: "list-audio" }, [ch.port2]);
    setTimeout(() => done(null), 5000);
  });
}).catch(() => null);
/** { total, pinned, pinnedIds, ids, entries } or null. */
async function swList(p) {
  const d = await swListRaw(p);
  if (!d) return null;
  const entries = (d.entries || []).filter((e) => e && e.videoId);
  const pinnedE = entries.filter((e) => e.pinned);
  return { total: entries.length, pinned: pinnedE.length, pinnedIds: pinnedE.map((e) => e.videoId), ids: entries.map((e) => e.videoId), entries };
}
async function ensureControlled(p, sleep, pollUntil) {
  const ctl = await pollUntil(() => p.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false), 15000, 500);
  if (!ctl) { await p.reload({ waitUntil: "load" }); await sleep(1500); }
  if (!(await p.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false))) throw new Error("page not controlled by the SW");
}
async function expandSpace(p, sleep) {
  const tg = p.locator('[data-testid="space-toggle"]').first();
  await tg.waitFor({ state: "visible", timeout: 15000 });
  if ((await tg.getAttribute("aria-expanded")) !== "true") { await tg.click({ timeout: 5000 }); await sleep(500); }
}
const packText = (p) => p.locator("#offline-pack-text").first().innerText().catch(() => "");
const sortedJson = (a) => JSON.stringify((a || []).slice().sort());

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const media = deps.media || mediaOf;
  const enabled = process.env.C47_STEPS_ENABLED !== "0";
  const skip = new Set([...C47_SKIP, ...String(process.env.C47_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c47step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());

  await c47step("pack_refresh_preview", async () => {
    const tctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const errors = [];
    try {
      const a = await tctx.newPage();
      a.on("pageerror", (e) => errors.push("pageerror " + String((e && e.message) || e).slice(0, 120)));
      await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
      await ensureControlled(a, sleep, pollUntil);

      // 1. A 100 Mo pack, run to the end (the Espace card is folded by default, U12-9).
      await expandSpace(a, sleep);
      if (await a.locator('[data-testid="pack-refresh"]').count()) throw new Error("pack-refresh visible before any pack in a fresh context");
      const size = a.locator('[data-testid="pack-size"]').first();
      await size.waitFor({ state: "visible", timeout: 10000 });
      await size.selectOption("100");
      await a.locator('[data-testid="pack-start"]').first().click({ timeout: 5000 });
      const prog = a.locator('[data-testid="pack-progress"]').first();
      await prog.waitFor({ state: "visible", timeout: 15000 });
      const st = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s && s !== "planning" ? s : null; }, 30000, 300);
      if (st !== "running") throw new Error(`pack did not run (state=${st}, text=${await packText(a)})`);
      const fin = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s === "done" || s === "cancelled" ? s : null; }, 300000, 2000);
      if (fin !== "done") throw new Error(`pack not done after 300 s (state=${fin}, ${await prog.getAttribute("data-ready").catch(() => "?")}/${await prog.getAttribute("data-total").catch(() => "?")})`);
      const plan = await a.evaluate(() => window.__ytmPackPlan || null);
      const before = await swList(a);
      if (!before) throw new Error("SW list-audio unanswered after the pack");
      const packIds = ((plan && plan.videoIds) || []).filter((id) => before.pinnedIds.includes(id));
      if (packIds.length < 3) throw new Error(`pack too small to preview a refresh: pinned pack ids=${packIds.length} (need 3: 2 listened + 1 intact); SW pinned=${before.pinned}/${before.total}`);
      const refreshBtn = a.locator('[data-testid="pack-refresh"]').first();
      await refreshBtn.waitFor({ state: "visible", timeout: 10000 });

      // 2. Two pack tracks "listened" (listen log, the only source the refresh trusts since L13-1).
      const listened = packIds.slice(0, 2);
      await a.evaluate(async (ids) => {
        for (const videoId of ids) {
          try { await fetch("/api/v1/me/history", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId, title: "c47 listened " + videoId }) }); } catch { /* the log below is what counts */ }
        }
      }, listened);
      const seeded = await a.evaluate((ids) => {
        const KEY = "ytm-listen-log";
        let log = [];
        try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); if (Array.isArray(v)) log = v; } catch { log = []; }
        const at = Date.now();
        for (const videoId of ids) log.push({ videoId, at, seconds: 120, duration: 0 });
        localStorage.setItem(KEY, JSON.stringify(log));
        return { at, size: log.length };
      }, listened);
      const packAt = Number(await a.evaluate(() => { try { return JSON.parse(localStorage.getItem("ytm-offline-pack-last") || "{}").at; } catch { return 0; } })) || 0;
      if (!(seeded.at > packAt)) throw new Error(`listen log seeded at ${seeded.at}, not after the pack began (${packAt})`);
      await sleep(6000); // getRecent memoises 5 s per tab

      // 3. "Rafraichir mon pack" -> the preview, nothing uncached.
      const openPreview = async () => {
        await refreshBtn.click({ timeout: 5000 });
        const pv = a.locator('[data-testid="pack-refresh-preview"]').first();
        await pv.waitFor({ state: "visible", timeout: 30000 });
        const rf = await a.evaluate(() => window.__ytmPackRefresh || null);
        if (!rf || rf.preview !== true || typeof rf.applied === "boolean") throw new Error(`preview shown but window.__ytmPackRefresh says ${JSON.stringify(rf)}`);
        const rows = await a.locator('[data-testid="pack-refresh-row"]').evaluateAll((els) => els.map((el) => ({ id: el.getAttribute("data-video-id") || "", text: (el.textContent || "").replace(/\s+/g, " ").trim() })));
        const count = Number(await pv.getAttribute("data-count").catch(() => -1));
        const heading = (await a.locator("#offline-pack-refresh-preview").first().innerText().catch(() => "")).trim();
        return { pv, rf, rows, count, heading };
      };
      const p1 = await openPreview();
      const diag = `listened=${JSON.stringify(p1.rf.listened)}, dropped=${JSON.stringify(p1.rf.dropped)}, added=${(p1.rf.added || []).length}, rows=${JSON.stringify(p1.rows)}`;
      if (p1.rows.length !== p1.count || p1.rows.length !== (p1.rf.dropped || []).length) throw new Error(`preview rows ${p1.rows.length} != data-count ${p1.count} / dropped ${(p1.rf.dropped || []).length}; ${diag}`);
      if (sortedJson(p1.rows.map((r) => r.id)) !== sortedJson(listened)) throw new Error(`preview lists ${JSON.stringify(p1.rows.map((r) => r.id))}, expected the 2 listened ${JSON.stringify(listened)}; ${diag}`);
      const blank = p1.rows.filter((r) => !r.text || r.text === r.id);
      if (blank.length) throw new Error(`preview rows without a title: ${JSON.stringify(blank)}; ${diag}`);
      if (!/retiré/.test(p1.heading)) throw new Error(`preview heading "${p1.heading}" does not say what is removed; ${diag}`);
      const during = await swList(a);
      if (!during || listened.some((id) => !during.ids.includes(id))) throw new Error(`preview already uncached something: ${JSON.stringify(listened.filter((id) => !(during ? during.ids : []).includes(id)))}; ${diag}`);
      // 4. "Annuler": the preview closes, still nothing uncached, the button is back.
      await a.locator('[data-testid="pack-refresh-cancel"]').first().click({ timeout: 5000 });
      const gone = await pollUntil(async () => ((await a.locator('[data-testid="pack-refresh-preview"]').count()) === 0 ? "gone" : null), 5000, 200);
      if (!gone) throw new Error("preview still shown after Annuler");
      const afterCancel = await swList(a);
      if (!afterCancel || afterCancel.pinned !== before.pinned || listened.some((id) => !afterCancel.ids.includes(id))) throw new Error(`Annuler changed the cache: pinned ${before.pinned} -> ${afterCancel ? afterCancel.pinned : "?"}; ${diag}`);
      // 5. Preview again, confirm: the 2 go, new ones come, every other pin intact.
      const p2 = await openPreview();
      if (p2.rows.length !== p1.rows.length) throw new Error(`second preview lists ${p2.rows.length} rows, first ${p1.rows.length}`);
      await a.locator('[data-testid="pack-refresh-confirm"]').first().click({ timeout: 5000 });
      const rf = await pollUntil(() => a.evaluate(() => (window.__ytmPackRefresh && typeof window.__ytmPackRefresh.applied === "boolean") ? window.__ytmPackRefresh : null).catch(() => null), 30000, 300);
      if (!rf || rf.applied !== true) throw new Error(`refresh not applied after confirm: ${JSON.stringify(rf)}; text=${await packText(a)}; ${diag}`);
      if (sortedJson(rf.dropped) !== sortedJson(listened)) throw new Error(`dropped ${JSON.stringify(rf.dropped)} != listened ${JSON.stringify(listened)}`);
      const fin2 = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s === "done" || s === "cancelled" ? s : null; }, 180000, 2000);
      if (fin2 !== "done") throw new Error(`refresh pack not done (state=${fin2}); ${diag}`);
      const after = await pollUntil(async () => { const l = await swList(a); return l && !l.ids.some((id) => listened.includes(id)) ? l : null; }, 15000, 1000) || await swList(a);
      if (!after) throw new Error("SW list-audio unanswered after the refresh");
      const still = listened.filter((id) => after.ids.includes(id));
      if (still.length) throw new Error(`listened tracks still cached after the confirmed refresh: ${still.join(",")}; ${diag}`);
      const pinsLost = before.pinnedIds.filter((id) => !listened.includes(id) && !after.pinnedIds.includes(id));
      if (pinsLost.length) throw new Error(`pins outside the two dropped tracks lost: ${pinsLost.join(",")}; ${diag}`);
      const addedPinned = (rf.added || []).filter((id) => after.pinnedIds.includes(id));
      if (!addedPinned.length) throw new Error(`no new track pinned after the refresh (${(rf.added || []).length} planned); ${diag}`);
      if (errors.length) throw new Error(`page errors during the step: ${errors.slice(0, 3).join(" | ")}`);
      return `pack ${packIds.length} pinned; preview "${p1.heading.slice(0, 80)}" ${p1.rows.length} rows (${p1.rows.map((r) => r.text.slice(0, 40)).join(" / ")}); Annuler kept ${afterCancel.pinned} pins; confirm -> dropped ${listened.join(",")}, ${addedPinned.length} new pinned, pins ${before.pinned}-2+${addedPinned.length}=${after.pinned}`;
    } finally { await tctx.close().catch(() => {}); }
  }, { budgetMs: 600000, tier: "full" }); // c52c (B9-21): 64 to 111 s, never regressed, pack_refresh (offline) covers the refresh: full tier only (prod after a promotion)

  await c47step("data_saver_no_prefetch", async () => {
    const tctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const a = await tctx.newPage();
      await a.addInitScript(mediaHook);
      const prefetches = [];
      a.on("request", (r) => { try { const h = r.headers(); if (/player\.json/.test(r.url()) && (h["x-ytm-prefetch"] === "1")) prefetches.push(r.url().slice(0, 120)); } catch { /* ignore */ } });

      // 1. Reglages > Lecture: "Economie de donnees" ON, persisted.
      await a.goto(URL + "/settings", { waitUntil: "load", timeout: 45000 });
      const sw = a.locator('label.switch[for="data-saver"]').first();
      await sw.waitFor({ state: "visible", timeout: 20000 });
      const was = await a.locator('[data-testid="setting-data-saver"]').isChecked().catch(() => null);
      if (was !== false) throw new Error(`data saver already ${was} in a fresh context (expected off by default)`);
      await sw.click({ timeout: 5000 });
      const persisted = await pollUntil(() => a.evaluate(() => { try { return JSON.parse(localStorage.getItem("settings") || "{}").playback["Data Saver"] === true; } catch { return false; } }).catch(() => false), 5000, 200);
      if (!persisted) throw new Error("settings.playback['Data Saver'] not persisted in localStorage after the switch");

      // 2. The fixture local album from /release, "Tout lire".
      const albumId = FIX.localAlbumId || await a.evaluate(async () => { const r = await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc"); const d = await r.json(); return d && d.items && d.items[0] && d.items[0].browseId; });
      if (!albumId) throw new Error("no local album to play (fixtures.localAlbumId / local/albums)");
      await a.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
      await ensureControlled(a, sleep, pollUntil);
      const before = await swList(a);
      if (!before) throw new Error("SW list-audio unanswered before the play");
      const play = a.locator('[data-testid="release-play"]').first();
      await play.waitFor({ state: "visible", timeout: 20000 });
      await play.click({ timeout: 5000 });
      const m0 = await pollUntil(async () => { const m = await media(a); return m && m.src ? m : null; }, 30000, 500);
      if (!m0) throw new Error("no media src after Tout lire");
      const t0 = Date.now();

      // 3. 20 s of playback: no prefetch request, no new SW audio entry, the sound advances.
      await sleep(NO_PREFETCH_WINDOW_MS);
      const m1 = await media(a);
      const after = await swList(a);
      if (!after) throw new Error("SW list-audio unanswered after the play");
      const gained = after.ids.filter((id) => !before.ids.includes(id));
      const queue = await a.evaluate(() => { try { const s = JSON.parse(localStorage.getItem("lastTrack") || "null"); return s && s.videoId ? s.videoId : null; } catch { return null; } });
      const detail = `prefetch requests=${prefetches.length}, SW entries ${before.total} -> ${after.total} (gained ${JSON.stringify(gained)}), media t=${m0.t.toFixed(1)} -> ${m1 ? m1.t.toFixed(1) : "?"} over ${((Date.now() - t0) / 1000).toFixed(0)} s, playing=${queue || "?"}`;
      if (prefetches.length) throw new Error(`next-track prefetch under data saver: ${prefetches.join(", ")}; ${detail}`);
      if (gained.length) throw new Error(`SW cached ${gained.length} track(s) under data saver (no auto-cache expected); ${detail}`);
      if (!m1 || !(m1.t > m0.t) || m1.paused) throw new Error(`playback did not advance under data saver; ${detail}`);

      // 4. The offline page says so.
      await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
      const notice = a.locator('[data-testid="data-saver-notice"]').first();
      await notice.waitFor({ state: "visible", timeout: 15000 });
      const noticeTxt = ((await notice.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!/Économie de données/.test(noticeTxt)) throw new Error(`notice text "${noticeTxt}"`);
      return `${detail}; notice "${noticeTxt.slice(0, 90)}"`;
    } finally { await tctx.close().catch(() => {}); }
  }, { budgetMs: 120000 });
}

module.exports = { run, C47_SKIP, STEP_NAMES, swList };
