// ytm-e2e-offline — harness navigateur reel des fonctionnalites offline de music.ekaii.fr
// (auto-cache de tout morceau joue, prefetch du suivant, lecture hors-ligne depuis la page
// Offline, download sur appareil sans blocage). Conventions de harness.cjs.
// UI patchee (p17/p20) : pas de bouton Play dans les resultats, on tape la rangee ("Song • Artiste");
// le "⋮" n'a pas d'aria-label ; le bouton "Download to device" est dans la barre du player.
// La lecture est detectee via l'element <audio> (currentSrc / currentTime), PAS via les evenements
// reseau : le service worker intercepte l'audio et Playwright ne voit pas toujours ces requetes.
// run (depuis la box, via e2e/run.sh <url> <query> harness-offline.cjs)
//
// Fixtures (cycle 34 HD1): e2e/fixtures.json, keys documented in the header of harness-core.cjs.
// Used here: query (default when --query= is absent) and localAlbumId (keep_album_offline, instead
// of "the newest local album", which changed with every acquisition). Missing file / key = old lookup.
// Report (cycle 34 HD2/HD3): same fields as harness-core.cjs (version, startedAt, finishedAt,
// durationMs, budgetMs, overBudget, upstream; per step durationMs, slow, upstream, rerun, firstDetail).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));

const FIX = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8")) || {}; } catch (e) { console.log("fixtures.json not loaded (" + String(e.message || e).slice(0, 60) + "): old lookups"); return {}; } })();
const arg = (k, d = "") =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const OUT = arg("out", "/out");
// c52c (B9-13): every browser context of the harness sends X-Ytm-Harness: 1 so prod stats never record a
// harness play (api/me_stats.go harnessRequest; staging keeps YTM_STATS_INCLUDE_HARNESS=1). The wrapper on
// browser.newContext below merges it too, so a module calling browser.newContext directly is still covered;
// the helper is what the step modules receive through deps.newHarnessContext (check-harness-headers.cjs).
const HARNESS_HEADERS = { "X-Ytm-Harness": "1" };
function newHarnessContext(browser, opts) {
  const o = opts || {};
  return browser.newContext({ ...o, extraHTTPHeaders: { ...(o.extraHTTPHeaders || {}), ...HARNESS_HEADERS } });
}
const QUERY = arg("query", FIX.query || "daft punk");
const RESOLVER = arg("resolver", "");
const STREAM_RE = /(videoplayback|googlevideo|\/localf|\/vp\?|\/aud\/|\.m4a|\.opus|\.webm)/i;
const AUDIO_CACHE = "ytm-offline-audio";
const LS_KEY = "ytm-offline-tracks";
const BANNER_RE = /acquisition en cours/i;

