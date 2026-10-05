// steps-c42-core.cjs: cycle 42 harness additions for harness-core.cjs (audit logic v12, L12-2 and "Angles
// morts du harness" 4, 5, 7). Spliced into harness-core.cjs after the c41 steps with:
//   await require("./steps-c42-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C42_SKIP (exported Set) lists step names to skip; env C42_SKIP="a,b" adds to it and
// C42_STEPS_ENABLED=0 skips them all. skips_exclusion_real is skipped off staging (harness skips and plays
// only count with YTM_STATS_INCLUDE_HARNESS=1, set on staging only). Steps:
//   mediasession_real_handlers  the REAL Media Session handlers (captured by wrapping setActionHandler):
//                               seekto {seekTime: 0} -> currentTime < 1; previoustrack after 5 s restarts the
//                               same title; previoustrack again within 3 s goes back to the previous title
//   skips_exclusion_real        staging: named profile harness-skip-<ms>, a ref from me/mix skipped twice
//                               (POST me/skips) leaves me/mix (and local/related?personal=1 when it was in the
//                               album radio); local/related?seed=album:<fixture>&personal=1 -> X-Ytm-Cache BYPASS
//   album_of_day_stable         same browseId twice, ?date=<today> = no date, ?date=<tomorrow> differs,
//                               malformed date -> 400, out-of-bounds date -> 400 (tolerant until c42a ships)
const fs = require("fs");
const path = require("path");
const https = require("https");

const C42_SKIP = new Set(); // chain 47: mediasession_real_handlers under diagnosis (c46b, fixed); re-enabled by c47a (B8-16) after a run alone 02/10 03:34 (PASS 21 s)
const STEP_NAMES = ["mediasession_real_handlers", "skips_exclusion_real", "album_of_day_stable"];