fs.mkdirSync(OUT, { recursive: true });
let shotN = 0;
const steps = [];
const STARTED = Date.now();
// HD2: per-step budget (slow: true beyond it, never a failure) and total budget for the run.
const STEP_BUDGET_DEFAULT_MS = 60000;
const STEP_BUDGET_MS = { keep_album_offline: 240000, free_up_and_pack: 90000, auto_cache_played_track: 90000, prefetch_next_cached: 90000 };
// c47a (B8-14): same tiers as harness-core.cjs (HARNESS_TIER=chain|full, HARNESS_ONLY=a,b). No offline step is
// full-only today (18 steps in 115 to 140 s for a 300 s budget); the tier is written in the report.
const TIER = String(process.env.HARNESS_TIER || "chain").toLowerCase() === "full" ? "full" : "chain";
const FULL_ONLY = new Set();
const ONLY = new Set(String(process.env.HARNESS_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
const skippedTier = [];
const TOTAL_BUDGET_MS = 5 * 60000;
// HD3: failures caused upstream (YouTube `next`, the box network under load) are reported apart.
const UPSTREAM_RE = /Invalid response was returned from `next`|ERR_INTERNET_DISCONNECTED|ERR_CERT_VERIFIER_CHANGED|net::ERR_/;
// HD3: known-flaky steps get ONE automatic rerun before counting as failed (same list as the core).
const FLAKY_KNOWN = new Set(["offline_badges", "resume_remote", "queue_reorder_next", "lyrics_from_player_mobile", "lyrics_fast_after_open"]);
async function shot(page, label) {
  const f = `${String(++shotN).padStart(2, "0")}-${label.replace(/\W+/g, "_")}.png`;
  await page.screenshot({ path: path.join(OUT, f) }).catch(() => {});
  return f;
}
async function step(page, name, fn, opts = {}) {
  if (ONLY.size && !ONLY.has(name)) return true;
  if (TIER !== "full" && (opts.tier === "full" || FULL_ONLY.has(name))) { skippedTier.push(name); console.log("SKIP", name, "- tier full only (HARNESS_TIER=" + TIER + ")"); return true; }
  const budget = opts.budgetMs || STEP_BUDGET_MS[name] || STEP_BUDGET_DEFAULT_MS;
  const t0 = Date.now();
  let firstDetail = null;
  for (let attempt = 0; ; attempt++) {
    try {
      // Hard per-step timeout (chains 48/49: a hanging step killed the whole run at the chain timeout,
      // no report): 3 x budget, 180 s minimum, then the step FAILS and the run goes on.
      const hardMs = Math.max(budget * 3, 180000);
      let hardTimer = null;
      const detail = (await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { hardTimer = setTimeout(() => reject(new Error(`step hard timeout ${hardMs / 1000}s (budget ${budget / 1000}s)`)), hardMs); }),
      ]).finally(() => clearTimeout(hardTimer))) || "";
      const durationMs = Date.now() - t0;
      const rec = { name, ok: true, detail: String(detail), shot: await shot(page, name), durationMs };
      if (durationMs > budget) rec.slow = true;
      if (attempt) { rec.rerun = true; rec.firstDetail = firstDetail; }
      steps.push(rec);
      console.log("PASS", name, detail, `[${(durationMs / 1000).toFixed(1)}s${rec.slow ? " SLOW" : ""}${attempt ? " after RETRY" : ""}]`);
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e).split("\n")[0];
      if (attempt === 0 && FLAKY_KNOWN.has(name)) {
        firstDetail = msg;
        console.log("RETRY", name, "-", msg);
        await shot(page, "RETRY_" + name);
        continue;
      }
      const durationMs = Date.now() - t0;
      const upstream = UPSTREAM_RE.test(msg);
      const rec = { name, ok: false, detail: msg, shot: await shot(page, "FAIL_" + name), durationMs };
      if (durationMs > budget) rec.slow = true;
      if (upstream) rec.upstream = true;
      if (attempt) { rec.rerun = true; rec.firstDetail = firstDetail; }
      steps.push(rec);
      console.log(upstream ? "UPSTREAM" : "FAIL", name, "-", msg, `[${(durationMs / 1000).toFixed(1)}s]`);
      return false;
    }
  }
}
// Served version without the browser: Traefik on 127.0.0.1 (run.sh uses --network host), SNI + Host.
function servedVersion() {
  return new Promise((resolve) => {
    const host = URL.replace(/^https?:\/\//, "");
    const req = require("https").request({ host: "127.0.0.1", port: 443, path: "/api/v1/stats/library", method: "GET", servername: host, rejectUnauthorized: false, headers: { Host: host } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { try { resolve(JSON.parse(b).version || null); } catch { resolve(null); } }); });
    req.on("error", () => resolve(null)); req.setTimeout(10000, () => { req.destroy(); resolve(null); }); req.end();
  });
}
// c51b: the steps the offline step modules gate at run time (exported C<N>_SKIP Set + env C<N>_SKIP,
// C<N>_STEPS_ENABLED=0 gates the whole module), written as `gated` in report.json. Same shape as in
// harness-core.cjs. Read-only, never throws.
const GATED_MODULES = [["steps-c38-offline.cjs", "C38_SKIP", "C38_STEPS_ENABLED"], ["steps-c44-offline.cjs", "C44_SKIP", "C44_STEPS_ENABLED"]];
function gatedSteps(modules) {
  const out = [];
  for (const [mod, skipKey, enabledKey] of modules) {
    try {
      const m = require("./" + mod);
      const modName = mod.replace(/\.cjs$/, "");
      const names = new Set([...(m[skipKey] || []), ...String(process.env[skipKey] || "").split(",").map((s) => s.trim()).filter(Boolean)]);
      if (process.env[enabledKey] === "0") for (const n of m.STEP_NAMES || ["*"]) names.add(n);
      for (const step of names) out.push({ module: modName, step, source: m[skipKey] && m[skipKey].has(step) ? "set" : "env" });
    } catch (e) { out.push({ module: mod.replace(/\.cjs$/, ""), step: "*", source: "require failed: " + String((e && e.message) || e).split("\n")[0].slice(0, 80) }); }
  }
  return out;
}
function writeReport(version) {
  const finished = Date.now();
  const failed = steps.filter((s) => !s.ok && !s.upstream).length;
  const upstream = steps.filter((s) => !s.ok && s.upstream).length;
  const gated = gatedSteps(GATED_MODULES);
  const report = { url: URL, query: QUERY, version, tier: TIER, startedAt: new Date(STARTED).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - STARTED, budgetMs: TOTAL_BUDGET_MS, overBudget: finished - STARTED > TOTAL_BUDGET_MS, passed: steps.filter((s) => s.ok).length, failed, upstream, skippedTier, gated, steps };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${report.passed} passed / ${report.failed} failed / ${report.upstream} upstream -> ${OUT}/report.json`);
  console.log("Report gated: " + (gated.length ? gated.map((g) => `${g.step} (${g.module}, ${g.source})`).join(", ") : "none"));
  console.log(`Report budget: ${(report.durationMs / 1000).toFixed(0)} s / ${TOTAL_BUDGET_MS / 1000} s${report.overBudget ? " OVER BUDGET" : ""}, tier=${TIER}, version=${version}, slow steps=${steps.filter((s) => s.slow).length}`);
  console.log("Report slowest: " + steps.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 5).map((s) => `${s.name} ${(s.durationMs / 1000).toFixed(1)}s`).join(", "));
  const extra = steps.filter((s) => s.upstream || s.rerun).map((s) => `${s.name}${s.upstream ? " UPSTREAM" : ""}${s.rerun ? (s.ok ? " RETRY-PASS" : " RETRY-FAIL") : ""}`);
  if (extra.length) console.log("Report upstream/retry: " + extra.join(", "));
  return report;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cachedUrls(page) {
  return page.evaluate(async (name) => {
    try { const c = await caches.open(name); return (await c.keys()).map((k) => k.url); } catch { return []; }
  }, AUDIO_CACHE);
}
async function offlineList(page) {
  return page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } }, LS_KEY);
}
async function audioState(page) {
  return page.evaluate(() => {
    const el = window.__ytmMedia || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused, rs: el.readyState, err: el.error ? el.error.code : 0 } : null;
  });
}
async function pollUntil(fn, timeoutMs, everyMs = 1500) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  return last;
}
async function bannerVisible(page) {
  return page.evaluate((re) => new RegExp(re, "i").test(document.body.innerText || ""), BANNER_RE.source);
}
// Recherche puis lecture du premier resultat de type "Song" en tapant la rangee ; attend que
// l'element audio ait une source. Retourne l'etat audio.
async function searchAndPlay(page, nth = 0, avoidCurrent = false) {
  const box = page.locator("input[type=search], input[role=searchbox], input[placeholder*='earch' i], input[placeholder*='herch' i], input[name*='earch' i]").first();
  if (await box.count() === 0) await page.locator("a[href*='search'], button[aria-label*='earch' i], button[aria-label*='herch' i], a[aria-label*='herch' i]").first().click({ timeout: 5000 }).catch(() => {});
  const b2 = page.locator("input[type=search], input[placeholder*='earch' i], input[placeholder*='herch' i], input").first();
  await b2.click({ timeout: 8000 }); await b2.fill(QUERY); await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  // The suggestions overlay can stay open above the results (BACKLOG P3) and swallow later clicks.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);
  let sub = page.getByText(/Song\s*•/).nth(nth);
  await sub.waitFor({ state: "visible", timeout: 15000 });
  if (avoidCurrent) {
    // Clicking the track that is already current (restored session) is a no-op: pick another row.
    const cur = ((await page.locator(".now-playing-title, .player-title").first().innerText().catch(() => "")) || "").trim().toLowerCase();
    const n = await page.getByText(/Song\s*•/).count();
    for (let i = 0; i < Math.min(n, 8); i++) {
      const cand = page.getByText(/Song\s*•/).nth(i);
      const rowText = ((await cand.locator("xpath=..").innerText().catch(() => "")) || "").toLowerCase();
      if (!cur || !rowText.includes(cur.slice(0, 20))) { sub = cand; break; }
    }
  }
  await sub.click({ position: { x: 8, y: 8 }, timeout: 8000 }); // left edge: the artist link has a 26 px tap box since cycle 14
  let st = await pollUntil(async () => { const s = await audioState(page); return s && s.src ? s : null; }, 30000);
  if (!st) {
    // Clicking the restored current track is a no-op (see BACKLOG cycle 3): try the next Song row once.
    const alt = page.getByText(/Song\s*•/).nth(nth + 1);
    if (await alt.count()) {
      await alt.click({ position: { x: 8, y: 8 }, timeout: 8000 }).catch(() => {});
      st = await pollUntil(async () => { const s = await audioState(page); return s && s.src ? s : null; }, 30000);
    }
  }
  if (!st) throw new Error("no <audio> source after clicking a Song row (state=" + JSON.stringify(await audioState(page)) + ")");
  return st;
}
async function assertAdvancing(page, label) {
  const s0 = await pollUntil(async () => { const s = await audioState(page); return s && s.t > 0 ? s : null; }, 20000);
  await sleep(2500);
  const s1 = await audioState(page);
  if (!s0 || !s1 || !(s1.t > s0.t)) throw new Error(`${label}: audio not advancing (${JSON.stringify(s0)} -> ${JSON.stringify(s1)})`);
  return `t ${s0.t.toFixed(1)}->${s1.t.toFixed(1)}`;
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    headless: true, chromiumSandbox: false,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage",
      ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])],
  });

  // Every page.goto waits for "load" then up to 4 s of network quiet: the static shell and the
  // client route coexist for a moment after load (duplicate rows, blocked clicks), while a
  // full networkidle can never fire once the startup restoration caches a whole track.
  { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), ...HARNESS_HEADERS } }); const np = c.newPage.bind(c); c.newPage = async () => { const p = await np(); const g = p.goto.bind(p); p.goto = async (u, o2) => { const r = await g(u, o2); await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); return r; }; return p; }; return c; }; }
  const ctx = await newHarnessContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  // Beatbump plays through a detached Audio() object (no <audio> in the DOM): capture the real
  // media element by hooking HTMLMediaElement.prototype.play before any navigation.
  await page.addInitScript(() => {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); };
  });
  const consoleErrors = [], failedReqs = [], streams = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + String(e && e.message || e).slice(0, 300)));
  page.on("requestfailed", (r) => failedReqs.push(`${r.method()} ${r.url().slice(0, 120)} :: ${r.failure() && r.failure().errorText}`));
  page.on("response", (r) => { if (STREAM_RE.test(r.url())) streams.push({ status: r.status(), url: r.url().slice(0, 100), sw: !!r.fromServiceWorker() }); });
  let version = await servedVersion();

  await step(page, "load_home", async () => { await page.goto(URL + "/", { waitUntil: "load", timeout: 45000 }); return page.url(); });
  if (!version) version = await page.evaluate(async () => { try { return (await (await fetch("/api/v1/stats/library", { cache: "no-store" })).json()).version || null; } catch { return null; } }).catch(() => null);

  await step(page, "sw_registered", async () => {
    const ok = await pollUntil(() => page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const r = await navigator.serviceWorker.getRegistration();
      return !!(r && (r.active || r.installing || r.waiting));
    }), 20000);
    if (!ok) throw new Error("no service worker registration");
    return "sw ok";
  });

  let playedSrc = "";
  await step(page, "search_and_play", async () => {
    const st = await searchAndPlay(page);
    playedSrc = st.src;
    const adv = await assertAdvancing(page, "play");
    return `src ${st.src.slice(0, 80)} | ${adv}`;
  });

  await step(page, "same_origin_audio", async () => {
    if (!playedSrc) {
      const u = await cachedUrls(page);
      if (!u.length) throw new Error("no audio src captured and cache empty");
      if (u.some((x) => !x.startsWith(URL + "/"))) throw new Error("cached audio not same-origin: " + u.join(","));
      return "no media src captured; cached urls same-origin: " + u.length;
    }
    if (!playedSrc.startsWith(URL + "/")) throw new Error("audio src not same-origin: " + playedSrc);
    const cross = streams.filter((s) => !s.url.startsWith(URL));
    return `src same-origin (${playedSrc.slice(0, 40)}), network stream events=${streams.length}, cross=${cross.length}`;
  });

  await step(page, "auto_cache_played_track", async () => {
    const list = await pollUntil(async () => { const l = await offlineList(page); return l.length ? l : null; }, 30000);
    if (!list || !list.length) throw new Error("ytm-offline-tracks empty after play");
    const urls = await pollUntil(async () => { const u = await cachedUrls(page); return u.length ? u : null; }, 60000);
    if (!urls || !urls.length) throw new Error("audio cache empty after play");
    return `list=${list.length} first=${(list[0].title || list[0].videoId || "?").slice(0, 40)} cached=${urls.length}`;
  });

  await step(page, "prefetch_next_cached", async () => {
    const urls = await pollUntil(async () => { const u = await cachedUrls(page); return u.length >= 2 ? u : null; }, 60000);
    if (!urls) throw new Error("next track not prefetched into cache (cache < 2 entries)");
    return `cache entries=${urls.length}`;
  });

  await step(page, "offline_playback_from_offline_page", async () => {
    await ctx.setOffline(true);
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const ctl = page.getByRole("button", { name: /tout lire|play all|aléatoire|aleatoire|shuffle|mixtape/i }).first();
    if (await ctl.count()) { await ctl.click({ timeout: 8000 }); }
    else {
      const anyRow = page.getByText(/•/).first();
      if (await anyRow.count() === 0) throw new Error("offline page shows no controls and no tracks");
      await anyRow.click({ timeout: 8000 });
    }
    let adv;
    try { adv = await assertAdvancing(page, "offline"); } finally { await ctx.setOffline(false); }
    return `offline play ${adv}`;
  });

  await step(page, "pin_offline", async () => {
    // Cycle 9 (O1): pin a cached track from the Offline page; the toggle flips and the SW keeps the flag.
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const recents = page.getByRole("button", { name: /r[ée]cents/i }).first();
    if (await recents.count()) await recents.click({ timeout: 4000 }).catch(() => {});
    await sleep(800);
    // c32a (U11-7): one name for keeping music offline; the row pin is labelled "Garder hors-ligne".
    const pinBtn = page.locator('.row [aria-label="Garder hors-ligne"], [aria-label="Épingler hors-ligne"]').first();
    await pinBtn.waitFor({ state: "visible", timeout: 10000 });
    await pinBtn.click({ timeout: 5000 });
    await page.locator('.row [aria-label="Ne plus garder hors-ligne"], [aria-label="Désépingler"]').first().waitFor({ state: "visible", timeout: 10000 });
    const pinned = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const ctl = navigator.serviceWorker.controller || reg.active;
      return await new Promise((resolve) => {
        const on = (ev) => { if (ev.data && ev.data.type === "audio-list") { navigator.serviceWorker.removeEventListener("message", on); resolve((ev.data.entries || []).filter((e) => e.pinned).length); } };
        navigator.serviceWorker.addEventListener("message", on);
        ctl && ctl.postMessage({ type: "list-audio" });
        setTimeout(() => resolve(-1), 5000);
      });
    });
    if (pinned < 1) throw new Error("SW reports no pinned entry (" + pinned + ")");
    return `pinned entries in SW: ${pinned}`;
  });

  await step(page, "mixtape_sheet", async () => {
    // Cycle 8 (c8c): the Mixtape button opens an options sheet with a preview and a play action.
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2000);
    const btn = page.getByRole("button", { name: /mixtape/i }).first();
    await btn.waitFor({ state: "visible", timeout: 10000 });
    if (await btn.isDisabled()) return "mixtape disabled (fewer than 2 ready tracks)";
    await btn.click({ timeout: 5000 });
    const sheet = page.locator("#mixtape-sheet");
    await sheet.waitFor({ state: "visible", timeout: 8000 });
    await page.locator("#mixtape-preview").waitFor({ state: "visible", timeout: 8000 });
    const preview = (await page.locator("#mixtape-preview").innerText()).replace(/\s+/g, " ").slice(0, 60);
    await page.locator("#mixtape-reshuffle").click({ timeout: 5000 }).catch(() => {});
    await page.locator("#mixtape-close").click({ timeout: 5000 });
    await sleep(400);
    if (await sheet.isVisible().catch(() => false)) throw new Error("sheet still open after close");
    return `sheet ok, preview=${JSON.stringify(preview)}`;
  });

  // Cycle 18 steps (brainstorm v2 V1 O10 O8): enabled once the c18 lanes are in the build.
  const C18_STEPS_ENABLED = true;
  const c18step = (name, fn) => (C18_STEPS_ENABLED ? step(page, name, fn) : Promise.resolve());

  await c18step("offline_badges", async () => {
    // V1: the cached track's row carries data-offline=ready; offline, a non-cached row is disabled.
    // Deterministic: ask the SW which tracks this run cached and search that exact title in the
    // library view (the anonymous harness profile has no history, and YouTube's top results may not
    // contain the cached tracks: chains 32/34/39 flaked on both).
    const localTitles = await page.evaluate(() => { try { return (JSON.parse(localStorage.getItem("ytm-offline-tracks") || "[]") || []).map((e) => e.title || "").filter(Boolean); } catch { return []; } }).catch(() => []);
    const swTitles = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; const ctl = navigator.serviceWorker.controller || reg.active; return await new Promise((resolve) => { const on = (ev) => { if (ev.data && ev.data.type === "audio-list") { navigator.serviceWorker.removeEventListener("message", on); resolve((ev.data.entries || []).map((e) => e.title || "").filter(Boolean)); } }; navigator.serviceWorker.addEventListener("message", on); ctl && ctl.postMessage({ type: "list-audio" }); setTimeout(() => resolve([]), 5000); }); }).catch(() => []);
    const cachedTitles = [...new Set([...localTitles, ...swTitles])];
    const ready = page.locator('[data-offline="ready"]');
    let nReady = 0, where = "";
    for (const t of cachedTitles.slice(0, 3)) {
      await page.goto(URL + "/search/" + encodeURIComponent(t) + "?filter=library", { waitUntil: "load", timeout: 45000 });
      await ready.first().waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
      nReady = await ready.count(); if (nReady) { where = "library:" + t.slice(0, 20); break; }
    }
    if (!nReady) {
      await page.goto(URL + "/library/recent", { waitUntil: "load", timeout: 45000 });
      await ready.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      nReady = await ready.count(); where = "/library/recent";
    }
    if (!nReady) {
      await page.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=songs", { waitUntil: "load", timeout: 45000 });
      await ready.first().waitFor({ state: "visible", timeout: 15000 });
      nReady = await ready.count(); where = "search songs";
    }
    await page.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
    await page.getByText(/Song\s*•/).first().waitFor({ state: "visible", timeout: 15000 });
    await ctx.setOffline(true);
    try {
      await page.evaluate(() => window.dispatchEvent(new Event("offline"))).catch(() => {});
      await sleep(800);
      const disabled = await page.locator('[aria-disabled="true"]').count();
      if (disabled < 1) throw new Error("no disabled row while offline");
      return `ready=${nReady} (${where}), disabled offline=${disabled}`;
    } finally { await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {}); }
  });

  await c18step("storage_persist", async () => {
    // O10: after a pin, Settings > Offline reports the persisted-storage state.
    await page.goto(URL + "/settings", { waitUntil: "domcontentloaded", timeout: 30000 });
    const el = page.locator("#offline-persisted").first();
    await el.waitFor({ state: "visible", timeout: 15000 });
    const txt = (await el.innerText()).replace(/\s+/g, " ").trim();
    const persisted = await page.evaluate(() => navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : null);
    if (!/stockage/i.test(txt)) throw new Error("label: " + txt.slice(0, 60));
    return `${txt.slice(0, 50)} (navigator: ${persisted})`;
  });

  await c18step("keep_album_offline", async () => {
    // O8: "Garder hors-ligne" on a local album downloads then pins every track.
    // The albums grid navigates with click handlers (no hrefs): take a local album id from the API.
    await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    // HD1: fixed small album (fixtures.json localAlbumId, 4 tracks) when present, else the newest one.
    const albumId = FIX.localAlbumId || await page.evaluate(async () => { const r = await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc"); const d = await r.json(); return d && d.items && d.items[0] && d.items[0].browseId; });
    if (!albumId) throw new Error("no local album from the API");
    await page.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
    const keep = page.locator('[data-testid="keep-offline"]').first();
    await keep.waitFor({ state: "visible", timeout: 20000 });
    await keep.click({ timeout: 5000 });
    const done = await pollUntil(async () => { const t = ((await keep.innerText().catch(() => "")) || "").trim(); return /pr[êe]t hors-ligne|\d+\s*\/\s*\d+\s*pr[êe]ts/i.test(t) ? t : null; }, 180000, 3000);
    if (!done) throw new Error("keep-offline never reported progress: " + (await keep.innerText().catch(() => "")));
    const txt = await pollUntil(async () => { const t = ((await keep.innerText().catch(() => "")) || "").trim(); return /pr[êe]t hors-ligne/i.test(t) ? t : null; }, 240000, 3000);
    if (!txt) throw new Error("not ready after 4 min: " + done);
    return txt;
  });

  // Cycle 28 (HL1): the Albums view shows a readiness state per album after the auto-cache steps.
  const C28_OFFLINE_ENABLED = true;
  const c28off = (name, fn) => (C28_OFFLINE_ENABLED ? step(page, name, fn) : Promise.resolve());
  await c28off("album_readiness", async () => {
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const albums = page.getByRole("button", { name: /^albums$/i }).first();
    if (await albums.count()) await albums.click({ timeout: 4000 }).catch(() => {});
    await sleep(800);
    const ready = page.locator('[data-testid="album-ready"]');
    await ready.first().waitFor({ state: "visible", timeout: 10000 });
    const txt = (await ready.first().innerText()).replace(/\s+/g, " ").trim();
    if (!/\d+\s*\/\s*\d+/.test(txt)) throw new Error("readiness text: " + txt);
    return `${txt}, complete buttons=${await page.locator('[data-testid="album-complete"]').count()}`;
  });

  // Cycle 29 (HL2 free-up, HL3 sized pack): offline settings, after the auto-cache steps.
  const C29_OFFLINE_ENABLED = true;
  const c29off = (name, fn) => (C29_OFFLINE_ENABLED ? step(page, name, fn) : Promise.resolve());
  await c29off("free_up_and_pack", async () => {
    // c30b (F7/F15): the Espace card lives on the Hors-ligne page, Settings keeps switches only.
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
    // c37c (U12-9): the Espace card is folded by default; expand it through its disclosure first.
    const tg = page.locator('[data-testid="space-toggle"]').first();
    await tg.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if ((await tg.count()) && (await tg.getAttribute("aria-expanded")) !== "true") { await tg.click({ timeout: 5000 }); await sleep(500); }
    const fu = page.locator('[data-testid="free-up"]').first();
    await fu.waitFor({ state: "visible", timeout: 15000 });
    let fuNote = "free-up disabled (empty cache)";
    if (await fu.isEnabled()) {
      await fu.click({ timeout: 5000 });
      const plan = page.locator('[data-testid="free-up-plan"]').first();
      await plan.waitFor({ state: "visible", timeout: 15000 });
      const p0 = await page.evaluate(() => window.__ytmFreeUpPlan || null);
      if (!p0 || p0.applied !== false) throw new Error("no plan global: " + JSON.stringify(p0));
      // c51b: the SW answers list-audio with reply() -> event.source.postMessage({type:"audio-list"}), a
      // "message" event on navigator.serviceWorker, never on the transferred port: the port-only reader
      // always timed out at -2. Same form as swList in steps-c38-offline.cjs (listener + port fallback,
      // 5 s, listener removed on settle). -1 = no SW, -2 = no answer in 5 s, -3 = evaluate threw.
      const pinnedBefore = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        if (!r || !r.active) return -1;
        const ctl = navigator.serviceWorker.controller || r.active;
        return new Promise((res) => {
          let settled = false;
          const done = (v) => { if (settled) return; settled = true; navigator.serviceWorker.removeEventListener("message", on); res(v); };
          const count = (d) => ((d && d.entries) || []).filter((x) => x && x.pinned).length;
          const on = (ev) => { if (ev.data && ev.data.type === "audio-list") done(count(ev.data)); };
          navigator.serviceWorker.addEventListener("message", on);
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => done(count(e.data));
          ctl.postMessage({ type: "list-audio" }, [ch.port2]);
          setTimeout(() => done(-2), 5000);
        });
      }).catch(() => -3);
      if (p0.count > 0) {
        await page.locator('[data-testid="free-up-confirm"]').first().click({ timeout: 5000 });
        await page.locator('[data-testid="free-up-result"]').first().waitFor({ state: "visible", timeout: 30000 });
        const p1 = await page.evaluate(() => window.__ytmFreeUpPlan || null);
        if (!p1 || p1.applied !== true || p1.removed !== p0.count) throw new Error("free-up not applied: " + JSON.stringify(p1));
        fuNote = `freed ${p1.removed} entries (${Math.round((p1.freedBytes || 0) / 1048576)} Mo), pinned before=${pinnedBefore >= 0 ? pinnedBefore : "unknown(" + pinnedBefore + ")"}`;
      } else {
        await page.locator('[data-testid="free-up-cancel"]').first().click({ timeout: 5000 }).catch(() => {});
        fuNote = "plan empty (only pinned entries)";
      }
    }
    const size = page.locator('[data-testid="pack-size"]').first();
    await size.waitFor({ state: "visible", timeout: 10000 });
    await size.selectOption("100");
    await page.locator('[data-testid="pack-start"]').first().click({ timeout: 5000 });
    const prog = page.locator('[data-testid="pack-progress"]').first();
    await prog.waitFor({ state: "visible", timeout: 15000 });
    const st = await pollUntil(async () => { const s = await prog.getAttribute("data-state"); return s && s !== "planning" ? s : null; }, 20000);
    let packNote = `pack state=${st}, total=${await prog.getAttribute("data-total")}`;
    if (st === "running") {
      await sleep(1500);
      const t0 = Date.now();
      await page.locator('[data-testid="pack-cancel"]').first().click({ timeout: 5000 });
      const fin = await pollUntil(async () => { const s = await prog.getAttribute("data-state"); return s === "cancelled" || s === "done" ? s : null; }, 6000);
      const dt = Date.now() - t0;
      if (!fin) throw new Error("pack did not stop after cancel");
      if (dt > 3000) throw new Error(`cancel took ${dt} ms`);
      const pp = await page.evaluate(() => window.__ytmPackPlan || null);
      packNote += `, cancelled in ${dt} ms, ready=${pp && pp.result && pp.result.ready}`;
    }
    return `${fuNote}; ${packNote}`;
  });

  // Cycle 38 offline steps live in steps-c38-offline.cjs.
  await require("./steps-c38-offline.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, fixtures: FIX, newHarnessContext });
  await require("./steps-c44-offline.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, fixtures: FIX, newHarnessContext });

  await step(page, "me_pages_offline_message", async () => {
    // Cycle 16 (c16b): offline, the server-backed library pages say so instead of an empty list.
    // Playwright's setOffline does not reach the service worker's own fetches (separate target), so
    // with the SW the page would get real data; without the SW the route chunk cannot load offline.
    // So: keep the SW (precached chunks) and make the page's own fetch of /api/v1/me/* fail while
    // navigator.onLine is false, which is the page's second detection path (meLoadOffline err + offline).
    const op = await ctx.newPage();
    try {
      await op.addInitScript(() => {
        const orig = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const u = typeof input === "string" ? input : (input && input.url) || "";
          if (!navigator.onLine && /\/api\/v1\/me\//.test(u)) return Promise.reject(new TypeError("Failed to fetch (harness offline)"));
          return orig(input, init);
        };
      });
      await op.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await ctx.setOffline(true);
      await op.evaluate(() => window.dispatchEvent(new Event("offline"))).catch(() => {});
      await op.evaluate(() => { const a = document.createElement("a"); a.href = "/library/recent"; a.id = "__h"; a.textContent = "x"; document.body.appendChild(a); a.click(); });
      const box = op.locator('[data-testid="me-offline"]');
      await box.first().waitFor({ state: "visible", timeout: 20000 });
      const txt = (await box.first().innerText()).replace(/\s+/g, " ").trim();
      if (!/hors connexion/i.test(txt)) throw new Error("message: " + txt.slice(0, 60));
      const link = box.locator("a[href*='downloads-offline'], button").first();
      if (await link.count() === 0) throw new Error("no way to the Offline page");
      return txt.slice(0, 70);
    } finally { await ctx.setOffline(false); await op.close().catch(() => {}); }
  });

  await step(page, "offline_banner", async () => {
    // Offline on an online-only page: the layout must say so and link to the Offline page
    // (the SW answers {"offline":true} and the page would otherwise stay empty).
    await ctx.setOffline(true);
    try {
      await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.evaluate(() => window.dispatchEvent(new Event("offline"))).catch(() => {});
      const banner = page.locator(".offline-banner");
      await banner.waitFor({ state: "visible", timeout: 10000 });
      const link = banner.locator("a[href*='downloads-offline']");
      if (await link.count() === 0) throw new Error("banner without link to the Offline page");
      const txt = (await banner.innerText()).replace(/\s+/g, " ").trim();
      await page.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {});
      await sleep(300);
      if (await banner.isVisible().catch(() => false)) throw new Error("banner still visible after online event");
      return `banner ok: ${txt.slice(0, 60)}`;
    } finally { await ctx.setOffline(false); }
  });

  await step(page, "download_to_device_no_dead_end", async () => {
    await page.goto(URL + "/", { waitUntil: "load", timeout: 45000 }).catch(() => {});
    await searchAndPlay(page, 0, true); // eviter le morceau courant restaure (clic = no-op)
    await sleep(2000);
    const dlBtn = page.locator("[aria-label*='download to device' i], [title*='download to device' i], button:has-text('Download to device'), [aria-label*='télécharger' i]").first();
    if (await dlBtn.count() === 0) throw new Error("no 'Download to device' control found");
    const dl = page.waitForEvent("download", { timeout: 60000 }); // prod full tier: the device download took 29 to 37 s (chain 55), 30 s was a coin flip
    dl.catch(() => {});
    await dlBtn.click({ timeout: 8000 });
    const d = await dl;
    await sleep(1000);
    if (await bannerVisible(page)) throw new Error("dead-end banner 'acquisition en cours' shown");
    return `download: ${d.suggestedFilename()}`;
  });

  fs.writeFileSync(path.join(OUT, "console.log"), consoleErrors.join("\n"));
  fs.writeFileSync(path.join(OUT, "failed.log"), failedReqs.join("\n"));
  fs.writeFileSync(path.join(OUT, "streams.json"), JSON.stringify(streams, null, 2));
  await ctx.close(); await browser.close();
  const report = writeReport(version);
  process.exit(report.failed ? 1 : 0);
})();