function loadFixtures() {
  for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

// Node-side request to Traefik on 127.0.0.1 (run.sh uses --network host) with SNI + Host (same trick as
// steps-c38-core.cjs: Playwright's request context ignores --host-resolver-rules, the box hairpin is broken).
function rawRequest(base, method, reqPath, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const host = String(base).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const t0 = Date.now();
    const req = https.request({ host: "127.0.0.1", port: 443, path: reqPath, method, servername: host, rejectUnauthorized: false, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - t0 }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs} ms ${method} ${reqPath}`)));
    req.end();
  });
}

const defaultLoginAs = async (p, name) => p.evaluate(async (n) => {
  const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  try { sessionStorage.removeItem("ytm-whoami"); } catch {}
  return x.status;
}, name);

// Init script for fresh contexts: captures every Media Session handler the app registers in window.__ms
// (the app re-registers them on each metadata update: the latest one wins) and the playing element in
// window.__ytmMedia.el (the main page's own hook stores the element itself in window.__ytmMedia).
function mediaSessionHook() {
  window.__ms = {};
  window.__msCalls = 0;
  try {
    const ms = navigator.mediaSession;
    if (ms && typeof ms.setActionHandler === "function") {
      const orig = ms.setActionHandler.bind(ms);
      ms.setActionHandler = function (action, handler) { window.__msCalls++; window.__ms[action] = handler; return orig(action, handler); };
    }
  } catch { /* no Media Session: the step reports it */ }
  window.__ytmMedia = { plays: 0 };
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia.plays++; window.__ytmMedia.el = this; window.__ytmMedia.src = this.currentSrc || this.src; return o.apply(this, arguments); };
}

// Page-side state: the media element (fresh-context hook .el, or the main-page hook = the element itself,
// or the first <audio>/<video>) and the Media Session title.
async function msState(p) {
  return p.evaluate(() => {
    const m = window.__ytmMedia;
    const el = (m && m.el) || (m && typeof m.currentTime === "number" ? m : null) || document.querySelector("audio,video");
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    // c46b: the mini-bar queue counter ("File · 2/50") tells the queue position apart from the title.
    const foot = document.querySelector("footer");
    const q = /(\d+)\s*\/\s*(\d+)/.exec(foot ? (foot.innerText || "").replace(/\s+/g, " ") : "");
    return { t: el ? el.currentTime : -1, src: el ? el.currentSrc || el.src || "" : "", paused: el ? el.paused : null, title: md ? String(md.title || "") : "", pos: q ? Number(q[1]) : null, len: q ? Number(q[2]) : null, handlers: Object.keys(window.__ms || {}).filter((k) => typeof window.__ms[k] === "function") };
  });
}

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const QUERY = deps.QUERY || "daft punk";
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const loginAs = deps.loginAs || defaultLoginAs;
  const FIX = deps.fixtures || loadFixtures();
  const ALBUM = FIX.localAlbumId || "lb-f9c16fd93917";
  const LID = FIX.localLid || "6300e80e2e2";
  const raw = (method, p, headers, t) => rawRequest(URL, method, p, headers, t);
  const staging = /staging/.test(URL);
  const enabled = process.env.C42_STEPS_ENABLED !== "0";
  const skip = new Set([...C42_SKIP, ...String(process.env.C42_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  if (!staging) skip.add("skips_exclusion_real");
  const c42step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());

  await c42step("mediasession_real_handlers", async () => {
    // L12-2 / blind spot 4: night_lockscreen wrote el.currentTime directly; here the app's own handlers run.
    const mctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const mp = await mctx.newPage();
      await mp.addInitScript(mediaSessionHook);
      // c46b: media / source errors of this context (a previous track whose source cannot play here, e.g. a
      // YouTube row with no Google egress from the box, auto-skips forward: the title then never changes).
      const errs = [];
      mp.on("console", (m) => { if (m.type() === "error") errs.push(m.text().replace(/\s+/g, " ").slice(0, 140)); });
      mp.on("pageerror", (e) => errs.push("pageerror " + String((e && e.message) || e).slice(0, 140)));
      // A library song first (no acquisition), the whole catalogue as a fallback.
      let from = "library";
      await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=library", { waitUntil: "load", timeout: 45000 });
      const lib = mp.getByText(/Song\s*•/).first();
      if (await lib.isVisible({ timeout: 8000 }).catch(() => false)) await lib.click({ position: { x: 8, y: 8 }, timeout: 8000 });
      else {
        from = "all";
        await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
        await mp.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
      }
      const s1 = await pollUntil(async () => { const s = await msState(mp); return s.src && s.t > 1 && s.title ? s : null; }, 40000, 500);
      if (!s1) throw new Error(`no track playing with a Media Session title (from ${from})`);
      const need = ["seekto", "previoustrack", "nexttrack"].filter((a) => !s1.handlers.includes(a));
      if (need.length) throw new Error("Media Session handlers not captured: " + need.join(",") + " (have " + s1.handlers.join(",") + ")");
      // Move to queue position 1 so that an early "previous" has a track to go back to (position 0 restarts).
      await mp.evaluate(() => window.__ms.nexttrack());
      const s2 = await pollUntil(async () => { const s = await msState(mp); return s.title && s.title !== s1.title && s.src && s.t > 0 ? s : null; }, 40000, 500);
      if (!s2) throw new Error(`nexttrack handler did not change the track (still ${JSON.stringify(s1.title)})`);
      const s2b = await pollUntil(async () => { const s = await msState(mp); return s.t >= 4 ? s : null; }, 20000, 300);
      if (!s2b) throw new Error("second track did not reach 4 s");
      // seekto 0 through the handler, with a bare { seekTime } (B6-8: the handler sets the action itself).
      await mp.evaluate(() => window.__ms.seekto({ seekTime: 0 }));
      const seek = await pollUntil(async () => { const s = await msState(mp); return s.t >= 0 && s.t < 1 ? s : null; }, 2000, 100);
      if (!seek) { const s = await msState(mp); throw new Error(`seekto {seekTime: 0} not honoured: ${s2b.t.toFixed(1)} -> ${s.t.toFixed(1)} s`); }
      // previoustrack after 5 s: restarts the SAME title.
      const at5 = await pollUntil(async () => { const s = await msState(mp); return s.t > 5 ? s : null; }, 15000, 300);
      if (!at5) throw new Error("track did not reach 5 s after the seek");
      if (at5.title !== s2.title) throw new Error(`title changed on its own before previoustrack: ${s2.title} -> ${at5.title}`);
      await mp.evaluate(() => window.__ms.previoustrack());
      const rs = await pollUntil(async () => { const s = await msState(mp); return s.t >= 0 && s.t < 2 ? s : null; }, 3000, 100);
      if (!rs) { const s = await msState(mp); throw new Error(`previoustrack at ${at5.t.toFixed(1)} s did not restart (now ${s.t.toFixed(1)} s)`); }
      if (rs.title !== s2.title) throw new Error(`previoustrack at ${at5.t.toFixed(1)} s changed the title (${s2.title} -> ${rs.title}) instead of restarting`);
      // previoustrack again within 3 s: the previous title.
      const early = await msState(mp);
      if (early.t > 2.5) throw new Error(`too late for the early previoustrack (${early.t.toFixed(1)} s)`);
      const errsBefore = errs.length;
      await mp.evaluate(() => window.__ms.previoustrack());
      // c46b: judged on the title OR the queue counter (chain 47 failed on the title alone with no way to tell
      // a stalled / unplayable previous source from a handler that did nothing). The probe of c46b saw the
      // handler move 3/50 -> 2/50 and the title follow within 0.5 s.
      const movedBack = (s) => s.pos !== null && early.pos !== null && s.pos < early.pos;
      const back = await pollUntil(async () => { const s = await msState(mp); return (s.title && s.title !== s2.title) || movedBack(s) ? s : null; }, 20000, 300);
      const queue = `queue ${early.pos}/${early.len} -> ${back ? back.pos : "?"}/${back ? back.len : "?"}`;
      const newErrs = errs.slice(errsBefore);
      if (!back) throw new Error(`previoustrack at ${early.t.toFixed(1)} s did not change the title (still ${JSON.stringify(s2.title)}) nor the ${queue}; media errors: ${newErrs.length ? newErrs.join(" | ") : "none"}`);
      let titled = back.title !== s2.title ? back : null;
      if (!titled) {
        // The queue stepped back: give the title (set on loadedmetadata of the new source) a moment more.
        titled = await pollUntil(async () => { const s = await msState(mp); return s.title && s.title !== s2.title ? s : null; }, 8000, 300);
      }
      const srcErr = errs.slice(errsBefore).find((e) => /media element error|source error|unplayable|MEDIA_ERR/i.test(e));
      if (!titled) {
        const now = await msState(mp);
        if (srcErr) return `from ${from}: handlers ${s1.handlers.join(",")}; next ${JSON.stringify(s1.title.slice(0, 24))} -> ${JSON.stringify(s2.title.slice(0, 24))}; seekto 0 ${s2b.t.toFixed(1)} -> ${seek.t.toFixed(2)} s; previous at ${at5.t.toFixed(1)} s restarted (${rs.t.toFixed(2)} s, same title); previous at ${early.t.toFixed(1)} s honoured (${queue}) but the previous track's source cannot play here, so the player skipped forward again (${srcErr.slice(0, 90)}); now ${now.pos}/${now.len} ${JSON.stringify(now.title.slice(0, 24))}`;
        throw new Error(`previoustrack at ${early.t.toFixed(1)} s moved the ${queue} but the title stayed ${JSON.stringify(s2.title)} (now t=${now.t.toFixed(1)} s, paused=${now.paused}, no media error logged)`);
      }
      const same1 = titled.title === s1.title;
      return `from ${from}: handlers ${s1.handlers.join(",")}; next ${JSON.stringify(s1.title.slice(0, 24))} -> ${JSON.stringify(s2.title.slice(0, 24))}; seekto 0 ${s2b.t.toFixed(1)} -> ${seek.t.toFixed(2)} s; previous at ${at5.t.toFixed(1)} s restarted (${rs.t.toFixed(2)} s, same title); previous at ${early.t.toFixed(1)} s -> ${JSON.stringify(titled.title.slice(0, 24))} (${queue})${same1 ? " (the first track)" : " (NOT the first track: queue rebuilt?)"}${newErrs.length ? "; media errors: " + newErrs.length : ""}`;
    } finally { await mctx.close(); }
  }, { budgetMs: 90000 });

  await c42step("skips_exclusion_real", async () => {
    // L12-2 / blind spot 5: smart_queue_skips posted one skip with source "harness" and checked the status only.
    const sctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const sp = await sctx.newPage();
      await sp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const name = "harness-skip-" + Date.now();
      const st = await loginAs(sp, name);
      if (!(st >= 200 && st < 300)) throw new Error(`login ${name}: ${st}`);
      const api = async (method, p, body) => sp.evaluate(async ({ method, p, body }) => {
        const r = await fetch(p, { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        let j = null; try { j = await r.json(); } catch {}
        return { status: r.status, json: j, mixCache: r.headers.get("x-ytm-mix-cache") || "", cache: r.headers.get("x-ytm-cache") || "" };
      }, { method, p, body });
      const refsOf = (j) => ((j && j.items) || []).map((it) => it.videoId || it.lid || "").filter(Boolean);
      // Seeds for me/mix: one local play and one song favorite of the fixture lid.
      const play = await api("POST", "/api/v1/me/history", { videoId: LID, title: FIX.localLidTitle || "Harness seed" });
      const fav = await api("POST", "/api/v1/me/favorites", { videoId: LID, title: FIX.localLidTitle || "Harness seed" });
      if (play.status >= 400 || fav.status >= 400) throw new Error(`seed play ${play.status} / favorite ${fav.status}`);
      const mix1 = await api("GET", "/api/v1/me/mix");
      const before = refsOf(mix1.json);
      if (mix1.status !== 200 || !before.length) throw new Error(`me/mix before: ${mix1.status}, ${before.length} items (seeds=${mix1.json && mix1.json.seeds})`);
      // Prefer a ref that the shared album radio also returns: the personal=1 answer can then be checked too.
      const relShared = await api("GET", "/api/v1/local/related?seed=album:" + encodeURIComponent(ALBUM));
      const shared = refsOf(relShared.json);
      const cands = before.filter((r) => r !== LID);
      const ref = cands.find((r) => shared.includes(r)) || cands[0];
      if (!ref) throw new Error("me/mix holds only the seed: no ref to skip");
      const now = Date.now();
      const skips = [];
      for (const at of [now - 60000, now]) skips.push(await api("POST", "/api/v1/me/skips", { videoId: ref, at, position: 5, duration: 200, source: "player" }));
      for (const s of skips) {
        if (s.status !== 200) throw new Error("POST me/skips " + s.status + " " + JSON.stringify(s.json));
        if (s.json && s.json.ignored) throw new Error("POST me/skips answered ignored:true: harness requests do not count here (YTM_STATS_INCLUDE_HARNESS=1 missing on this server)");
        if (s.json && s.json.duplicate) throw new Error("second skip taken as an outbox duplicate: " + JSON.stringify(s.json));
      }
      const sk = await api("GET", "/api/v1/me/skips?days=30");
      const row = ((sk.json && sk.json.rows) || []).find((r) => r.ref === ref);
      if (!row || row.count < 2) throw new Error(`me/skips does not show 2 skips for ${ref}: ${JSON.stringify(row || null)}`);
      const mix2 = await api("GET", "/api/v1/me/mix");
      const after = refsOf(mix2.json);
      if (mix2.status !== 200) throw new Error("me/mix after: " + mix2.status);
      if (after.includes(ref)) throw new Error(`twice-skipped ${ref} still in me/mix (X-Ytm-Mix-Cache ${mix2.mixCache})`);
      // Personal continuation: the profile exclusions apply, and the shared cache is bypassed.
      const relPersonal = await api("GET", "/api/v1/local/related?seed=album:" + encodeURIComponent(ALBUM) + "&personal=1");
      const inShared = shared.includes(ref);
      if (inShared && refsOf(relPersonal.json).includes(ref)) throw new Error(`twice-skipped ${ref} still in local/related?personal=1 (it is in the shared album radio)`);
      const byp = await raw("GET", "/api/v1/local/related?seed=album:" + encodeURIComponent(ALBUM) + "&personal=1", { "User-Agent": "ytm-harness-c42" }, 15000);
      const bc = String(byp.headers["x-ytm-cache"] || "");
      // L14-3 (cycle 49): personal=1 shares the base cache (HIT/MISS) and applies the profile exclusions after the
      // hit; before cycle 49 it had to BYPASS. Any status is fine: the exclusion is what the step asserts below.
      if (byp.status !== 200 || !/^(BYPASS|HIT|MISS|STALE)$/.test(bc || "")) throw new Error(`local/related personal=1 via 127.0.0.1: ${byp.status} X-Ytm-Cache=${bc || "(none)"} (expected a cache status)`);
      // Note: a ref skipped (or played) in the last 3 h is also excluded by recentRefs, so this proves "skipped
      // => excluded", not the 2-skip threshold alone (that one is covered by me_exclusions_test.go).
      return `${name}: me/mix ${before.length} -> ${after.length} items (cache ${mix1.mixCache || "?"} -> ${mix2.mixCache || "?"}), ${ref} skipped x${row.count} and gone; personal related ${inShared ? "checked (ref was in the shared album radio)" : "not checkable (ref not in the album radio)"}; related personal=1 X-Ytm-Cache ${bc} (${byp.ms} ms)`;
    } finally { await sctx.close(); }
  }, { budgetMs: 45000 });

  await c42step("album_of_day_stable", async () => {
    // L12-2 / blind spot 7: discovery_v6 compared two calls with the same memo only.
    const UA = { "User-Agent": "ytm-harness-c42" };
    const get = async (qs) => { const r = await raw("GET", "/api/v1/local/album-of-day" + qs, UA, 15000); let j = null; try { j = JSON.parse(r.body); } catch {} return { status: r.status, j, id: j && j.album && j.album.endpoint ? j.album.endpoint.browseId || "" : "", title: j && j.album ? String(j.album.title || "").trim() : "", date: (j && j.date) || "" }; };
    const a = await get(""), b = await get("");
    if (a.status !== 200 || !a.id) throw new Error("album-of-day: " + a.status + " " + JSON.stringify(a.j).slice(0, 120));
    if (b.id !== a.id) throw new Error(`album of the day unstable: ${a.id} then ${b.id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new Error("album-of-day without a YYYY-MM-DD date: " + a.date);
    const d0 = new Date(a.date + "T00:00:00Z");
    const iso = (d) => d.toISOString().slice(0, 10);
    const today = await get("?date=" + a.date);
    if (today.status !== 200 || today.id !== a.id) throw new Error(`?date=${a.date} (today) gives ${today.id || today.status}, no date gives ${a.id}`);
    const tom = iso(new Date(d0.getTime() + 86400000));
    const t = await get("?date=" + tom);
    if (t.status !== 200 || !t.id) throw new Error(`?date=${tom}: ${t.status} ${JSON.stringify(t.j).slice(0, 100)}`);
    if (t.id === a.id) throw new Error(`?date=${tom} gives the same album as ${a.date}: ${a.id}`);
    const bad = await get("?date=not-a-date");
    if (bad.status !== 400) throw new Error("malformed ?date= status " + bad.status + " (expected 400)");
    // Bounds (c42a): far past / far future must be refused. Tolerated while the build accepts any date.
    const oob = [];
    for (const d of ["1970-01-01", iso(new Date(d0.getTime() + 400 * 86400000))]) oob.push({ d, s: (await get("?date=" + d)).status });
    const unbounded = oob.filter((x) => x.s === 200);
    const wrong = oob.filter((x) => x.s !== 200 && x.s !== 400);
    if (wrong.length) throw new Error("out-of-bounds ?date= answered " + JSON.stringify(wrong));
    const bounds = unbounded.length ? `bounds NOT enforced yet (${unbounded.map((x) => x.d).join(", ")} -> 200; assertion skipped until c42a)` : `out-of-bounds ${oob.map((x) => x.d).join(", ")} -> 400`;
    return `${a.date} ${a.id} (${a.title.slice(0, 24)}) twice + ?date=today; ${tom} ${t.id} (${t.title.slice(0, 24)}) differs; malformed 400; ${bounds}`;
  }, { budgetMs: 15000 });
}

module.exports = { run, C42_SKIP, STEP_NAMES, rawRequest, mediaSessionHook };
