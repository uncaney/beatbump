// ytm-e2e-core: non-regression of the main user journeys of the music app (real browser).
// Companion of harness-offline.cjs, same conventions (run.sh <url> <query> harness-core.cjs).
// Playback is detected through a HTMLMediaElement.play hook (Beatbump plays through a detached Audio()).
//
// Fixtures (cycle 34 HD1): e2e/fixtures.json (or HARNESS_FIXTURES=<file>, see run.sh) holds fixed inputs
// so that two runs exercise the same tracks / albums and no run triggers a NEW acquisition. Every key is
// optional: a missing file or key falls back to an API lookup (first search result, newest local album,
// first local track, ...). Steps whose precondition the target cannot meet (no YouTube-backed fixture,
// library too small) end as "SKIP <name> - <reason>" (report.skipped), never as a failure.
//   query              default search query when --query= is not given
//   typoQuery          misspelt query for the typo-tolerant suggestions step (default: one letter dropped)
//   acquiredVideoId    YouTube videoId whose track is ALREADY in the library (owned by content),
//                      used for /listen OG cards, share-target, next/related caches and
//                      nonlocal_track_plays (env NONLOCAL_VIDEO_ID still wins); replaces
//                      dQw4w9WgXcQ / fa5IWHDbftI / 9bZkp7q19f0
//   acquiredVideoTitle its title (documentation only)
//   localLid           a playable local lid (/localf), short track with synced lyrics (default: first
//                      item of /api/v1/local/songs)
//   localLidTitle      its title (documentation only)
//   localAlbumId       local album lb-... with >= 3 tracks (replaces "newest local album")
//   localAlbumTitle    its title, and localAlbumArtist its artist: albums/match input
//   localAlbumTracks   its track count (documentation only)
//   localArtistId      local artist la-... (play_all_bars, buttons_readable)
//   localArtistName    its name (documentation only)
//   ytAlbumId          a fixed YouTube MPREb_ album (owned locally; for later steps / lanes)
//   genre              a local genre with >= genreMinTracks tracks (/api/v1/local/genres)
//   robotUserAgents    link-preview robot UAs that must receive the OG card on /listen
//   humanUserAgent     a browser UA that must receive the SPA shell
//
// Report (cycle 34 HD2/HD3): report.json keeps url/query/passed/failed/steps[].name/ok/detail/shot
// and adds version (served stats/library.version), startedAt, finishedAt, durationMs, budgetMs,
// overBudget, upstream (count) and per step durationMs, slow (over its budget, not a failure),
// upstream (failure caused by YouTube / the network: not counted in failed), rerun (known-flaky step
// retried once; firstDetail keeps the first failure) and skipped (precondition not met on this target).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const lib = require("./harness-lib.cjs");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));

const FIX = lib.loadFixtures();
const arg = (k, d = "") =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", process.env.YTM_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const OUT = arg("out", "/out");
// c52c (B9-13): every browser context of the harness sends X-Ytm-Harness: 1 so prod stats never record a
// harness play (api/me_stats.go harnessRequest; a staging target may set YTM_STATS_INCLUDE_HARNESS=1). The
// wrapper on browser.newContext below merges it too, so a module calling browser.newContext directly is still
// covered; the helper is what the step modules receive through deps.newHarnessContext (check-harness-headers.cjs).
const HARNESS_HEADERS = lib.HARNESS_HEADERS;
function newHarnessContext(browser, opts) {
  const o = opts || {};
  return browser.newContext({ ...o, extraHTTPHeaders: { ...(o.extraHTTPHeaders || {}), ...HARNESS_HEADERS } });
}
module.exports = { newHarnessContext, HARNESS_HEADERS };
const QUERY = arg("query", FIX.query || "daft punk");
const TYPO_QUERY = FIX.typoQuery || lib.typoOf(QUERY);
const RESOLVER = arg("resolver", "");
const VID = FIX.acquiredVideoId || ""; // empty = no YouTube-backed fixture: the steps that need one skip
let LID = FIX.localLid || ""; // resolved from /api/v1/local/songs below when the fixture is absent
const { skip, rawRequest } = lib;
const libraryAtLeast = (n) => lib.libraryAtLeast(URL, n);
const requireLibrary = (n, what) => lib.requireLibrary(URL, n, what);
const requireMixCards = () => lib.requireMixCards(URL);
const ROBOT_UAS = Array.isArray(FIX.robotUserAgents) && FIX.robotUserAgents.length ? FIX.robotUserAgents : ["WhatsApp/2.23.20.0 A"];
const HUMAN_UA = FIX.humanUserAgent || "Mozilla/5.0 (X11; Linux x86_64) Chrome/126";
// Fixture album / artist when present, else the old API lookup (run inside the page).
const fixtureAlbumId = async (page) => FIX.localAlbumId || page.evaluate(async () => { const r = await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc"); const d = await r.json(); return d && d.items && d.items[0] && d.items[0].browseId; });

fs.mkdirSync(OUT, { recursive: true });
let shotN = 0;
const steps = [];
const STARTED = Date.now();
// HD2: per-step budget (slow: true beyond it, never a failure) and total budget for the run.
const STEP_BUDGET_DEFAULT_MS = 60000;
const STEP_BUDGET_MS = { recent_by_day: 120000, resume_remote: 120000, buttons_readable: 150000, lyrics_from_player_mobile: 90000 };
// c47a (B8-14, B8-17): two tiers. HARNESS_TIER=chain (default; staging chains, stage-cycle.sh) skips the four
// slow, rarely-regressing steps of FULL_ONLY (brainstorm v8 2.3: resume_take_over 59 s, covered by resume_remote;
// buttons_readable 44 s, visual audit; recent_by_day 43 s, never regressed since cycle 23; french_program_screens
// 32 s, doubled by the vitest anti-English test of c31a). HARNESS_TIER=full (prod harness after a promotion,
// finish-cycle.sh) plays everything. Every step name stays; a step skipped by the tier is listed in
// report.skippedTier and printed as "SKIP <name>". A step may also declare opts.tier = "full".
// HARNESS_ONLY=a,b plays only those steps (rule: a new step is played ALONE before it enters a chain).
// Total budget: 8 min for chain, 12 min for full.
const TIER = String(process.env.HARNESS_TIER || "chain").toLowerCase() === "full" ? "full" : "chain";
const FULL_ONLY = new Set(["resume_take_over", "buttons_readable", "recent_by_day", "french_program_screens"]);
const ONLY = new Set(String(process.env.HARNESS_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
const skippedTier = [];
const TOTAL_BUDGET_MS = (TIER === "full" ? 12 : 8) * 60000;
// HD3: failures caused upstream (YouTube `next`, the box network under load) are reported apart.
const UPSTREAM_RE = /Invalid response was returned from `next`|ERR_INTERNET_DISCONNECTED|ERR_CERT_VERIFIER_CHANGED|net::ERR_/;
// HD3: known-flaky steps get ONE automatic rerun before counting as failed (BACKLOG / RUNBOOK 6.4).
const FLAKY_KNOWN = new Set(["offline_badges", "mediasession_real_handlers", "first_run_and_live_region", "artist_page", "resume_remote", "queue_reorder_next", "lyrics_from_player_mobile", "lyrics_fast_after_open"]);
async function shot(page, label) {
  const f = `${String(++shotN).padStart(2, "0")}-${label.replace(/\W+/g, "_")}.png`;
  await page.screenshot({ path: path.join(OUT, f) }).catch(() => {});
  return f;
}
async function step(page, name, fn, opts = {}) {
  // c47a: HARNESS_ONLY plays the named steps only; the chain tier skips the full-only steps (name kept).
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
      if (lib.isSkip(e)) {
        // Precondition not met on this target (small library, no YouTube-backed fixture, ...): neither a
        // pass nor a failure. Counted in report.skipped, printed as "SKIP <name> - <reason>".
        const durationMs = Date.now() - t0;
        steps.push({ name, ok: true, skipped: true, detail: msg, durationMs });
        console.log("SKIP", name, "-", msg);
        return true;
      }
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
// Served version without the browser: plain GET of <URL>/api/v1/stats/library (harness-lib rawRequest, which
// honours HARNESS_RESOLVE_IP for a named host whose hairpin route is broken).
const servedVersion = () => lib.servedVersion(URL);
// Does the server count harness plays (YTM_STATS_INCLUDE_HARNESS=1, a staging setting)? Read from the answer
// to a harness PUT on me/nowplaying ({"ignored":true} = prod rule), env HARNESS_STATS_INCLUDE_HARNESS=0|1 wins.
// The steps that need counted plays are not played otherwise (listed in report.envSkipped, no SKIP line:
// they are an environment choice, not a missing precondition).
async function detectStatsInclude(page) {
  const env = String(process.env.HARNESS_STATS_INCLUDE_HARNESS || "").trim();
  if (env === "0" || env === "1") return env === "1";
  const r = await page.evaluate(async () => {
    try {
      const x = await fetch("/api/v1/me/nowplaying", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: "harness-probe", deviceName: "Harness", position: 0, payload: { v: 1, mix: [] } }) });
      const j = await x.json().catch(() => null);
      return { status: x.status, ignored: !!(j && j.ignored === true) };
    } catch (e) { return { status: 0, ignored: true, err: String(e) }; }
  }).catch(() => ({ status: 0, ignored: true }));
  return r.status === 200 && !r.ignored;
}
const envSkipped = [];
// c51b: the steps the step modules gate at run time, so the coordinator reads `gated` in report.json
// instead of the files. Each module exports its C<N>_SKIP Set (+ env C<N>_SKIP="a,b" adds to it,
// C<N>_STEPS_ENABLED=0 gates the whole module). Read-only, never throws: a module that cannot be
// required is reported as { module, step: "*", reason: "require failed" }.
const GATED_MODULES = [
  ["steps-c38-core.cjs", "C38_SKIP", "C38_STEPS_ENABLED"], ["steps-c42-core.cjs", "C42_SKIP", "C42_STEPS_ENABLED"],
  ["steps-c43-ux.cjs", "C43_SKIP", "C43_STEPS_ENABLED"], ["steps-c44-core.cjs", "C44_SKIP", "C44_STEPS_ENABLED"],
  ["steps-c45-core.cjs", "C45_SKIP", "C45_STEPS_ENABLED"], ["steps-c45-stats.cjs", "C45_SKIP", "C45_STEPS_ENABLED"],
  ["steps-c47-core.cjs", "C47_SKIP", "C47_STEPS_ENABLED"], ["steps-c48-core.cjs", "C48_SKIP", "C48_STEPS_ENABLED"],
  ["steps-c48-artists.cjs", "C48B_SKIP", "C48B_STEPS_ENABLED"], ["steps-c48-dayone.cjs", "C48_SKIP", "C48_STEPS_ENABLED"],
  // c53c (B9-20): the c51 / c52 modules were missing, so a C52_SKIP never reached report.gated (chains 61-64).
  ["steps-c51-ux.cjs", "C51_SKIP", "C51_STEPS_ENABLED"], ["steps-c51-home.cjs", "C51_SKIP", "C51_STEPS_ENABLED"],
  ["steps-c52-ux.cjs", "C52_SKIP", "C52_STEPS_ENABLED"], ["steps-c54-core.cjs", "C54_SKIP", "C54_STEPS_ENABLED"],
  ["steps-c56-core.cjs", "C56_SKIP", "C56_STEPS_ENABLED"], ["steps-c57-ux.cjs", "C57_SKIP", "C57_STEPS_ENABLED"], ["steps-c59-fr.cjs", "C59_SKIP", "C59_STEPS_ENABLED"],
];
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
  const skipped = steps.filter((s) => s.skipped);
  // c47a (B8-14, B8-18): tier, the steps the tier skipped, the time spent in gotoQuiet windows and the
  // click -> first sound delay of play_from_search (firstSoundMs, alert threshold 3 s in weekly.sh).
  // c51b: `gated` = the steps the modules' C<N>_SKIP sets (+ env) skipped in this run.
  const gated = gatedSteps(GATED_MODULES);
  const report = { url: URL, query: QUERY, version, tier: TIER, startedAt: new Date(STARTED).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - STARTED, budgetMs: TOTAL_BUDGET_MS, overBudget: finished - STARTED > TOTAL_BUDGET_MS, passed: steps.filter((s) => s.ok && !s.skipped).length, failed, upstream, skipped: skipped.length, skippedTier, envSkipped, gated, gotoCount: GOTO.n, gotoWaitMs: GOTO.waitMs, gotoHow: { networkidle: GOTO.networkidle, quiet: GOTO.quiet, cap: GOTO.cap }, firstSoundMs, steps };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${report.passed} passed / ${report.failed} failed / ${report.upstream} upstream / ${report.skipped} skipped -> ${OUT}/report.json`);
  if (skipped.length) console.log("Report skipped: " + skipped.map((s) => `${s.name} (${s.detail})`).join("; "));
  if (envSkipped.length) console.log("Report not played on this target: " + envSkipped.join(", "));
  console.log("Report gated: " + (gated.length ? gated.map((g) => `${g.step} (${g.module}, ${g.source})`).join(", ") : "none"));
  console.log(`Report budget: ${(report.durationMs / 1000).toFixed(0)} s / ${TOTAL_BUDGET_MS / 1000} s${report.overBudget ? " OVER BUDGET" : ""}, tier=${TIER}${skippedTier.length ? " (skipped " + skippedTier.join(",") + ")" : ""}, version=${version}, slow steps=${steps.filter((s) => s.slow).length}, gotoQuiet ${GOTO.n} x ${GOTO.n ? (GOTO.waitMs / GOTO.n / 1000).toFixed(2) : 0} s (idle ${GOTO.networkidle}/quiet ${GOTO.quiet}/cap ${GOTO.cap}), firstSound=${firstSoundMs === null ? "n/a" : firstSoundMs + " ms"}`);
  console.log("Report slowest: " + steps.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 5).map((s) => `${s.name} ${(s.durationMs / 1000).toFixed(1)}s`).join(", "));
  const extra = steps.filter((s) => s.upstream || s.rerun).map((s) => `${s.name}${s.upstream ? " UPSTREAM" : ""}${s.rerun ? (s.ok ? " RETRY-PASS" : " RETRY-FAIL") : ""}`);
  if (extra.length) console.log("Report upstream/retry: " + extra.join(", "));
  return report;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  return last;
}
// c47a (B8-13): the goto wrapper (see browser.newContext below) waits up to 4 s of networkidle after EVERY
// goto, and that wait never ends while the startup restoration streams / caches a track: 98 gotos in this
// file, six steps at exactly 4.1 s in chain 53. gotoQuiet(page, url, opts) navigates with "domcontentloaded"
// then waits for the FIRST of: a real networkidle (early on a page without audio), a 1.5 s window with no
// new request started (the open audio stream does not count), or the 4 s cap; then "load" if not fired yet.
// Used on the hottest main-page gotos of the chain tier (the wrapper stays for the others) and handed to the
// step modules through deps.gotoQuiet. Env: HARNESS_GOTO_QUIET_MS (1500), HARNESS_GOTO_CAP_MS (4000).
// GOTO sums the wait (report.gotoWaitMs / gotoHow) so the gain stays measured, not guessed.
const GOTO = { n: 0, waitMs: 0, networkidle: 0, quiet: 0, cap: 0 };
const GOTO_QUIET_MS = Number(process.env.HARNESS_GOTO_QUIET_MS) || 1500;
const GOTO_CAP_MS = Number(process.env.HARNESS_GOTO_CAP_MS) || 4000;
let firstSoundMs = null;
// waitQuiet(page): the wait alone (no navigation), for an in-page navigation after a click (album_page used a
// 20 s networkidle wait there, never satisfied while a track plays: 22 s per run).
async function waitQuiet(page, capMs = GOTO_CAP_MS) {
  const t1 = Date.now();
  let lastReq = t1;
  const onReq = () => { lastReq = Date.now(); };
  page.on("request", onReq);
  try {
    const idle = page.waitForLoadState("networkidle", { timeout: capMs }).then(() => "networkidle", () => null);
    const win = (async () => { while (Date.now() - t1 < capMs) { if (Date.now() - lastReq >= GOTO_QUIET_MS) return "quiet"; await sleep(100); } return "cap"; })();
    const how = (await Promise.race([idle, win])) || "cap";
    await page.waitForLoadState("load", { timeout: 1500 }).catch(() => {});
    GOTO.n++; GOTO.waitMs += Date.now() - t1; GOTO[how] = (GOTO[how] || 0) + 1;
    return how;
  } finally { page.off("request", onReq); }
}
async function gotoQuiet(page, url, opts = {}) {
  const raw = page.__rawGoto || page.goto;
  const r = await raw.call(page, url, { timeout: 45000, ...opts, waitUntil: "domcontentloaded" });
  await waitQuiet(page);
  return r;
}
async function media(page) {
  return page.evaluate(() => {
    const el = window.__ytmMedia || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}
async function search(page) {
  // Direct route first: typing into the box from an arbitrary page (artist page) is flaky.
  await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 }).catch(() => {});
  if (await page.getByText(/Song\s*•/).first().isVisible().catch(() => false)) return;
  await gotoQuiet(page, URL + "/", { timeout: 45000 });
  const box = page.locator("input[type=search], input[role=searchbox], input[placeholder*=\"earch\" i], input[name*=\"earch\" i]").first();
  const visible = await box.isVisible().catch(() => false);
  if (!visible) {
    const opener = page.locator("a[href*=\"search\"], button[aria-label*=\"earch\" i]").first();
    if (await opener.count()) await opener.click({ timeout: 5000 }).catch(() => {});
  }
  const b2 = page.locator("input[type=search], input[placeholder*=\"earch\" i], input").first();
  await b2.click({ timeout: 8000 }); await b2.fill(QUERY); await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.getByText(/Song\s*•/).first().waitFor({ state: "visible", timeout: 15000 });
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
  // c47a: the raw goto is kept on the page (p.__rawGoto) for gotoQuiet, which has its own shorter wait.
  { const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), ...HARNESS_HEADERS } }); const np = c.newPage.bind(c); c.newPage = async () => { const p = await np(); const g = p.goto.bind(p); p.__rawGoto = g; p.goto = async (u, o2) => { const r = await g(u, o2); await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); return r; }; return p; }; return c; }; }
  const ctx = await newHarnessContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); };
  });
  const pageErrors = [], consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  let version = await servedVersion();

  await step(page, "home_loads", async () => {
    const r = await page.goto(URL + "/", { waitUntil: "load", timeout: 45000 });
    const title = await page.title();
    if (!r || r.status() >= 400) throw new Error("status " + (r && r.status()));
    return `status ${r.status()} title=${JSON.stringify(title)}`;
  });
  if (!version) version = await page.evaluate(async () => { try { return (await (await fetch("/api/v1/stats/library", { cache: "no-store" })).json()).version || null; } catch { return null; } }).catch(() => null);
  // No localLid fixture: the first local track of the library plays the part (every target has one once indexed).
  if (!LID) LID = await page.evaluate(async () => { try { const d = await (await fetch("/api/v1/local/songs?limit=1", { cache: "no-store" })).json(); return (d.items && d.items[0] && d.items[0].videoId) || ""; } catch { return ""; } }).catch(() => "");
  const STATS_INCLUDE = await detectStatsInclude(page);
  console.log(`target: ${URL} version=${version} lid=${LID || "none"} acquiredVideoId=${VID || "none"} statsIncludeHarness=${STATS_INCLUDE} tier=${TIER}`);

  await step(page, "manifest_and_sw", async () => {
    const m = await page.evaluate(async () => {
      const r = await fetch("/manifest.json"); const j = r.ok ? await r.json().catch(() => null) : null;
      const s = await fetch("/service-worker.js"); return { ms: r.status, name: j && (j.name || j.short_name), icons: j && Array.isArray(j.icons) ? j.icons.length : 0, start: j && j.start_url, sws: s.status };
    });
    if (m.ms !== 200 || m.sws !== 200) throw new Error(JSON.stringify(m));
    if (!m.name || !m.icons) throw new Error("manifest incomplete " + JSON.stringify(m));
    return JSON.stringify(m);
  });

  await step(page, "search_results", async () => {
    await search(page);
    const songs = await page.getByText(/Song\s*•/).count();
    const albums = await page.getByText(/Album\s*•/).count();
    if (songs < 3) throw new Error("only " + songs + " song rows");
    return `songs=${songs} albums=${albums}`;
  });

  let firstSrc = "";
  await step(page, "play_from_search", async () => {
    const clickAt = Date.now();
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 }); // left edge: the artist link now has a 26 px tap box
    const m0 = await pollUntil(async () => { const m = await media(page); return m && m.src ? m : null; }, 30000);
    if (!m0) throw new Error("no media src after click");
    if (!m0.src.startsWith(URL + "/")) throw new Error("not same-origin: " + m0.src);
    const s0 = await pollUntil(async () => { const m = await media(page); return m && m.t > 0 ? m : null; }, 20000, 250);
    if (s0) firstSoundMs = Date.now() - clickAt; // c47a (B8-3): click -> first sound, written in report.json
    await sleep(2000); const s1 = await media(page);
    if (!s0 || !s1 || !(s1.t > s0.t)) throw new Error("not advancing " + JSON.stringify(s0) + " -> " + JSON.stringify(s1));
    firstSrc = m0.src;
    return `src=${m0.src.slice(0, 60)} t ${s0.t.toFixed(1)}->${s1.t.toFixed(1)}`;
  });

  await step(page, "next_track", async () => {
    const btn = page.locator("[aria-label=\"Morceau suivant\"], .player-btn:has(use[href*=\"skip-forward\"]), [aria-label*=\"next\" i], [title*=\"next\" i]").first();
    if (await btn.count() === 0) throw new Error("no next control found");
    await btn.click({ timeout: 8000 });
    const m = await pollUntil(async () => { const x = await media(page); return x && x.src && x.src !== firstSrc ? x : null; }, 30000);
    if (!m) throw new Error("media src did not change after next");
    const s0 = await pollUntil(async () => { const x = await media(page); return x && x.t > 0 ? x : null; }, 20000);
    await sleep(2000); const s1 = await media(page);
    if (!s0 || !s1 || !(s1.t > s0.t)) throw new Error("next track not advancing");
    return `src=${m.src.slice(0, 60)}`;
  });

  await step(page, "sleep_timer_chip", async () => {
    // Cycle 8 (c8b): player ⋮ menu > Minuterie de sommeil > Dans 15 min shows a cancel chip.
    const kebab = page.locator("footer .dd-button").last();
    let entry = page.getByText(/Minuterie de sommeil/i).first();
    for (let attempt = 0; attempt < 3; attempt++) {
      await kebab.click({ timeout: 8000 });
      await sleep(700);
      if (await entry.isVisible().catch(() => false)) break;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(500);
    }
    await entry.click({ timeout: 8000 });
    await page.getByRole("button", { name: /Dans 15/i }).first().click({ timeout: 8000 });
    const chip = page.locator('[data-testid="sleep-timer-chip"]').first();
    await chip.waitFor({ state: "visible", timeout: 8000 });
    const label = await chip.getAttribute("aria-label");
    await chip.click({ timeout: 5000 }).catch(() => {});
    await sleep(500);
    if (await chip.isVisible().catch(() => false)) throw new Error("chip still visible after cancel");
    return `chip ok (${label}), cancelled`;
  });

  await step(page, "lyrics_controls", async () => {
    // Cycle 8 (c8c): lyrics page reachable from the bar, font controls present, synced lines seek.
    const titleBefore = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
    await page.locator('footer a[aria-label="Paroles"]').first().click({ timeout: 8000 });
    await page.waitForURL(/\/lyrics/, { timeout: 15000 });
    await sleep(1500);
    const titleAfter = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
    if (!titleAfter || (titleBefore && titleAfter !== titleBefore)) throw new Error(`current track lost on navigation: "${titleBefore}" -> "${titleAfter}"`);
    // Since cycle 21 (c21c) the A-/A+ toolbar renders only when lyrics exist: wait for the toolbar
    // or for the no-lyrics message (cold lyrics fetch can take ~10 s).
    const toolbar = page.locator("#lyrics-font-plus");
    const outcome = await pollUntil(async () => {
      if (await toolbar.isVisible().catch(() => false)) return "toolbar";
      const body = ((await page.locator("main").first().innerText().catch(() => "")) || "").replace(/\s+/g, " ");
      if (/pas de paroles|paroles indisponibles|aucune parole|no lyrics/i.test(body)) return "no-lyrics";
      return null;
    }, 25000, 1000);
    if (!outcome) throw new Error("neither the lyrics toolbar nor the no-lyrics message appeared");
    if (outcome === "no-lyrics") return "no lyrics for this track (toolbar hidden by design)";
    await sleep(2500);
    const lines = page.locator('button[aria-label^="Aller à"]');
    const n = await lines.count();
    let seek = "no synced lyrics for this track";
    if (n >= 3) {
      const before = (await media(page)) || { t: 0 };
      await lines.nth(2).click({ timeout: 5000 });
      await sleep(1200);
      const after = (await media(page)) || { t: 0 };
      seek = `seek ${before.t.toFixed(1)}->${after.t.toFixed(1)}`;
    }
    return `font controls ok, lines=${n}, ${seek}`;
  });

  await step(page, "artist_page", async () => {
    await search(page);
    let a = page.getByText(/Song\s*•/).first().locator("a[href^=\"/artist/\"]").first();
    if (await a.count() === 0) a = page.locator("a[href^=\"/artist/\"]").first();
    if (await a.count() === 0) throw new Error("no artist link in results");
    const href = await a.getAttribute("href");
    if (!href || /undefined/.test(href)) throw new Error("bad artist href " + href);
    await gotoQuiet(page, URL + href, { timeout: 30000 });
    const text = await page.locator("body").innerText();
    const hs = await page.locator("h1, h2").allInnerTexts().catch(() => []);
    const h = hs.map((x) => x.trim()).find((x) => x.length > 0) || "";
    const sections = ["Songs", "Titres", "Albums", "Play Radio", "Radio", "Shuffle", "Aléatoire", "Singles"].filter((k) => text.includes(k));
    if (sections.length < 2) throw new Error("artist page incomplete (" + href + ") sections=" + sections.join(","));
    return `${href.slice(0, 40)} h=${h.slice(0, 30)}`;
  });

  await step(page, "album_page", async () => {
    await search(page);
    const row = page.getByText(/Album\s*•/).first();
    if (await row.count() === 0) throw new Error("no album row in results");
    await row.click({ timeout: 8000 });
    await page.waitForURL(/\/release\?id=|\/playlist\//, { timeout: 20000 });
    await waitQuiet(page); // c47a: was networkidle 20 s, never satisfied while the track plays (22 s per run)
    const u = page.url();
    if (/undefined/.test(u)) throw new Error("bad album url " + u);
    const durations = await page.getByText(/^\s*\d{1,2}:\d{2}\s*$/).count();
    const body = (await page.locator("body").innerText()).length;
    if (durations < 1 && body < 300) throw new Error("album page shows no tracks (" + u + ")");
    return `${u.slice(URL.length, URL.length + 40)} durations=${durations} body=${body}`;
  });

  await step(page, "library_pages", async () => {
    const r1 = await gotoQuiet(page, URL + "/library", { timeout: 30000 });
    const t1 = (await page.locator("body").innerText()).slice(0, 2000);
    const r2 = await gotoQuiet(page, URL + "/library/downloads-offline", { timeout: 30000 });
    const t2 = (await page.locator("body").innerText()).slice(0, 2000);
    if (!/hors-ligne|offline/i.test(t2)) throw new Error("offline page text missing");
    return `library ${r1 && r1.status()} offline ${r2 && r2.status()} (${/tout lire/i.test(t2) ? "controls ok" : "no controls"})`;
  });

  await step(page, "settings_page", async () => {
    const r = await gotoQuiet(page, URL + "/settings", { timeout: 30000 });
    const t = (await page.locator("body").innerText()).slice(0, 3000);
    if (!(r && r.status() < 400) || t.trim().length < 20) throw new Error("settings not rendered");
    return `status ${r.status()} len=${t.length}`;
  });

  await step(page, "not_found_page", async () => {
    // c52c (B8-15 / B9-21): not_found_page + error_page_stays + artist_not_found + explore_unknown_category merged
    // (the same consecutive main-page sequence as before, every assertion kept, detail "a ; b ; c ; d").
    const r = await gotoQuiet(page, URL + "/definitely-missing-page-xyz", { timeout: 30000 });
    const t = (await page.locator("body").innerText()).slice(0, 500).replace(/\s+/g, " ");
    const d1 = `status ${r && r.status()} text=${JSON.stringify(t.slice(0, 80))}`;
    // Cycle 5 (c5a): the error page is readable (opacity 1), offers a visible "Accueil" link
    // and no longer auto-redirects after 6 s.
    const link = page.getByRole("link", { name: /accueil|home/i }).first();
    await link.waitFor({ state: "visible", timeout: 10000 });
    const op = await page.evaluate(() => { const h = document.querySelector("main h1, h1, main"); return h ? getComputedStyle(h).opacity : "none"; });
    if (op !== "none" && Number(op) < 0.9) throw new Error("error page opacity " + op);
    await sleep(7500);
    if (!/definitely-missing-page-xyz/.test(page.url())) throw new Error("auto-redirected to " + page.url());
    const d2 = `link ok, opacity ${op}, url stable`;
    // Cycle 14: an unknown artist id shows a French not-found message, never "Internal Error".
    await gotoQuiet(page, URL + "/artist/UCxxxxxxxxxxxxxxxxxxxxxx", { timeout: 45000 });
    await page.getByRole("link", { name: /accueil|home/i }).first().waitFor({ state: "visible", timeout: 20000 });
    const txt = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    if (/internal error/i.test(txt)) throw new Error("raw upstream statusText shown");
    if (!/artiste n'existe pas|artiste introuvable/i.test(txt)) throw new Error("message: " + txt.slice(0, 80));
    const d3 = txt.match(/Cet artiste[^.]*\./)?.[0] || "fr message ok";
    // Cycle 13 (c13c): an unknown explore category shows a French not-found page with a way back.
    // domcontentloaded: a playing track keeps the network busy, networkidle never fires here.
    await gotoQuiet(page, URL + "/explore/categorie-inexistante-xyz", { timeout: 45000 });
    const nf = page.locator('[data-testid="explore-not-found"]');
    await nf.first().waitFor({ state: "visible", timeout: 15000 });
    // The testid wraps the explanation only; the heading sits beside it, so read the page text.
    const txt2 = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const back = await page.getByRole("link", { name: /explorer/i }).count();
    if (!/introuvable/i.test(txt2)) throw new Error("message: " + txt2.slice(0, 60));
    if (!back) throw new Error("no link back to Explorer");
    const d4 = txt2.slice(0, 60);
    return `${d1} ; ${d2} ; ${d3} ; ${d4}`;
  });

  await step(page, "not_found_status", async () => {
    // Cycle 13: unknown SPA routes answer a real 404 (shell still rendered), audio and API untouched.
    const r = await page.evaluate(async () => {
      const a = await fetch("/cette-page-n-existe-pas-" + Date.now(), { cache: "no-store" });
      const b = await fetch("/home", { cache: "no-store" });
      const c = await fetch("/api/v1/local/albums?sort=bogus:desc", { cache: "no-store" });
      return { unknown: a.status, home: b.status, badSort: c.status, html: (await a.text()).includes("<html") };
    });
    if (r.unknown !== 404) throw new Error("unknown route status " + r.unknown);
    if (r.home !== 200) throw new Error("/home status " + r.home);
    if (r.badSort !== 400) throw new Error("bad sort status " + r.badSort);
    if (!r.html) throw new Error("404 answer is not the shell");
    return `unknown=404 (shell), home=200, badSort=400`;
  });

  await step(page, "search_header_and_chips", async () => {
    // Cycle 5 (c5b): results page echoes the query and offers filter chips.
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const echoed = new RegExp(QUERY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(body) || (await page.locator("input").first().inputValue().catch(() => "")).toLowerCase() === QUERY.toLowerCase();
    if (!echoed) throw new Error("query not echoed on the results page");
    const chips = await page.locator(".chip, [role=tab], a[href*='filter='], button[data-filter]").count();
    if (chips < 3) throw new Error("filter chips=" + chips);
    return `query echoed, chips=${chips}`;
  });

  await step(page, "settings_single_download_toggle", async () => {
    // Cycle 5 (c5b): legacy download controls gone, one offline auto-cache switch.
    await gotoQuiet(page, URL + "/settings", { timeout: 30000 });
    const legacy = await page.getByText(/Ongoing Listening Download|Download Path/i).count();
    const sw = await page.locator("#offline-autocache").count();
    if (legacy) throw new Error("legacy download controls still present: " + legacy);
    if (sw !== 1) throw new Error("offline switch count=" + sw);
    return "ok";
  });

  await step(page, "local_suggestions", async () => {
    // Cycle 9 (c9a): typing in the search overlay shows typo-tolerant local hits first.
    await gotoQuiet(page, URL + "/home", { timeout: 45000 });
    const opener = page.locator("a[href*='search'], button[aria-label*='earch' i], button[aria-label*='herch' i], a[aria-label*='herch' i]").first();
    if (await opener.count()) await opener.click({ timeout: 5000 }).catch(() => {});
    const box = page.locator("#searchBox, input[type=search], input[placeholder*='earch' i], input[placeholder*='herch' i]").first();
    await box.click({ timeout: 8000 });
    await page.keyboard.type(TYPO_QUERY, { delay: 40 }); // real key events (the overlay listens to input + keyup)
    const local = page.locator('[data-testid="local-suggestion"]');
    await local.first().waitFor({ state: "visible", timeout: 10000 });
    const n = await local.count();
    const txt = (await local.first().innerText()).replace(/\s+/g, " ").slice(0, 60);
    await page.keyboard.press("Escape").catch(() => {});
    return `local suggestions=${n} first=${JSON.stringify(txt)}`;
  });

  await step(page, "search_empty_state", async () => {
    // Cycle 15 (c15b): a fresh profile sees "Tendances" rows in the empty search overlay;
    // after one search the query comes back as a recent search.
    const fctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const fp = await fctx.newPage();
      await fp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const open = async () => {
        const opener = fp.locator("a[href*='search'], button[aria-label*='earch' i], button[aria-label*='herch' i], a[aria-label*='herch' i]").first();
        if (await opener.count()) await opener.click({ timeout: 5000 }).catch(() => {});
        await fp.locator("#searchBox, input[type=search]").first().click({ timeout: 8000 });
      };
      await open();
      const trending = fp.locator('[data-testid="trending-suggestion"]');
      await trending.first().waitFor({ state: "visible", timeout: 15000 });
      const nt = await trending.count();
      await fp.keyboard.type(QUERY, { delay: 30 });
      await fp.keyboard.press("Enter");
      await fp.waitForURL(/\/search\//, { timeout: 20000 });
      await sleep(1500);
      await fp.keyboard.press("Escape").catch(() => {});
      await open();
      const recent = fp.locator('[data-testid="recent-search"]');
      await recent.first().waitFor({ state: "visible", timeout: 10000 });
      const txt = (await recent.first().innerText()).replace(/\s+/g, " ").toLowerCase();
      if (!txt.includes(QUERY.toLowerCase())) throw new Error("recent search text: " + txt.slice(0, 60));
      return `tendances=${nt}, recent=${JSON.stringify(txt.slice(0, 40))}`;
    } finally { await fctx.close(); }
  });

  await step(page, "queue_actions", async () => {
    // Cycle 9 (c9b): "Ajouter à la file" from a row menu grows the queue; "Vider la file" keeps one row.
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
    const rows = page.getByText(/Song\s*•/);
    await rows.first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    await sleep(3000);
    // second row's ⋮ menu → Ajouter à la file
    // Row menu "Ajouter à la file" (soft: the auto-mix already fills the queue; the hard
    // assertion of this step is "Vider la file" below).
    let added = "menu entry not reached";
    try {
      await page.locator("main .dd-button").nth(1).click({ timeout: 5000 });
      const entry = page.getByText(/Ajouter à la file/i).first();
      await entry.waitFor({ state: "visible", timeout: 4000 });
      await entry.click({ timeout: 4000 });
      added = "added via menu";
      await sleep(800);
    } catch (e) { added = "menu entry not reached (" + String(e.message || e).slice(0, 40) + ")"; }
    await page.keyboard.press("Escape").catch(() => {});
    // open the fullscreen queue (Up Next) and clear it
    await page.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
    const before = await page.locator('[data-testid="queue-row"]').count();
    const clear = page.locator('[data-testid="queue-clear"]').first();
    await clear.waitFor({ state: "visible", timeout: 8000 });
    if (await clear.isDisabled()) throw new Error("queue-clear disabled with " + before + " rows");
    await clear.click({ timeout: 5000 });
    await sleep(800);
    const after = await page.locator('[data-testid="queue-row"]').count();
    await page.keyboard.press("Escape").catch(() => {});
    if (before < 2) throw new Error("queue has fewer than 2 rows: " + before);
    if (after !== 1) throw new Error(`clear left ${after} rows`);
    return `rows ${before} -> ${after}; ${added}`;
  });

  await step(page, "queue_reorder_next", async () => {
    // Cycle 13/16 (G1, H4): after a drag reorder in Up Next, "suivant" plays the new neighbour.
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    await pollUntil(async () => { const m = await media(page); return m && m.src ? m : null; }, 30000);
    await sleep(2500);
    await page.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 });
    await sleep(1500);
    const rows = page.locator('[data-testid="queue-row"]');
    const n = await rows.count();
    if (n < 3) throw new Error("queue rows=" + n);
    const title = async (i) => ((await rows.nth(i).innerText()).replace(/\s+/g, " ").trim().replace(/^\d+\s+/, "").replace(/^En cours\s*/i, "").split(" · ")[0].slice(0, 40));
    const t1 = await title(1), t2 = await title(2);
    // drag row 3 over row 2 from its grip (pointer events; the grip shows on hover)
    const grip = rows.nth(2).locator(".drag-handle").first();
    await rows.nth(2).hover();
    const gb = await grip.boundingBox(); const tb = await rows.nth(1).boundingBox();
    if (!gb || !tb) throw new Error("no grip/target box");
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(gb.x + gb.width / 2, gb.y + (tb.y + tb.height / 3 - gb.y) * (k / 8), { steps: 2 });
    await sleep(150);
    await page.mouse.up();
    await sleep(1000);
    const u1 = await title(1), u2 = await title(2);
    if (u1 === t1 && u2 === t2) throw new Error("reorder did not apply: " + JSON.stringify([t1, t2]));
    if (u1 !== t2) throw new Error(`row 2 is ${JSON.stringify(u1)}, expected ${JSON.stringify(t2)}`);
    await page.keyboard.press("Escape").catch(() => {});
    const next = page.locator("[aria-label=\"Morceau suivant\"], [aria-label*=\"next\" i]").first();
    await next.click({ timeout: 8000 });
    await sleep(3500);
    const now = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!now || !u1.toLowerCase().startsWith(now.toLowerCase().slice(0, 12))) throw new Error(`next played ${JSON.stringify(now)}, expected ${JSON.stringify(u1)}`);
    return `moved ${JSON.stringify(t2)} before ${JSON.stringify(t1)}, next played it`;
  });

  // Cycle 18 steps (brainstorm v2 C1 P2 X1 W6): enabled once the c18 lanes are in the build.
  const C18_STEPS_ENABLED = true;
  const C18_SKIP = new Set(); // c18a merged (cfa471d)
  const c18step = (name, fn) => (C18_STEPS_ENABLED && !C18_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c18step("manifest_shortcuts", async () => {
    const m = await page.evaluate(async () => (await fetch("/manifest.json", { cache: "no-store" })).json());
    const urls = (m.shortcuts || []).map((x) => x.url || "");
    if (!urls.some((u) => /resume=1/.test(u))) throw new Error("no Reprendre shortcut: " + JSON.stringify(urls));
    if (!urls.some((u) => /search=1/.test(u))) throw new Error("no Rechercher shortcut: " + JSON.stringify(urls));
    await gotoQuiet(page, URL + "/home?search=1", { timeout: 45000 });
    const box = page.locator("#searchBox").first();
    await box.waitFor({ state: "visible", timeout: 10000 });
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id === "searchBox");
    return `shortcuts=${urls.length}, search overlay open (focused=${focused})`;
  });

  await c18step("resume_exact", async () => {
    // C1: after a reload the same track comes back, paused, near the same position, with its queue.
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    const m0 = await pollUntil(async () => { const m = await media(page); return m && m.src && m.t > 6 ? m : null; }, 40000);
    if (!m0) throw new Error("no playback before reload");
    const title0 = ((await page.locator(".now-playing-title").first().innerText()) || "").trim();
    await page.locator("footer img").first().click({ timeout: 5000 }).catch(() => {});
    await sleep(1000);
    const rows0 = await page.locator('[data-testid="queue-row"]').count();
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(5500); // the state is persisted every 5 s
    await gotoQuiet(page, URL + "/home", { timeout: 45000 });
    await sleep(3000);
    const title1 = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
    const m1 = await media(page);
    if (!title1 || title1.slice(0, 20) !== title0.slice(0, 20)) throw new Error(`restored ${JSON.stringify(title1)} != ${JSON.stringify(title0)}`);
    // Since c20a (I5) the restore primes the source in prefetch mode: the audio element may have no
    // src yet (nothing plays by itself); when it has one it must be paused at the saved position.
    if (m1 && m1.src && m1.paused !== true) throw new Error("restored track auto-played: " + JSON.stringify(m1));
    if (m1 && m1.src && !(m1.t >= 3)) throw new Error("position not restored: t=" + m1.t);
    const resumeBtn = await page.locator('[data-testid="resume-queue"]').count();
    await page.locator("footer img").first().click({ timeout: 5000 }).catch(() => {});
    await sleep(1000);
    const rows1 = await page.locator('[data-testid="queue-row"]').count();
    await page.keyboard.press("Escape").catch(() => {});
    if (rows0 >= 3 && rows1 < Math.min(rows0, 3)) throw new Error(`queue not restored: ${rows0} -> ${rows1}`);
    return `title ok, ${m1 && m1.src ? "paused at " + m1.t.toFixed(1) + "s" : "no src yet (prefetch mode)"}, resume button=${resumeBtn}, queue ${rows0} -> ${rows1}`;
  });

  await c18step("playback_context", async () => {
    // P2: playing a queue shows its context ("Album : X · 4/14", "File", ...) in the fullscreen.
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    await pollUntil(async () => { const m = await media(page); return m && m.src ? m : null; }, 30000);
    await sleep(1500);
    await page.locator("footer img").first().click({ timeout: 5000 });
    const ctx = page.locator('[data-testid="playback-context"]').first();
    await ctx.waitFor({ state: "visible", timeout: 10000 });
    const txt = (await ctx.innerText()).replace(/\s+/g, " ").trim();
    await page.keyboard.press("Escape").catch(() => {});
    if (!/\d+\s*\/\s*\d+|File|Album|Mixtape|Favoris|Pour toi/i.test(txt)) throw new Error("context text: " + txt.slice(0, 60));
    return txt.slice(0, 60);
  });

  await c18step("play_all_bars", async () => {
    // X1: a local artist page offers "Lire tout" with every title (> 12).
    let href = FIX.localArtistId ? "/artist/" + FIX.localArtistId : "";
    if (!href) {
      await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
      const artist = page.locator("a[href^='/artist/la-']").first();
      await artist.waitFor({ state: "visible", timeout: 15000 });
      href = await artist.getAttribute("href");
    }
    await gotoQuiet(page, URL + href, { timeout: 45000 });
    const all = page.locator('[data-testid="play-all"]').first();
    await all.waitFor({ state: "visible", timeout: 15000 });
    await all.click({ timeout: 5000 });
    await pollUntil(async () => { const m = await media(page); return m && m.src ? m : null; }, 30000);
    await sleep(1500);
    await page.locator("footer img").first().click({ timeout: 5000 }).catch(() => {});
    await sleep(1200);
    const rows = await page.locator('[data-testid="queue-row"]').count();
    await page.keyboard.press("Escape").catch(() => {});
    if (rows <= 12) throw new Error("queue rows after Lire tout = " + rows);
    return `artist ${href}, queue rows=${rows}`;
  });

  // Cycle 20 steps (audit v5 I1, I3): enabled once lane c20a is in the build.
  const C20_STEPS_ENABLED = true;
  const c20step = (name, fn) => (C20_STEPS_ENABLED ? step(page, name, fn) : Promise.resolve());

  await c20step("resume_default_migrated", async () => {
    // I1: a stored "Remember Last Track" = false from the old hidden default is migrated to true once.
    const fctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const fp = await fctx.newPage();
      await fp.addInitScript(() => { try { if (!localStorage.getItem("ytm-remember-migrated")) localStorage.setItem("Remember Last Track", "false"); } catch {} });
      await fp.goto(URL + "/settings", { waitUntil: "load", timeout: 45000 });
      await sleep(1000);
      const box = fp.locator("#lasttrack").first();
      await box.waitFor({ state: "attached", timeout: 10000 });
      const checked = await box.isChecked();
      const flag = await fp.evaluate(() => localStorage.getItem("ytm-remember-migrated"));
      if (!checked) throw new Error("Remember Last Track still false after migration (flag=" + flag + ")");
      return `migrated: checked=${checked}, flag=${flag}`;
    } finally { await fctx.close(); }
  });

  await c20step("shortcut_resume", async () => {
    // I3: /home?resume=1 restores the saved queue and position (paused), never lastTrack from 0:00.
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    const m0 = await pollUntil(async () => { const m = await media(page); return m && m.src && m.t > 6 ? m : null; }, 40000);
    if (!m0) throw new Error("no playback before the shortcut");
    const title0 = ((await page.locator(".now-playing-title").first().innerText()) || "").trim();
    await sleep(5500);
    await gotoQuiet(page, URL + "/home?resume=1", { timeout: 45000 });
    await sleep(3500);
    const title1 = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
    const m1 = await media(page);
    if (!title1 || title1.slice(0, 20) !== title0.slice(0, 20)) throw new Error(`shortcut restored ${JSON.stringify(title1)} != ${JSON.stringify(title0)}`);
    // Prefetch-mode restore (I5): no audio src until the first play; with a src it must be paused past 3 s.
    if (m1 && m1.src && m1.paused !== true) throw new Error("shortcut auto-played: " + JSON.stringify(m1));
    if (m1 && m1.src && !(m1.t >= 3)) throw new Error("shortcut restarted from 0: " + JSON.stringify(m1));
    return `title ok, ${m1 && m1.src ? "t=" + m1.t.toFixed(1) + " paused=" + m1.paused : "no src yet (prefetch mode)"}`;
  });

  await step(page, "nowplaying_contract", async () => {
    // Cycle 21 (c21b): me/nowplaying exists; harness writes are ignored (stats exclusion), reads answer a row, or
    // 204 when the profile has none (404 before the ship branch: a console error on every fresh profile).
    const r = await page.evaluate(async () => {
      const put = await fetch("/api/v1/me/nowplaying", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: "harness", deviceName: "Harness", position: 12, payload: { v: 1, mix: [] } }) });
      const putBody = await put.json().catch(() => null);
      const get = await fetch("/api/v1/me/nowplaying", { cache: "no-store" });
      const getBody = await get.json().catch(() => null);
      const bad = await fetch("/api/v1/me/nowplaying", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{not json" });
      return { put: put.status, putBody, get: get.status, getKeys: getBody ? Object.keys(getBody).sort().join(",") : null, bad: bad.status };
    });
    // Prod ignores harness writes ({"ignored":true}); staging runs with YTM_STATS_INCLUDE_HARNESS=1 and stores them ({"ok":true}).
    if (r.put !== 200 || !r.putBody || (r.putBody.ignored !== true && r.putBody.ok !== true)) throw new Error("harness PUT answer: " + JSON.stringify(r));
    if (![200, 204, 404].includes(r.get)) throw new Error("GET status " + r.get);
    if (r.get === 200 && !/deviceId.*payload.*position.*updatedAt/.test(r.getKeys)) throw new Error("GET shape: " + r.getKeys);
    if (![400, 200].includes(r.bad)) throw new Error("bad JSON status " + r.bad);
    return `PUT ${r.putBody.ignored ? "ignored (prod rule)" : "stored (staging flag)"}, GET ${r.get}${r.get === 200 ? " (" + r.getKeys + ")" : ""}, bad JSON ${r.bad}`;
  });

  // Cycle 23 steps (audit v6 TOP 10 item 10): need a server that counts harness plays
  // (YTM_STATS_INCLUDE_HARNESS=1, a staging setting) so the harness profile's plays reach history and
  // me/nowplaying; prod ignores harness plays by design (STATS_INCLUDE, detected above).
  const C23_STEPS_ENABLED = true;
  const C23_SKIP = new Set(); // c23a merged (0b97c13)
  const needsCountedPlays = (name) => { if (STATS_INCLUDE) return true; envSkipped.push(name); return false; };
  const c23step = (name, fn) => (C23_STEPS_ENABLED && !C23_SKIP.has(name) && needsCountedPlays(name) ? step(page, name, fn) : Promise.resolve());
  // Since cycle 25 (K12) whoami is memoised 5 min in sessionStorage ("ytm-whoami"): a raw fetch login
  // bypasses me.ts login(), so drop the memo (and the remote-consumed marker) like the app's login does.
  const loginAs = async (p, name) => { const r = await p.evaluate(async (n) => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) }); try { sessionStorage.removeItem("ytm-whoami"); } catch {} return x.status; }, name); return r; };

  await c23step("recent_by_day", async () => {
    // S3: after a counted play (>= 35 s) the history page groups by day with a replay button.
    await page.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
    const st = await loginAs(page, "harness-days");
    await page.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    const m0 = await pollUntil(async () => { const m = await media(page); return m && m.src && m.t > 36 ? m : null; }, 70000, 2000);
    if (!m0) throw new Error("playback did not reach 36 s");
    await sleep(2000);
    await page.goto(URL + "/library/recent", { waitUntil: "load", timeout: 45000 });
    const days = page.locator('[data-testid="recent-day"]');
    await days.first().waitFor({ state: "visible", timeout: 20000 });
    const n = await days.count(); const replay = await page.locator('[data-testid="replay-day"]').count();
    if (replay < 1) throw new Error("no replay-day button");
    return `login=${st}, days=${n}, replay buttons=${replay}`;
  });

  await c23step("resume_remote", async () => {
    // C2: device A plays and syncs; device B (same profile, fresh context) sees "Reprendre depuis" and restores paused.
    const name = "harness-remote-" + Date.now().toString(36);
    const ctxA = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const ctxB = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      // The media() helper relies on the play() hook installed on the main page: install it here too.
      const hook = () => { const orig = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); }; };
      await ctxA.addInitScript(hook); await ctxB.addInitScript(hook);
      const a = await ctxA.newPage();
      await a.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await loginAs(a, name);
      await a.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
      // Prefer a library row (instant /localf) over a cold YouTube row (iv-vp first byte can take ~10 s).
      const subs = a.getByText(/Song\s*•/);
      let picked = subs.first();
      for (let i = 0; i < Math.min(await subs.count(), 8); i++) {
        const isLocal = await subs.nth(i).evaluate((el) => !!(el.closest("article, li, .innercard") || el.parentElement).querySelector("a[href^='/artist/la-']")).catch(() => false);
        if (isLocal) { picked = subs.nth(i); break; }
      }
      await picked.click({ position: { x: 8, y: 8 }, timeout: 8000 });
      const mA = await pollUntil(async () => { const m = await media(a); return m && m.src && m.t > 12 ? m : null; }, 50000, 2000);
      if (!mA) throw new Error("device A did not play 12 s");
      const titleA = ((await a.locator(".now-playing-title").first().innerText()) || "").trim();
      await a.locator('[aria-label="Pause"], [aria-label*="pause" i]').first().click({ timeout: 5000 }).catch(() => a.keyboard.press("Space"));
      await sleep(3000); // the pause pushes me/nowplaying
      const row = await a.evaluate(async () => { const r = await fetch("/api/v1/me/nowplaying", { cache: "no-store" }); return r.status; });
      if (row !== 200) throw new Error("server has no nowplaying row after pause: " + row);
      const b = await ctxB.newPage();
      await b.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await loginAs(b, name);
      await b.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const card = b.locator('[data-testid="resume-remote"]').first();
      await card.waitFor({ state: "visible", timeout: 20000 });
      const txt = (await card.innerText()).replace(/\s+/g, " ").trim();
      await card.click({ timeout: 5000 });
      await sleep(3500);
      const titleB = ((await b.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
      const mB = await media(b);
      if (!titleB || titleB.slice(0, 20) !== titleA.slice(0, 20)) throw new Error(`device B restored ${JSON.stringify(titleB)} != ${JSON.stringify(titleA)}`);
      if (mB && mB.src && mB.paused !== true) throw new Error("device B auto-played");
      return `${txt.slice(0, 50)} -> restored "${titleB.slice(0, 30)}" paused`;
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  // Cycle 25 perf steps (audit perf v2 K1 K2 K3): enabled once lanes c25a/c25b are in the build.
  const C25_STEPS_ENABLED = true;
  const C25_SKIP = new Set(); // c25a merged (a95f296)
  const c25step = (name, fn) => (C25_STEPS_ENABLED && !C25_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c25step("perf_cold_home_requests", async () => {
    // K3 + K1: a cold home load stays under 90 _app requests in the first 8 s and calls me/mix once.
    // c52c (B8-15 / B9-21): perf_v3 (c33b) and perf_v4 (c37b) merged here, every assertion kept. The cold context
    // also counts whoami (perf_v4 reported it) and asserts one me/stats/recent per home load (perf_v3 asserted it
    // on a second, warm /home of the main page; the cold load is the stricter case of the same layout-remount
    // bug, and every report since cycle 47 shows me/stats/recent=1 here). NAME KEPT: weekly.sh reads this step
    // and prints its detail as "accueil a froid"; the cold-home summary stays first, parts joined by " ; ".
    const fctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    let cold;
    try {
      const fp = await fctx.newPage();
      const app = new Set(); let mix = 0, recent = 0, whoami = 0;
      fp.on("request", (r) => { const u = r.url(); if (/\/_app\//.test(u)) app.add(u.replace(/^https?:\/\/[^/]+/, "")); if (/\/api\/v1\/me\/mix/.test(u)) mix++; if (/me\/stats\/recent/.test(u)) recent++; if (/\/api\/v1\/me\/whoami/.test(u)) whoami++; });
      await fp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await sleep(8000);
      if (app.size > 90) throw new Error(`cold home: ${app.size} _app requests in 8 s`);
      if (mix > 1) throw new Error(`me/mix called ${mix} times on one home load (layout remount)`);
      if (recent > 1) throw new Error("me/stats/recent called " + recent + " times on one cold home load");
      cold = `_app requests=${app.size}, me/mix=${mix}, me/stats/recent=${recent}, whoami=${whoami}`;
    } finally { await fctx.close(); }
    // perf_v3 (c33b): search.json slimmed under the SW cap, cover 404 cacheable, home.json stale-while-revalidate.
    const sz = await page.evaluate(async (q) => { const r = await fetch("/api/v1/search.json?q=" + encodeURIComponent(q) + "&filter=all", { cache: "no-store" }); const t = await r.text(); return { bytes: t.length, cache: r.headers.get("x-ytm-cache") }; }, QUERY);
    if (sz.bytes > 300000) throw new Error("search.json still " + sz.bytes + " bytes (SW cap 300 KB)");
    const cv = await page.evaluate(async () => { const r = await fetch("/cover?lid=000000000000", { cache: "no-store" }); return { status: r.status, cc: r.headers.get("cache-control") || "" }; });
    if (cv.status === 404 && !/max-age/.test(cv.cc)) throw new Error("cover 404 without Cache-Control: " + JSON.stringify(cv));
    const hj = await page.evaluate(async () => { const a = await fetch("/api/v1/home.json", { cache: "no-store" }); const b = await fetch("/api/v1/home.json", { cache: "no-store" }); return [a.headers.get("x-ytm-cache"), b.headers.get("x-ytm-cache")]; });
    if (!/HIT|STALE/.test(String(hj[1]))) throw new Error("home.json second call not cached: " + JSON.stringify(hj));
    // perf_v4 (c37b): local/artists fast, never-played page confirmation batched.
    const t = await page.evaluate(async () => { const t0 = performance.now(); const r = await fetch("/api/v1/local/artists?limit=20", { cache: "no-store" }); await r.text(); const t1 = performance.now(); const r2 = await fetch("/api/v1/local/artists?limit=20", { cache: "no-store" }); await r2.text(); return [Math.round(t1 - t0), Math.round(performance.now() - t1)]; });
    if (Math.min(...t) > 60) throw new Error("local/artists slow: " + JSON.stringify(t) + " ms");
    const np = await page.evaluate(async () => { const t0 = performance.now(); const r = await fetch("/api/v1/local/albums?filter=never-played&limit=60", { cache: "no-store" }); const d = await r.json().catch(() => ({})); return { ms: Math.round(performance.now() - t0), items: (d.items || []).length, reason: d.reason }; });
    return `${cold} ; search.json ${sz.bytes} B (${sz.cache}), cover 404 ${cv.cc || "n/a"}, home.json ${hj.join("/")} ; local/artists ${t.join("/")} ms, never-played page ${np.ms} ms (${np.items} items${np.reason ? ", " + np.reason : ""})`;
  });

  await c25step("perf_cover_cacheable", async () => {
    // K2: a cover answer is cacheable (public, long max-age) and the SW serves it from cache the second time.
    const r = await page.evaluate(async () => {
      const home = await (await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc")).json();
      const lid = home && home.items && home.items[0] && (home.items[0].coverLid || (home.items[0].thumbnails || [])[0]?.url?.match(/lid=([^&]+)/)?.[1]);
      const url = lid ? "/cover?lid=" + encodeURIComponent(lid) : ((home.items || [])[0]?.thumbnails || [])[0]?.url;
      if (!url) return { url: null };
      const a = await fetch(url, { cache: "no-store" });
      return { url, status: a.status, cc: a.headers.get("cache-control") };
    });
    if (!r.url) throw new Error("no local cover URL to probe");
    if (r.status !== 200) throw new Error(`cover ${r.url} -> ${r.status}`);
    if (!/max-age=\d{5,}/.test(r.cc || "")) throw new Error("cover Cache-Control: " + r.cc);
    return `${r.url.slice(0, 40)} -> ${r.status}, ${r.cc}`;
  });

  await c25step("perf_api_caches", async () => {
    // K5 + K6: suggestions / next / related answers are served from the Go TTL cache on a second call.
    // next.json / related.json are YouTube-backed: they need the acquiredVideoId fixture.
    if (!VID) skip("needs the acquiredVideoId fixture (YouTube-backed next/related caches)");
    const r = await page.evaluate(async ({ vid, q }) => {
      // Read the first body to the end: the Go cache stores the entry once the handler finished writing it.
      const hit = async (u) => { await (await fetch(u, { cache: "no-store" })).text(); const x = await fetch(u, { cache: "no-store" }); return x.headers.get("x-ytm-cache"); };
      return { sugg: await hit("/api/v1/get_search_suggestions.json?q=" + encodeURIComponent(q)), next: await hit("/api/v1/next.json?videoId=" + vid), related: await hit("/api/v1/related.json?videoId=" + vid) };
    }, { vid: VID, q: QUERY.split(/\s+/)[0] });
    // PF5-6 (cycle 50): next.json and search have SWR, a second call may be STALE (served from cache, refreshing): cached too.
    const bad = Object.entries(r).filter(([, v]) => v !== "HIT" && v !== "STALE");
    if (bad.length) throw new Error("not cached on 2nd call: " + JSON.stringify(r));
    return JSON.stringify(r);
  });

  // Cycle 26 step (audit UX v8 TOP 1): the cycle 18 buttons must escape the global button rule in the
  // stylesheet the app really loads (no near-black text on dark panels). Enabled once lane c26a lands.
  const C26_STEPS_ENABLED = true;
  const c26step = (name, fn) => (C26_STEPS_ENABLED ? step(page, name, fn) : Promise.resolve());

  await c26step("buttons_readable", async () => {
    const albumId = await fixtureAlbumId(page);
    if (!albumId) throw new Error("no local album");
    await page.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
    const keep = page.locator('[data-testid="keep-offline"]').first();
    await keep.waitFor({ state: "visible", timeout: 20000 });
    // Readability = contrast between the text colour and the effective background (walk up while
    // the background is transparent; the page itself is dark), not the text luminance alone:
    // black on the green/white CTAs is fine, black on a translucent dark button is not.
    const probe = (sel) => page.locator(sel).first().evaluate((el) => {
      const lumOf = (c) => { const m = (c || "").match(/[\d.]+/g) || []; if (m.length < 3) return null; const a = m.length > 3 ? Number(m[3]) : 1; if (a < 0.3) return null; return (Number(m[0]) * 299 + Number(m[1]) * 587 + Number(m[2]) * 114) / 1000; };
      const cs = getComputedStyle(el);
      let bg = null, node = el;
      while (node && bg === null) { bg = lumOf(getComputedStyle(node).backgroundColor); node = node.parentElement; }
      if (bg === null) bg = 15;
      const text = lumOf(cs.color) ?? 0;
      return { color: cs.color, bg: cs.backgroundColor, lum: text, bgLum: bg, contrast: Math.abs(text - bg), tt: cs.textTransform, h: Math.round(el.getBoundingClientRect().height) };
    }).catch(() => null);
    const k = await probe('[data-testid="keep-offline"]');
    const artist = FIX.localArtistId || await page.evaluate(async () => { const r = await fetch("/api/v1/local/artists?limit=1"); const d = await r.json(); const it = d && d.items && d.items[0]; return it && (it.browseId || (it.endpoint && it.endpoint.browseId)); });
    let pa = null;
    if (artist) { await page.goto(URL + "/artist/" + artist, { waitUntil: "load", timeout: 45000 }); await page.locator('[data-testid="play-all"]').first().waitFor({ state: "visible", timeout: 20000 }); pa = await probe('[data-testid="play-shuffle"]'); }
    // Audit UX v9: the global rule must not beat component styles either (lyrics toolbar, Offline page, error page).
    await page.goto(URL + "/lyrics", { waitUntil: "load", timeout: 45000 });
    const ly = await probe("#lyrics-font-plus, .fbtn, main button");
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
    await sleep(1500);
    const off = await probe('button:has-text("Aléatoire"), button:has-text("Mixtape"), #mixtape-open, main button');
    await page.goto(URL + "/cette-page-n-existe-pas-" + Date.now(), { waitUntil: "load", timeout: 45000 });
    const back = await probe(".back-button, button.outlined");
    // Audit UX v10 item 9: generic guard over the album page actions, the Offline page CTA set and the
    // fullscreen panel controls (Video/Audio toggle, Vider la file) after a playback.
    await page.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
    const albumRadio = await probe('button:has-text("Album Radio"), [aria-label*="radio" i]');
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
    await sleep(1200);
    const toutLire = await probe('button:has-text("Tout lire"), button:has-text("Tout Lire")');
    const explorer = await probe('a:has-text("Explorer"), [data-testid="explore-not-found"] a');
    await page.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 }).catch(() => {});
    await sleep(2500);
    await page.locator("footer img").first().click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
    const clearQ = await probe('[data-testid="queue-clear"]');
    const toggle = await probe('.fullscreen-player-popup button:has-text("Audio"), .fullscreen-player-popup button:has-text("Vidéo"), .fullscreen-player-popup [role="tab"]');
    await page.keyboard.press("Escape").catch(() => {});
    const checks = [["keep-offline", k], ["play-shuffle", pa], ["lyrics", ly], ["offline", off], ["error-back", back], ["album-radio", albumRadio], ["tout-lire", toutLire], ["explorer", explorer], ["queue-clear", clearQ], ["video-audio", toggle]];
    const bad = checks.filter(([n, v]) => v && (v.contrast < 100 || (["keep-offline", "play-shuffle"].includes(n) && v.tt === "capitalize")));
    if (bad.length) throw new Error("dark or capitalised buttons: " + JSON.stringify(bad));
    return checks.map(([n, v]) => `${n} ${v ? v.color + "/" + Math.round(v.contrast) : "absent"}`).join("; ");
  });

  // Cycle 28 steps (brainstorm v3): enabled once lanes c28b/c28c/c28d are in the build.
  const C28_STEPS_ENABLED = true;
  const C28_SKIP = new Set(); // c28c merged (0b6dc2c)
  const c28step = (name, fn) => (C28_STEPS_ENABLED && !C28_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c28step("first_run_and_live_region", async () => {
    // ON1: a fresh profile sees the welcome block; QR1: the aria-live region announces a track change.
    const fctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const fp = await fctx.newPage();
      await fp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const fr = fp.locator('[data-testid="first-run"]');
      await fr.first().waitFor({ state: "visible", timeout: 15000 });
      const actions = await fr.locator("a, button").count();
      const live = fp.locator('[data-testid="now-playing-live"]');
      if (await live.count() === 0) throw new Error("no aria-live region");
      const preload = await fp.locator("[data-sveltekit-preload-data]").count();
      await fp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
      await fp.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
      await sleep(4000);
      await fp.locator("[aria-label=\"Morceau suivant\"], [aria-label*=\"next\" i]").first().click({ timeout: 8000 });
      await sleep(2500);
      const txt = ((await live.first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!/lecture/i.test(txt)) throw new Error("aria-live text: " + JSON.stringify(txt));
      return `first-run actions=${actions}, preload attrs on home=${preload}, live=${JSON.stringify(txt.slice(0, 50))}`;
    } finally { await fctx.close(); }
  });

  await c28step("genres_radio_library_more", async () => {
    // D4: genres playable; EQ1: targeted radio on a local album; EQ4: library search paging.
    await gotoQuiet(page, URL + "/library/genres", { timeout: 45000 });
    const gp = page.locator('[data-testid="genre-play"]');
    await gp.first().waitFor({ state: "visible", timeout: 15000 });
    const genres = await gp.count();
    const albumId = await fixtureAlbumId(page);
    await gotoQuiet(page, URL + "/release?id=" + encodeURIComponent(albumId), { timeout: 45000 });
    const radio = page.locator('[data-testid="radio-seed"]').first();
    await radio.waitFor({ state: "visible", timeout: 15000 });
    await radio.click({ timeout: 5000 });
    const m = await pollUntil(async () => { const x = await media(page); return x && x.src ? x : null; }, 30000);
    if (!m) throw new Error("radio did not start");
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=library", { timeout: 45000 });
    await sleep(2000);
    const more = await page.locator('[data-testid="library-more"]').count();
    return `genres=${genres}, radio started, library-more buttons=${more}`;
  });

  // Cycle 29 steps (brainstorm v3 D1 D3 EQ2 EQ3 HL5 BI2 BI3 ST2 ST3): enabled per lane once merged.
  const C29_STEPS_ENABLED = true;
  const C29_SKIP = new Set(); // c29b c29c c29d merged
  const c29step = (name, fn) => (C29_STEPS_ENABLED && !C29_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  // c52c (B8-15 / B9-21): share_target (HL5) merged into share_target_smart below, every assertion kept.

  await c29step("discovery_mixes_rows", async () => {
    // D1 mixes (decade/genre cards), D3 Redécouvrir, EQ2 local genres in Explore, EQ3 new in library.
    const mixes = await page.evaluate(async () => { const r = await fetch("/api/v1/local/mixes"); return r.ok ? r.json() : { status: r.status }; });
    const cards = (mixes.decades || []).length + (mixes.genres || []).length;
    await gotoQuiet(page, URL + "/library/mixes", { timeout: 45000 });
    const card = page.locator('[data-testid="mix-card"]');
    if (cards > 0) {
      await card.first().waitFor({ state: "visible", timeout: 15000 });
      await card.first().click({ timeout: 5000 });
      const m = await pollUntil(async () => { const x = await media(page); return x && x.src ? x : null; }, 30000);
      if (!m) throw new Error("mix card did not start playback");
    }
    await gotoQuiet(page, URL + "/trending", { timeout: 45000 });
    const eg = page.locator('[data-testid="explore-local-genres"]');
    await eg.first().waitFor({ state: "visible", timeout: 15000 });
    const links = await eg.locator("a[href*='genre=']").count();
    if (links < 1) throw new Error("no genre links in Explore");
    const red = await page.evaluate(async () => { const r = await fetch("/api/v1/me/stats/rediscover?limit=12"); return r.status; });
    const nil = await page.evaluate(async () => { const r = await fetch("/api/v1/me/new-in-library?days=30&limit=12"); return r.status; });
    if (red !== 200 || nil !== 200) throw new Error(`rediscover ${red}, new-in-library ${nil}`);
    return `mix cards=${cards}${cards ? " (played)" : ""}, explore genre links=${links}, rediscover/new-in-library 200`;
  });

  await c29step("library_sort_export_about", async () => {
    // BI2 remembered sort + A-Z index, BI3 CSV export, ST2 /about + stats/library, ST3 client-log.
    await gotoQuiet(page, URL + "/library/albums", { timeout: 45000 });
    await sleep(1500);
    const sortSel = page.locator("[data-testid='browse-sort'], select[name*='sort' i], select").first();
    let sortNote = "no sort control";
    if (await sortSel.count()) {
      const opts = await sortSel.locator("option").evaluateAll((os) => os.map((o) => o.value));
      const pick = opts.find((v) => /title|name/i.test(v)) || opts[opts.length - 1];
      await sortSel.selectOption(pick);
      await sleep(800);
      await page.reload({ waitUntil: "load" });
      await sleep(1500);
      const after = await page.locator("[data-testid='browse-sort'], select[name*='sort' i], select").first().inputValue();
      if (after !== pick) throw new Error(`sort not remembered: ${after} != ${pick}`);
      sortNote = `sort remembered (${pick})`;
    }
    const az = await page.locator('[data-testid="az-index"]').count();
    const csv = await page.evaluate(async () => { const r = await fetch("/api/v1/me/stats/export.csv"); const t = await r.text(); return { status: r.status, ct: r.headers.get("content-type") || "", cd: r.headers.get("content-disposition") || "", head: t.split("\n")[0] }; });
    if (csv.status !== 200 || !/playedAt,title,artist,album,source/.test(csv.head)) throw new Error("csv: " + JSON.stringify(csv));
    const lib = await page.evaluate(async () => { const r = await fetch("/api/v1/stats/library"); return r.ok ? r.json() : { status: r.status }; });
    if (!(lib.tracks > 0 && lib.albums > 0)) throw new Error("stats/library: " + JSON.stringify(lib));
    await gotoQuiet(page, URL + "/about", { timeout: 45000 });
    const body = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    // c30c: "Signaler un problème" (mailto) only with YTM_REPORT_EMAIL, else "Copier le diagnostic".
    const reportWays = await page.locator('[data-testid="about-report"], [data-testid="about-copy-diag"]').count();
    if (!reportWays && !/Signaler|diagnostic/i.test(body)) throw new Error("about page without report action: " + body.slice(0, 80));
    const cl = await page.evaluate(async () => { const p = await fetch("/api/v1/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "harness", message: "ping" }) }); const g = await fetch("/api/v1/client-log?limit=5"); return { post: p.status, get: g.status }; });
    // c30c: GET is token-gated (401) or absent (404 without YTM_ADMIN_TOKEN); only the POST must be accepted.
    if (cl.post !== 200 && cl.post !== 202 && cl.post !== 204) throw new Error("client-log: " + JSON.stringify(cl));
    return `${sortNote}, az-index=${az}, csv ok (${csv.cd.slice(0, 40)}), library ${lib.tracks}/${lib.albums}/${lib.artists}, about ok, client-log post=${cl.post}`;
  });

  // Cycle 30 steps (brainstorm v4 / audit v8): enabled per lane once merged.
  const C30_STEPS_ENABLED = true;
  const C30_SKIP = new Set(); // c30a c30b c30c merged
  const c30step = (name, fn) => (C30_STEPS_ENABLED && !C30_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c30step("library_ia_nav_radio", async () => {
    // c30b: 9 nav chips in 3 groups, /favorites redirects, one Radio on a local album, Espace card, artist mix cards.
    await gotoQuiet(page, URL + "/library", { timeout: 45000 });
    const chips = await page.locator("nav.collnav a, [data-testid='collnav'] a").count();
    const groups = await page.locator("nav.collnav span[role='group'], [data-testid='collnav'] span[role='group']").count();
    if (chips < 7 || chips > 9) throw new Error(`nav chips=${chips} (expected 7..9), groups=${groups}`);
    await gotoQuiet(page, URL + "/favorites", { timeout: 45000 });
    await pollUntil(async () => (/\/library\/saved/.test(page.url()) ? true : null), 10000);
    const albumId = await fixtureAlbumId(page);
    await gotoQuiet(page, URL + "/release?id=" + encodeURIComponent(albumId), { timeout: 45000 });
    await page.locator('[data-testid="radio-seed"]').first().waitFor({ state: "visible", timeout: 15000 });
    const radios = await page.locator("button", { hasText: /radio/i }).count();
    if (radios !== 1) throw new Error(`radio buttons on a local album = ${radios}, expected 1`);
    await gotoQuiet(page, URL + "/library/downloads-offline", { timeout: 45000 });
    const stg = page.locator('[data-testid="space-toggle"]').first();
    await stg.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if ((await stg.count()) && (await stg.getAttribute("aria-expanded")) !== "true") { await stg.click({ timeout: 5000 }); await sleep(400); } // c37c: folded by default
    await page.locator('[data-testid="pack-size"]').first().waitFor({ state: "visible", timeout: 15000 });
    await requireMixCards();
    await gotoQuiet(page, URL + "/library/mixes", { timeout: 45000 });
    await page.locator('[data-testid="mix-card"]').first().waitFor({ state: "visible", timeout: 15000 });
    const keep = await page.locator('[data-testid="mix-keep"]').count();
    const artists = await page.locator('[data-testid="mix-card"][data-mix^="artist:"]').count();
    if (keep < 1) throw new Error("no Garder hors-ligne on mix cards");
    await gotoQuiet(page, URL + "/trending", { timeout: 45000 });
    const gp = page.locator('[data-testid="explore-genre-play"]').first();
    await gp.waitFor({ state: "visible", timeout: 15000 });
    await gp.click({ timeout: 5000 });
    const m = await pollUntil(async () => { const x = await media(page); return x && x.src ? x : null; }, 30000);
    if (!m) throw new Error("explore genre mix did not start");
    return `nav chips=${chips}/${groups} groups, /favorites -> saved, 1 radio on local album, Espace card on offline page, mix-keep=${keep}, artist cards=${artists}, explore mix played`;
  });

  await c30step("home_rows_arranged", async () => {
    // c30a: <= 4 personal rows above the first YouTube row, albums deduped across rows, honest Voir tout, first-run actions.
    await gotoQuiet(page, URL + "/home", { timeout: 45000 });
    await sleep(2500);
    const info = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-testid^='row-'], section[data-row]"));
      const ids = rows.map((r) => r.getAttribute("data-testid") || r.getAttribute("data-row"));
      // One set of albums per row container (a card links its album twice: cover + title); duplicates are
      // only albums present in two DIFFERENT rows.
      const perRow = rows.map((r) => new Set(Array.from(r.querySelectorAll("a[href*='/release?id=']")).map((a) => a.getAttribute("href"))));
      const seenIn = new Map();
      perRow.forEach((set, i) => set.forEach((h) => seenIn.set(h, (seenIn.get(h) || 0) + 1)));
      const nested = rows.filter((r) => rows.some((o) => o !== r && o.contains(r))).length;
      const dup = Array.from(seenIn.entries()).filter(([, n]) => n > 1 + nested).map(([h]) => h);
      return { rows: ids, dup: Array.from(new Set(dup)).slice(0, 5), more: !!document.querySelector("[data-testid='home-more-rows']") };
    });
    if (info.dup.length) throw new Error("album duplicated across home rows: " + JSON.stringify(info.dup));
    const nav = await page.evaluate(async () => { const r = await fetch("/api/v1/local/albums?filter=never-played&limit=5"); const d = await r.json().catch(() => null); const r2 = await fetch("/api/v1/local/albums?filter=added-30d&limit=5"); return { np: r.status, npN: d && d.items ? d.items.length : -1, added: r2.status }; });
    if (nav.np !== 200 || nav.added !== 200) throw new Error("album filters: " + JSON.stringify(nav)); // guest: 200 with reason=anonymous (c37c)
    await gotoQuiet(page, URL + "/library/albums?filter=never-played", { timeout: 45000 });
    // c37c (U12-12): a guest profile gets a "Dis-moi ton prénom" state instead of the filter chip.
    await page.locator('[data-testid="browse-filter-chip"], [data-testid="never-played-anonymous"]').first().waitFor({ state: "visible", timeout: 15000 });
    return `rows=${info.rows.length} (${info.rows.join(",")}), more toggle=${info.more}, no album duplicated, filters never-played(${nav.npN})/added-30d 200, filter chip shown`;
  });

  await c30step("hardening_csv_clientlog", async () => {
    // c30c: CSV BOM + formula neutralisation, client-log GET gated, tap targets >= 44 px on mobile.
    // HD4: exact header line after the BOM (formula neutralisation itself needs a play titled "=1+1",
    // which the harness cannot inject without a real acquisition: covered by me_export_test.go).
    const csv = await page.evaluate(async () => { const r = await fetch("/api/v1/me/stats/export.csv"); const b = new Uint8Array(await r.arrayBuffer()); const t = new TextDecoder("utf-8", { ignoreBOM: true }).decode(b); const nl = t.indexOf("\n"); return { status: r.status, bom: b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf, head: nl >= 0 ? t.slice(0, nl + 1) : t }; });
    if (csv.status !== 200 || !csv.bom) throw new Error("csv: " + JSON.stringify(csv));
    if (csv.head !== "﻿playedAt,title,artist,album,source\r\n") throw new Error("csv header line: " + JSON.stringify(csv.head));
    const get = await page.evaluate(async () => (await fetch("/api/v1/client-log?limit=5")).status);
    if (get !== 401 && get !== 404) throw new Error("client-log GET open: " + get);
    // HD4: the POST is rate limited per client IP (30 per minute, client_log.go): 31 quick POSTs see a 429.
    const burst = await page.evaluate(async () => { const out = []; for (let i = 0; i < 31; i++) { const r = await fetch("/api/v1/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "harness", message: "rate-limit probe " + i }) }); out.push(r.status); } return out; });
    const n429 = burst.filter((s) => s === 429).length;
    if (!n429) throw new Error("31 client-log POSTs, no 429: " + JSON.stringify(burst));
    const stats = await page.evaluate(async () => (await fetch("/api/v1/stats/library")).json());
    const mctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/library/genres", { waitUntil: "load", timeout: 45000 });
      await mp.locator('[data-testid="genre-play"]').first().waitFor({ state: "visible", timeout: 15000 });
      const small = await mp.evaluate(() => Array.from(document.querySelectorAll('[data-testid="genre-play"], [data-testid="genre-shuffle"]')).slice(0, 6).map((b) => { const r = b.getBoundingClientRect(); return [b.getAttribute("data-testid"), Math.round(r.height)]; }).filter((x) => x[1] < 44));
      if (small.length) throw new Error("tap targets under 44 px: " + JSON.stringify(small));
    } finally { await mctx.close(); }
    return `csv BOM ok, header exact, client-log GET=${get}, POST burst 429=${n429}/31, version=${stats.version}, genre buttons >= 44 px`;
  });

  // Cycle 31 steps: enabled per lane once merged.
  const C31_STEPS_ENABLED = true;
  const C31_SKIP = new Set(); // c31a c31b merged
  const c31step = (name, fn) => (C31_STEPS_ENABLED && !C31_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c31step("share_preview_and_owned", async () => {
    // c31b: OG cards for robots only, "Tu l'as déjà" banner, Partager button copies the canonical link.
    // Robot-vs-human responses need a custom User-Agent: Node-side requests (harness-lib rawRequest: the
    // page's request context ignores Chrome's --host-resolver-rules and would hit a broken hairpin).
    const rawGet = (p, ua) => rawRequest(URL, "GET", p, { "User-Agent": ua });
    // The OG card exists for any owned track: the YouTube fixture when present, else the local lid.
    const ogId = VID || LID;
    if (!ogId) skip("no owned track id (acquiredVideoId / localLid) for the /listen OG card");
    // Every robot UA of the fixture list gets the OG card (the first one is the historical WhatsApp probe).
    let rt = "";
    for (const ua of ROBOT_UAS) {
      const robotHtml = await rawGet("/listen?id=" + ogId, ua);
      if (robotHtml.status !== 200 || !/og:title/.test(robotHtml.body) || !/og:image/.test(robotHtml.body)) throw new Error(`robot UA without OG card: ${robotHtml.status} (${ua.slice(0, 24)})`);
      if (!rt) rt = robotHtml.body;
    }
    const ht = (await rawGet("/listen?id=" + ogId, HUMAN_UA)).body;
    const badStatus = (await rawGet("/api/v1/local/albums/match?artist=", "curl/8")).status;
    if (/og:title/.test(ht)) throw new Error("human UA received the OG page");
    if (badStatus !== 400) throw new Error("match without title: " + badStatus);
    // HD4 positive "Tu l'as déjà" case: albums/match with the fixture album's artist/title must answer
    // exactly that album (the banner on a YouTube release page uses this answer). Without the fixture,
    // the old newest-album lookup only checks that some lb- album comes back.
    const alb = FIX.localAlbumId && FIX.localAlbumTitle && FIX.localAlbumArtist
      ? { id: FIX.localAlbumId, title: FIX.localAlbumTitle, artist: FIX.localAlbumArtist, fixture: true }
      : await page.evaluate(async () => { const r = await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc"); const d = await r.json(); const a = d.items && d.items[0]; const nm = (x) => (typeof x === "string" ? x : Array.isArray(x) ? ((x.find((r) => r && /ARTIST/.test(String(r.pageType || ""))) || x.find((r) => r && r.text && r.text.trim() !== "•")) || {}).text || "" : (x && (x.name || x.text || x.title)) || ""); return a ? { id: a.browseId, title: a.title, artist: nm(a.artists && a.artists[0]) || nm(a.artist) || nm(a.subtitle) || "" } : null; });
    if (!alb) throw new Error("no local album");
    const match = await page.evaluate(async (a) => (await fetch("/api/v1/local/albums/match?artist=" + encodeURIComponent(a.artist) + "&title=" + encodeURIComponent(a.title))).json(), alb);
    const matched = alb.fixture ? !!(match && match.match && match.match.id === alb.id) : !!(match && match.match && /^lb-/.test(String(match.match.id)));
    if (!matched) throw new Error(`albums/match did not find the ${alb.fixture ? "fixture" : "newest"} local album: ` + JSON.stringify({ alb, match }).slice(0, 200));
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.goto(URL + "/release?id=" + encodeURIComponent(alb.id), { waitUntil: "load", timeout: 45000 });
    await page.evaluate(() => { try { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); } catch {} });
    const owned = await page.locator('[data-testid="already-owned"]').count();
    if (owned) throw new Error("already-owned banner shown on a LOCAL album");
    const share = page.locator('[data-testid="share-link"]').first();
    await share.waitFor({ state: "visible", timeout: 15000 });
    await share.click({ timeout: 5000 });
    await page.getByText(/Lien copi/i).first().waitFor({ state: "visible", timeout: 8000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
    if (clip && !/\/release\?id=/.test(clip)) throw new Error("clipboard: " + clip.slice(0, 60));
    return `OG robot ok (${rt.length} B, ${ROBOT_UAS.length} UAs), human shell ok, match(${alb.artist} / ${alb.title})=${matched}${alb.fixture ? " id=" + alb.id : ""}, share copied=${clip ? "yes" : "unreadable"}`;
  });

  await c31step("french_program_screens", async () => {
    // c31a: no English leftovers on the program screens (sizes in Mo/Go, sort labels, offline page, about).
    const deny = /\b(Loading|Results|Refresh|Download to|Remove|Cached audio|Clear cache|Play all|Shuffle|Filter|No results|Sort by)\b|\b\d+(\.\d+)? ?(MB|GB)\b/;
    const hits = [];
    for (const path of ["/library/downloads-offline", "/library/albums", "/library/mixes", "/library/for-you", "/about", "/library/stats"]) {
      await page.goto(URL + path, { waitUntil: "load", timeout: 45000 });
      await sleep(1200);
      const txt = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      const m = txt.match(deny);
      if (m) hits.push(path + ": " + m[0]);
    }
    if (hits.length) throw new Error("English leftovers: " + hits.join("; "));
    return "6 program screens without English leftovers";
  });

  // Cycle 32 steps (UX audit v11): enabled per lane once merged.
  const C32_STEPS_ENABLED = true;
  const C32_SKIP = new Set(); // c32a c32b merged
  const c32step = (name, fn) => (C32_STEPS_ENABLED && !C32_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c32step("player_polish_mobile", async () => {
    // c32b: mini-bar progress line, inert queue drawer when closed, 44 px+ queue handle, install hint as a bar.
    const mctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mp = await mctx.newPage();
      await mp.addInitScript(() => { window.__ytmMedia = { plays: 0 }; const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia.plays++; window.__ytmMedia.el = this; window.__ytmMedia.src = this.currentSrc || this.src; return o.apply(this, arguments); }; });
      await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
      await mp.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 15000 });
      await pollUntil(async () => { const m = await mp.evaluate(() => window.__ytmMedia); return m && m.src ? m : null; }, 30000);
      await sleep(1500);
      const prog = mp.locator('[data-testid="mini-progress"]');
      await prog.first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
      if (await prog.count() === 0) throw new Error("no mini-progress on the mobile mini-bar (queue rows=" + (await mp.locator('[data-testid="queue-row"]').count()) + ")");
      // HD4: why the old detail read "drawer inert closed=1 open=1" on mobile. Tapping the mini-bar
      // cover opens the fullscreen PLAYER, not the queue: on phones the queue is a bottom sheet
      // (Fullscreen.svelte, .tracklist) that stays closed until its handle (.sheet-head
      // .handle[role=button], "Afficher la file d'attente") is tapped. While that sheet is closed its
      // body ([data-testid=queue-drawer-body]) must be inert (queueDrawerInert: sheetOpen=false), so
      // "open=1" measured the open PLAYER with the sheet still closed: expected, not a bug. The real
      // contract is asserted below: inert "1" before the handle tap, "0" after it, handle >= 44 px.
      const body = mp.locator('[data-testid="queue-drawer-body"]').first();
      await mp.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 });
      await sleep(1500);
      await body.waitFor({ state: "attached", timeout: 10000 });
      const inertClosed = await body.getAttribute("data-inert").catch(() => null);
      const handle = mp.locator(".sheet-head .handle[role='button'], .sheet-head [role='button'], .sheet-head").first();
      await handle.waitFor({ state: "visible", timeout: 10000 });
      const hb = await handle.boundingBox();
      // A tap with no movement (< 10 px) toggles the sheet (release() in Fullscreen.svelte); Enter on
      // the focused handle is the keyboard path, used only if the tap did not open it.
      await handle.tap({ timeout: 5000 }).catch(() => handle.click({ timeout: 5000 }));
      let how = "tap";
      let inertOpen = await pollUntil(async () => { const v = await body.getAttribute("data-inert").catch(() => null); return v === "0" ? v : null; }, 3000, 300);
      if (inertOpen !== "0") { how = "Enter (tap did not open)"; await handle.focus().catch(() => {}); await mp.keyboard.press("Enter"); inertOpen = await pollUntil(async () => { const v = await body.getAttribute("data-inert").catch(() => null); return v === "0" ? v : null; }, 3000, 300); }
      if (inertOpen !== "0") inertOpen = await body.getAttribute("data-inert").catch(() => null);
      const count = await mp.locator('[data-testid="queue-count"]').count();
      const detail = `mini-progress ok, drawer inert closed=${inertClosed} open=${inertOpen} (${how}), handle h=${hb ? Math.round(hb.height) : "n/a"}, queue-count nodes=${count}`;
      if (inertClosed !== "1") throw new Error("queue drawer body not inert while the sheet is closed: " + detail);
      if (inertOpen !== "0") throw new Error("queue drawer body still inert after opening the sheet: " + detail);
      if (!hb || hb.height < 44) throw new Error("queue handle under 44 px: " + detail);
      return detail;
    } finally { await mctx.close(); }
  });

  await c32step("ux_polish_links_targets", async () => {
    // c32a: link-buttons centred (Explorer), error page buttons in the system, secondary text >= 12 px, tap targets.
    const mctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/definitely-missing-page-xyz", { waitUntil: "load", timeout: 45000 });
      const back = mp.locator("a.btn-primary, a.btn-secondary, button.btn-primary, button.btn-secondary").first();
      await back.waitFor({ state: "visible", timeout: 10000 });
      const bb = await back.boundingBox();
      if (!bb || bb.height < 43) throw new Error("error page button height " + (bb && bb.height));
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await sleep(2000);
      const links = await mp.evaluate(() => Array.from(document.querySelectorAll("a.btn-primary, a.btn-secondary, a.btn-ghost")).slice(0, 8).map((a) => { const cs = getComputedStyle(a); const r = a.getBoundingClientRect(); return { t: (a.textContent || "").trim().slice(0, 14), d: cs.display, h: Math.round(r.height) }; }));
      const inline = links.filter((l) => l.d === "inline");
      if (inline.length) throw new Error("link-buttons still display:inline: " + JSON.stringify(inline));
      const small = await mp.evaluate(() => { const out = []; for (const el of Array.from(document.querySelectorAll("main .subtitle, main .secondary, main [class*='subtitle'], main [class*='meta']")).slice(0, 40)) { const fs = parseFloat(getComputedStyle(el).fontSize); if (fs && fs < 12 && (el.textContent || "").trim()) out.push([(el.className || "").toString().slice(0, 30), fs]); } return out.slice(0, 5); });
      if (small.length) throw new Error("secondary text under 12 px: " + JSON.stringify(small));
      // Hit box = the element or its enlarged child (c32a uses a 44 px box with negative block margins on <small>).
      const seeAll = await mp.evaluate(() => Array.from(document.querySelectorAll("a, button")).filter((e) => /voir tout|see all/i.test(e.textContent || "")).slice(0, 6).map((e) => Math.round(Math.max(e.getBoundingClientRect().height, ...Array.from(e.children).map((c) => c.getBoundingClientRect().height)))));
      const tiny = seeAll.filter((h) => h > 0 && h < 44);
      if (tiny.length) throw new Error("Voir tout targets under 44 px: " + JSON.stringify(seeAll));
      return `error button ${Math.round(bb.height)} px, link-buttons=${links.length} none inline, secondary text >= 12 px, voir-tout heights=${JSON.stringify(seeAll)}`;
    } finally { await mctx.close(); }
  });

  // Cycle 33 steps (audit logic v9 + perf v3): enabled per lane once merged.
  const C33_STEPS_ENABLED = true;
  const C33_SKIP = new Set(); // c33a c33b merged (b8e98f4)
  const c33step = (name, fn) => (C33_STEPS_ENABLED && !C33_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c33step("hardening_v9", async () => {
    // c33a: never-played paging contract, OG fallback never cached + headers on HIT, mix cards unavailable state.
    const np = await page.evaluate(async () => { const a = await fetch("/api/v1/local/albums?filter=never-played&limit=20"); const d = await a.json().catch(() => ({})); const b = await fetch("/api/v1/local/albums?filter=never-played&limit=20&offset=2001"); return { status: a.status, nextOffset: d.nextOffset, items: (d.items || []).length, far: b.status }; });
    if (np.status !== 200 || typeof np.nextOffset !== "number" || np.far !== 400) throw new Error("never-played contract: " + JSON.stringify(np));
    const rawHead = async (p, ua) => { const r = await rawRequest(URL, "GET", p, { "User-Agent": ua }); return { status: r.status, cache: r.headers["x-ytm-cache"] || "", cc: r.headers["cache-control"] || "", vary: r.headers["vary"] || "" }; };
    const uaA = ROBOT_UAS[0], uaB = ROBOT_UAS.find((u) => /twitterbot/i.test(u)) || "Twitterbot/1.0";
    const f1 = await rawHead("/listen?id=zzzzzzzzzzz", uaA);
    const f2 = await rawHead("/listen?id=zzzzzzzzzzz", uaA);
    if (/HIT/.test(f2.cache) || !/no-cache/.test(f1.cc)) throw new Error("OG fallback cached: " + JSON.stringify([f1, f2]));
    const ogId = VID || LID;
    if (!ogId) skip("no owned track id (acquiredVideoId / localLid) for the OG HIT headers");
    const h1 = await rawHead("/listen?id=" + ogId, uaB);
    const h2 = await rawHead("/listen?id=" + ogId, uaB);
    if (!/max-age=600/.test(h2.cc) || !/User-Agent/i.test(h2.vary)) throw new Error("OG HIT headers: " + JSON.stringify([h1, h2]));
    await requireMixCards();
    await gotoQuiet(page, URL + "/library/mixes", { timeout: 45000 });
    await page.locator('[data-testid="mix-card"]').first().waitFor({ state: "visible", timeout: 15000 });
    const unavailable = await page.locator('[data-testid="mix-card"][data-unavailable]').count();
    return `never-played nextOffset=${np.nextOffset} (${np.items} items, offset 2001 -> 400), OG fallback ${f1.cache}/${f2.cache} ${f1.cc}, OG HIT ${h2.cache} ${h2.cc}, mix cards unavailable=${unavailable}`;
  });

  // c52c (B8-15 / B9-21): perf_v3 (c33b) merged into perf_cold_home_requests (c25), every assertion kept.

  // Cycle 35 steps (brainstorm v5 UX1-UX10): enabled once the c35 lanes are in the build.
  const C35_STEPS_ENABLED = true;
  const C35_SKIP = new Set(); // c35a c35b c35c merged
  const c35step = (name, fn) => (C35_STEPS_ENABLED && !C35_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c35step("library_pages_polish", async () => {
    // c35a: 16 px gutter on Mixes/Genres/Rediscover/Pour toi, no horizontal scroll, keep icon per card, Pour toi play-all.
    const mctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mp = await mctx.newPage();
      const out = [];
      for (const path of ["/library/mixes", "/library/genres", "/library/rediscover", "/library/for-you"]) {
        await mp.goto(URL + path, { waitUntil: "load", timeout: 45000 });
        await sleep(1500);
        const m = await mp.evaluate(() => { const h = document.querySelector("main h1, main h2, main .h1"); const r = h && h.getBoundingClientRect(); return { x: r ? Math.round(r.x) : -1, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; });
        if (m.overflow) throw new Error(path + " scrolls horizontally");
        if (m.x >= 0 && m.x < 12) throw new Error(path + " title at x=" + m.x + " (no gutter)");
        out.push(path.replace("/library/", "") + ":" + m.x);
      }
      await requireMixCards();
      await mp.goto(URL + "/library/mixes", { waitUntil: "load", timeout: 45000 });
      await mp.locator('[data-testid="mix-card"]').first().waitFor({ state: "visible", timeout: 15000 });
      const cards = await mp.locator('[data-testid="mix-card"]').count(); const keeps = await mp.locator('[data-testid="mix-keep"]').count();
      if (cards && keeps !== cards) throw new Error(`mix-keep ${keeps} != mix-card ${cards}`);
      await mp.goto(URL + "/library/for-you", { waitUntil: "load", timeout: 45000 });
      await mp.locator('[data-testid="play-all-bar"], [data-testid="play-all"]').first().waitFor({ state: "visible", timeout: 20000 });
      return `gutters ${out.join(" ")}, mixes ${cards} cards / ${keeps} keep icons, Pour toi play-all bar`;
    } finally { await mctx.close(); }
  });

  await c35step("share_target_smart", async () => {
    // c35c: start time, playlist in url, shared titles to search, unrecognized kept.
    // c52c (B8-15 / B9-21): share_target (HL5, c29) merged here, assertions kept: manifest share_target action,
    // GET /share-target 200, a shared text with a youtu.be link lands on /listen without auto-play, the
    // unrecognized state offers a way home. Detail "share_target part ; share_target_smart part".
    // Share routing is client-side: any well-formed YouTube id proves it (the fixture one when present).
    const vid = VID || "dQw4w9WgXcQ";
    const mf = await page.evaluate(async () => (await fetch("/manifest.json", { cache: "no-store" })).json());
    if (!mf.share_target || mf.share_target.action !== "/share-target") throw new Error("manifest share_target missing: " + JSON.stringify(mf.share_target || null));
    const st = await page.evaluate(async () => (await fetch("/share-target", { cache: "no-store" })).status);
    if (st !== 200) throw new Error("GET /share-target status " + st);
    await gotoQuiet(page, URL + "/share-target?text=" + encodeURIComponent("Regarde https://youtu.be/" + vid + " ok"), { timeout: 45000 });
    await pollUntil(async () => (page.url().includes("/listen?id=" + vid) ? true : null), 15000);
    const m1 = await media(page);
    if (m1 && m1.src && m1.played) throw new Error("auto-played from a shared link");
    const e = page.url().replace(URL, "");
    const go = async (qs) => { await gotoQuiet(page, URL + "/share-target?" + qs, { timeout: 45000 }); await pollUntil(async () => (!/\/share-target/.test(page.url()) || (await page.locator('[data-testid="share-unrecognized"]').count()) ? true : null), 15000).catch(() => {}); return page.url().replace(URL, ""); };
    const a = await go("url=" + encodeURIComponent("https://youtu.be/" + vid + "?t=30"));
    if (!new RegExp("/listen\\?id=" + vid + ".*t=30").test(a)) throw new Error("start time lost: " + a);
    const b = await go("url=" + encodeURIComponent("https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"));
    if (!/\/playlist\/PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG/.test(b)) throw new Error("playlist not routed: " + b);
    const c = await go("text=" + encodeURIComponent("https://open.spotify.com/track/abc") + "&title=" + encodeURIComponent("Daft Punk - Da Funk"));
    if (!/\/search\//.test(c)) throw new Error("shared title not searched: " + c);
    const d = await go("text=hello");
    if (!/\/share-target/.test(d) || !(await page.locator('[data-testid="share-unrecognized"]').count())) throw new Error("unrecognized state lost: " + d);
    const home = await page.locator('[data-testid="share-home"]').first().getAttribute("href");
    if (!home || !/\/home/.test(home)) throw new Error("no way home: " + home);
    return `manifest action ok, GET 200, text link -> ${e} (no auto-play) ; t=30 ok, playlist ok, title -> ${c.slice(0, 40)}, unrecognized ok (home ${home})`;
  });

  await c35step("offline_space_fold", async () => {
    // c35c: Espace card folds and remembers; c35b: install hint never over the title; /about server version.
    await gotoQuiet(page, URL + "/library/downloads-offline", { timeout: 45000 });
    const tg = page.locator('[data-testid="space-toggle"]').first();
    await tg.waitFor({ state: "visible", timeout: 15000 });
    // c37c (U12-9): folded by default (Tout lire above the fold); the user's choice is remembered both ways.
    const openBefore = await tg.getAttribute("aria-expanded");
    if (openBefore === "true") { await tg.click({ timeout: 5000 }); await sleep(400); }
    if ((await page.locator('[data-testid="free-up"]').count()) !== 0) throw new Error("free-up still rendered when folded");
    await tg.click({ timeout: 5000 }); await sleep(500);
    await page.locator('[data-testid="free-up"]').first().waitFor({ state: "visible", timeout: 10000 });
    await page.reload({ waitUntil: "load" }); await sleep(1200);
    const after = await page.locator('[data-testid="space-toggle"]').first().getAttribute("aria-expanded");
    if (after !== "true") throw new Error("open state not remembered after reload: " + after);
    const failed = await page.locator('[data-testid="failed-downloads"]').count();
    await gotoQuiet(page, URL + "/about", { timeout: 45000 });
    const sv = (await page.locator('[data-testid="about-server-version"]').first().innerText().catch(() => "")).trim();
    if (!/^[0-9a-f]{7,}/.test(sv) && !/dev/.test(sv)) throw new Error("about server version: " + sv);
    return `Espace open->folded->remembered->reopened, failed-downloads lines=${failed}, about version=${sv.slice(0, 12)}`;
  });

  // Cycle 37 steps (audit logic v10 / perf v4 / UX v12): enabled per lane once merged.
  const C37_STEPS_ENABLED = true;
  const C37_SKIP = new Set(); // c37a c37b c37c merged (250eb31)
  const c37step = (name, fn) => (C37_STEPS_ENABLED && !C37_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c37step("logic_v10", async () => {
    // c37a: missing _app asset is a 404 no-store; home.json failure shows a retry; t= seeks on /listen.
    const raw = async (p) => { const r = await rawRequest(URL, "GET", p); return { status: r.status, cc: r.headers["cache-control"] || "", ct: r.headers["content-type"] || "", bytes: Buffer.byteLength(r.body) }; };
    const miss = await raw("/_app/immutable/chunks/doesnotexist-abc123.js");
    if (miss.status !== 404 || !/no-store/.test(miss.cc) || /text\/html/.test(miss.ct)) throw new Error("missing _app asset: " + JSON.stringify(miss));
    // serviceWorkers: "block": page.route() cannot intercept requests the SW answers; this context has no SW.
    const fctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    try {
      const fp = await fctx.newPage();
      await fp.addInitScript(() => { window.__ytmMedia = { plays: 0 }; const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia.plays++; window.__ytmMedia.el = this; window.__ytmMedia.src = this.currentSrc || this.src; return o.apply(this, arguments); }; });
      await fp.route("**/api/v1/home.json*", (r) => r.fulfill({ status: 500, body: "boom" }));
      await fp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await fp.locator('[data-testid="retry-home"]').first().waitFor({ state: "visible", timeout: 15000 }).catch((e) => { throw new Error("retry-home not shown after home.json 500: " + String(e.message).slice(0, 60)); });
      const rows = await fp.locator("[data-row]").count();
      await fp.unroute("**/api/v1/home.json*");
      await fp.locator('[data-testid="retry-home"]').first().click({ timeout: 5000 });
      await fp.locator('[data-testid="home-error"]').first().waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
      // /listen?t=30 needs an owned track longer than 30 s: the YouTube fixture, else the local lid (the
      // seek is asserted only when the track is long enough; a short local track reports the duration).
      const vid = VID || LID;
      if (!vid) skip("no owned track id (acquiredVideoId / localLid) for /listen?t=30");
      await fp.goto(URL + "/listen?id=" + vid + "&t=30", { waitUntil: "load", timeout: 45000 });
      const startBtn = fp.locator('[data-start-at], button:has-text("Start Listening"), button:has-text("Écouter")').first();
      await startBtn.waitFor({ state: "visible", timeout: 15000 }).catch((e) => { throw new Error("listen start button not found on /listen?t=30: " + String(e.message).slice(0, 60)); });
      const startAt = await startBtn.getAttribute("data-start-at");
      await startBtn.click({ timeout: 5000 });
      // The player's media element is an Audio() object outside the DOM: read it through the play() hook.
      const ct = await pollUntil(async () => { const t = await fp.evaluate(() => { const m = window.__ytmMedia; const a = (m && m.el) || document.querySelector("audio, video"); return a ? a.currentTime : -1; }); return t >= 28 ? t : null; }, 30000);
      if (!ct) {
        const dur = await fp.evaluate(() => { const m = window.__ytmMedia; const a = (m && m.el) || document.querySelector("audio, video"); return a && Number.isFinite(a.duration) ? a.duration : null; }).catch(() => null);
        if (dur !== null && dur < 31) return `missing _app -> ${miss.status} ${miss.cc}; home.json 500 -> retry shown (personal rows=${rows}); /listen t=30 not asserted: track ${vid} lasts ${Math.round(dur)} s (shorter than 30 s)`;
        throw new Error("listen t=30 did not seek (data-start-at=" + startAt + ")");
      }
      return `missing _app -> ${miss.status} ${miss.cc}; home.json 500 -> retry shown (personal rows=${rows}); /listen t=30 -> currentTime ${Math.round(ct)} s`;
    } finally { await fctx.close(); }
  });

  // c52c (B8-15 / B9-21): perf_v4 (c37b) merged into perf_cold_home_requests (c25), every assertion kept.

  await c37step("ux_v12_playlists", async () => {
    // c37c: Mes playlists page on phones (gutter, primary button contrast, 44 px rows), Mixes cards without default border, genres clean.
    const mctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/library/playlists-srv", { waitUntil: "load", timeout: 45000 }); await sleep(1500);
      const m = await mp.evaluate(() => { const h = document.querySelector("main h1, main h2"); const r = h && h.getBoundingClientRect(); const b = Array.from(document.querySelectorAll("main button, main a.btn-primary, main a.btn-secondary")).find((x) => /nouvelle playlist/i.test(x.textContent || "")); const br = b && b.getBoundingClientRect(); const cs = b && getComputedStyle(b); return { x: r ? Math.round(r.x) : -1, btn: b ? { h: Math.round(br.height), cls: b.className.slice(0, 40), bg: cs.backgroundColor } : null, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; });
      if (m.overflow || (m.x >= 0 && m.x < 12)) throw new Error("playlists page gutter: " + JSON.stringify(m));
      if (!m.btn || m.btn.h < 43 || !/btn-primary/.test(m.btn.cls)) throw new Error("Nouvelle playlist button: " + JSON.stringify(m.btn));
      await requireMixCards();
      await mp.goto(URL + "/library/mixes", { waitUntil: "load", timeout: 45000 });
      await mp.locator('[data-testid="mix-card"]').first().waitFor({ state: "visible", timeout: 15000 });
      const border = await mp.evaluate(() => { const c = document.querySelector('[data-testid="mix-card"]'); const cs = getComputedStyle(c); return [cs.borderTopStyle, cs.borderTopWidth]; });
      if (border[0] !== "none" && parseFloat(border[1]) > 0 && /outset|inset/.test(border[0])) throw new Error("mix card default border: " + JSON.stringify(border));
      const genres = await mp.evaluate(async () => { const d = await (await fetch("/api/v1/local/genres")).json(); const names = (d.genres || d.items || []).map((g) => g.name || g); return { n: names.length, junk: names.filter((x) => /;|^_|^.$/.test(String(x))).slice(0, 3) }; });
      if (genres.junk.length) throw new Error("genre junk values: " + JSON.stringify(genres.junk));
      return `playlists gutter x=${m.x}, button ${m.btn.h}px ${m.btn.cls.split(" ")[0]}, mix card border ${border.join(" ")}, genres ${genres.n} clean`;
    } finally { await mctx.close(); }
  });

  // Cycle 39 steps (brainstorm v6): enabled per lane once merged.
  const C39_STEPS_ENABLED = true;
  const C39_SKIP = new Set(); // c39a c39b c39c merged (6e3a33c)
  // identity_migration needs the harness plays to count (YTM_STATS_INCLUDE_HARNESS=1 on the target).
  if (!STATS_INCLUDE) { C39_SKIP.add("identity_migration"); envSkipped.push("identity_migration"); }
  const c39step = (name, fn) => (C39_STEPS_ENABLED && !C39_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c39step("identity_migration", async () => {
    // c39a: an anonymous device's plays move to the named profile on login; prompt and banner for anonymous profiles.
    const ictx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const ip = await ictx.newPage();
      await ip.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const api = async (method, path, body) => ip.evaluate(async ({ method, path, body }) => { const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; }, { method, path, body });
      await api("GET", "/api/v1/me/whoami");
      for (let i = 0; i < 11; i++) await api("POST", "/api/v1/me/history", { videoId: "harnessId" + String(i).padStart(3, "0"), title: "Harness T" + i });
      await api("POST", "/api/v1/me/favorites", { videoId: "harnessIdFav", title: "Harness Fav" });
      await ip.goto(URL + "/library/stats", { waitUntil: "load", timeout: 45000 });
      const banner = await ip.locator('[data-testid="device-only-banner"]').count();
      await ip.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await sleep(1500);
      const prompt = await ip.locator('[data-testid="identity-prompt"]').count();
      const name = "harness-id-" + Date.now();
      const login = await api("POST", "/api/v1/me/login", { name });
      await ip.evaluate(() => { try { sessionStorage.removeItem("ytm-whoami"); } catch {} }); // the page memoises whoami 5 min
      if (login.status !== 200 || !login.json || !login.json.migrated) throw new Error("login did not migrate: " + JSON.stringify(login).slice(0, 160));
      const m = login.json.migrated;
      if (m.plays < 11 || m.favorites < 1) throw new Error("migrated counts: " + JSON.stringify(m));
      const again = await api("POST", "/api/v1/me/login", { name });
      if (again.json && again.json.migrated !== null) throw new Error("second login migrated again: " + JSON.stringify(again.json.migrated));
      const recent = await api("GET", "/api/v1/me/stats/recent?limit=20");
      const n = recent.json && recent.json.items ? recent.json.items.length : -1;
      if (n < 11) throw new Error("history not on the named profile: " + n);
      await ip.goto(URL + "/library/stats", { waitUntil: "load", timeout: 45000 });
      const bannerAfter = await ip.locator('[data-testid="device-only-banner"]').count();
      if (bannerAfter) throw new Error("device-only banner still shown for a named profile");
      return `anonymous: banner=${banner}, prompt=${prompt}; login moved plays=${m.plays} favorites=${m.favorites} playlists=${m.playlists}; idempotent; recent=${n}; banner gone`;
    } finally { await ictx.close(); }
  });

  await c39step("discovery_v6", async () => {
    // c39b: album of the day (same album twice in a row), crossover + year mixes.
    const a = await page.evaluate(async () => (await fetch("/api/v1/local/album-of-day", { cache: "no-store" })).json());
    const b = await page.evaluate(async () => (await fetch("/api/v1/local/album-of-day", { cache: "no-store" })).json());
    if (!a.album || !b.album || a.album.browseId !== b.album.browseId) throw new Error("album of the day unstable: " + JSON.stringify([a.album && a.album.browseId, b.album && b.album.browseId]));
    const mixes = await page.evaluate(async () => (await fetch("/api/v1/local/mixes")).json());
    const cross = (mixes.crossovers || []).length, years = (mixes.years || []).length;
    await gotoQuiet(page, URL + "/home", { timeout: 45000 });
    await page.locator('[data-testid="album-of-day"]').first().waitFor({ state: "visible", timeout: 15000 });
    await requireMixCards();
    await gotoQuiet(page, URL + "/library/mixes", { timeout: 45000 });
    await page.locator('[data-testid="mix-card"]').first().waitFor({ state: "visible", timeout: 15000 });
    const yearCards = await page.locator('[data-testid="mix-card"][data-mix^="year:"]').count();
    if (years && !yearCards) throw new Error("year cards missing on the Mixes page");
    return `album of the day ${a.album.browseId} (${(a.album.title || "").slice(0, 24)}), crossovers=${cross}, years=${years} (${yearCards} cards)`;
  });

  await c39step("night_lockscreen", async () => {
    // c39c: MediaSession seekto 0 honoured, previous restarts after 3 s, artwork sizes.
    await gotoQuiet(page, URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
    await pollUntil(async () => { const m = await media(page); return m && m.src ? m : null; }, 30000);
    await sleep(5000);
    const r = await page.evaluate(() => { const m = window.__ytmMedia; const el = (m && m.el) || (m && typeof m.currentTime === "number" ? m : null); const ms = navigator.mediaSession; const art = (ms && ms.metadata && ms.metadata.artwork) || []; const sizes = art.map((x) => x.sizes); return { t: el ? Math.round(el.currentTime) : -1, sizes, hasSeekTo: typeof ms.setActionHandler === "function" }; });
    const t1 = r.t;
    const pick = "(window.__ytmMedia && window.__ytmMedia.el) || (window.__ytmMedia && typeof window.__ytmMedia.currentTime === 'number' ? window.__ytmMedia : null)";
    await page.evaluate((p) => { const el = eval(p); if (el) el.currentTime = 0; }, pick);
    await sleep(800);
    const t2 = await page.evaluate((p) => { const el = eval(p); return el ? Math.round(el.currentTime) : -1; }, pick);
    if (!(t2 < t1) || t2 > 2) throw new Error(`seek to 0 not honoured: ${t1} -> ${t2}`);
    if (!r.sizes.some((sz) => /512x512|384x384/.test(String(sz)))) throw new Error("lock-screen artwork sizes: " + JSON.stringify(r.sizes));
    return `seek 0 ok (${t1} -> ${t2}), artwork sizes ${r.sizes.join(",")}`;
  });

  // Cycle 40 steps (brainstorm v6): resume_take_over and smart_queue_skips need counted harness plays.
  const C40_STEPS_ENABLED = true;
  const C40_SKIP = new Set(); // c40a c40b c40c merged
  if (!STATS_INCLUDE) for (const n of ["resume_take_over", "smart_queue_skips"]) { C40_SKIP.add(n); envSkipped.push(n); }
  const c40step = (name, fn) => (C40_STEPS_ENABLED && !C40_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c40step("resume_take_over", async () => {
    // c40a: device B offers "Reprendre depuis A", "Continuer ici" takes the playback, A pauses within 20 s.
    const hook = () => { window.__ytmMedia = { plays: 0 }; const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia.plays++; window.__ytmMedia.el = this; window.__ytmMedia.src = this.currentSrc || this.src; return o.apply(this, arguments); }; };
    const name = "harness-take-" + Date.now();
    const ctxA = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const ctxB = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const A = await ctxA.newPage(); await A.addInitScript(hook);
      const B = await ctxB.newPage(); await B.addInitScript(hook);
      await A.goto(URL + "/home", { waitUntil: "load", timeout: 45000 }); await loginAs(A, name);
      await B.goto(URL + "/home", { waitUntil: "load", timeout: 45000 }); await loginAs(B, name);
      await A.goto(URL + "/library/albums?sort=trackCount:desc", { waitUntil: "load", timeout: 45000 });
      await A.locator('[data-testid="play-all"], [data-testid="genre-play"], .play-all').first().click({ timeout: 10000 }).catch(async () => { await A.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=library", { waitUntil: "load", timeout: 45000 }); await A.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 10000 }); });
      await pollUntil(async () => { const m = await A.evaluate(() => window.__ytmMedia); return m && m.src ? m : null; }, 30000);
      await sleep(20000); // A must play > 12 s and push at least once (15 s cadence)
      await B.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const card = B.locator('[data-testid="resume-remote"]').first();
      await card.waitFor({ state: "visible", timeout: 25000 }).catch(async () => { await B.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); }); await card.waitFor({ state: "visible", timeout: 25000 }); });
      await B.locator('[data-testid="resume-remote-take"]').first().click({ timeout: 8000 });
      const mb = await pollUntil(async () => { const m = await B.evaluate(() => window.__ytmMedia); return m && m.src ? m : null; }, 30000);
      if (!mb) throw new Error("B did not start playing after Continuer ici");
      const np = await B.evaluate(async () => (await fetch("/api/v1/me/nowplaying", { cache: "no-store" })).json());
      if (!np || !np.takenBy) throw new Error("nowplaying not marked taken: " + JSON.stringify(np).slice(0, 120));
      const pausedA = await pollUntil(async () => { const p = await A.evaluate(() => { const el = window.__ytmMedia && window.__ytmMedia.el; return el ? el.paused : null; }); return p === true ? true : null; }, 40000);
      if (!pausedA) throw new Error("device A did not pause after the take-over");
      return `A played, B offered + took over (takenBy=${String(np.takenBy).slice(0, 12)}), A paused`;
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  await c40step("smart_queue_skips", async () => {
    // c40b: skips are recorded; a twice-skipped ref leaves me/mix; related excludes recent plays.
    const r = await page.evaluate(async () => { const a = await fetch("/api/v1/me/skips?days=30"); return { status: a.status, body: await a.text().then((t) => t.slice(0, 120)) }; });
    if (r.status !== 200) throw new Error("me/skips: " + JSON.stringify(r));
    const post = await page.evaluate(async () => (await fetch("/api/v1/me/skips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId: "harnessSkipA00", position: 5, duration: 200, source: "harness" }) })).status);
    if (post >= 400) throw new Error("POST me/skips " + post);
    return `skips endpoint ok (GET 200, POST ${post})`;
  });

  await c40step("trip_pack_duration", async () => {
    // c40c: pack selector offers durations; weekend card logic exists; guest never-played back link; genre rules.
    await gotoQuiet(page, URL + "/library/downloads-offline", { timeout: 45000 });
    const tg = page.locator('[data-testid="space-toggle"]').first();
    await tg.waitFor({ state: "visible", timeout: 15000 });
    if ((await tg.getAttribute("aria-expanded")) !== "true") { await tg.click({ timeout: 5000 }); await sleep(400); }
    const opts = await page.locator('[data-testid="pack-size"] option').evaluateAll((os) => os.map((o) => o.value));
    if (!opts.some((v) => /^dur:/.test(v))) throw new Error("no duration options in pack-size: " + JSON.stringify(opts));
    const g = await page.evaluate(async () => { const d = await (await fetch("/api/v1/local/genres")).json(); const names = (d.genres || d.items || []).map((x) => x.name || x); return { n: names.length, bo: names.filter((x) => /bande originale/i.test(String(x))).length, slash: names.filter((x) => /\//.test(String(x))).slice(0, 3) }; });
    return `pack durations ${opts.filter((v) => /^dur:/.test(v)).join(",")}, genres ${g.n} (Bande originale groups=${g.bo}, kept slashes=${JSON.stringify(g.slash)})`;
  });

  // Cycle 41 steps: enabled when chain 44 (cycle 41) runs.
  const C41_STEPS_ENABLED = true;
  const C41_SKIP = new Set(); // c41a c41b merged
  const c41step = (name, fn) => (C41_STEPS_ENABLED && !C41_SKIP.has(name) ? step(page, name, fn) : Promise.resolve());

  await c41step("stats_time_views", async () => {
    // c41a: streaks / clock / decades / year endpoints answer for the current profile; the stats page renders the blocks.
    // c47a: this step relied on recent_by_day (now tier full) having logged the main page in as harness-days with a
    // counted play: an anonymous profile without one has no [stats-streak] (chain 55 run 1, and every prod run,
    // where harness plays are ignored: chain 54 prod FAIL). The step now sets its own state: the same fixed
    // profile (idempotent after recent_by_day in tier full) and one seeded play (stored on staging; ignored on
    // prod by the harness rule, where the empty state is asserted instead, like share_year).
    const st = await loginAs(page, "harness-days");
    if (st !== 200) throw new Error("login harness-days: " + st);
    const seed = await page.evaluate(async (b) => { const x = await fetch("/api/v1/me/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); let j = null; try { j = await x.json(); } catch {} return { status: x.status, ignored: !!(j && j.ignored) }; }, { videoId: FIX.localLid || "harness-lid", title: FIX.localLidTitle || "Harness seed", length: "3:00" });
    if (seed.status !== 200) throw new Error("seed play " + seed.status);
    const r = await page.evaluate(async () => { const g = async (u) => { const x = await fetch(u, { cache: "no-store" }); let j = null; try { j = await x.json(); } catch {} return { s: x.status, j }; }; return { streaks: await g("/api/v1/me/stats/streaks?tz=120"), clock: await g("/api/v1/me/stats/clock?tz=120&days=90"), decades: await g("/api/v1/me/stats/decades?days=365"), year: await g("/api/v1/me/stats/year?year=2026&tz=120"), bad: (await fetch("/api/v1/me/stats/year?year=abc")).status }; });
    for (const k of ["streaks", "clock", "decades", "year"]) if (r[k].s !== 200) throw new Error(k + " status " + r[k].s);
    if (!Array.isArray(r.streaks.j.days) || r.streaks.j.days.length !== 90) throw new Error("streaks.days length " + (r.streaks.j.days || []).length);
    if (!Array.isArray(r.clock.j.matrix || r.clock.j.minutes || r.clock.j.grid) && !r.clock.j.total && r.clock.j.total !== 0) throw new Error("clock shape: " + JSON.stringify(r.clock.j).slice(0, 100));
    if (r.bad !== 400) throw new Error("bad year status " + r.bad);
    await gotoQuiet(page, URL + "/library/stats", { timeout: 45000 });
    const summary = page.locator('[data-testid="stats-summary"]').first();
    await summary.waitFor({ state: "visible", timeout: 15000 });
    if (seed.ignored) {
      // prod rule: the harness play is ignored, harness-days has no counted play there: empty state, no streak.
      if (!(await summary.evaluate((el) => el.classList.contains("empty")))) throw new Error("harness play ignored but the stats page is not in its empty state");
      return `streaks days=${r.streaks.j.days.length}, clock total=${r.clock.j.total}, year months=${(r.year.j.months || []).length}, bad year 400; play ignored (prod rule): empty state, no streak block`;
    }
    await page.locator('[data-testid="stats-streak"]').first().waitFor({ state: "visible", timeout: 15000 });
    const blocks = { clock: await page.locator('[data-testid="stats-clock"]').count(), year: await page.locator('[data-testid="stats-year"]').count(), share: await page.locator('[data-testid="share-week"]').count() };
    return `streaks current=${r.streaks.j.current} longest=${r.streaks.j.longest}, clock total=${r.clock.j.total}, year months=${(r.year.j.months || []).length}, bad year 400, blocks ${JSON.stringify(blocks)}`;
  });

  await c41step("library_duplicates", async () => {
    // c41b: duplicates endpoint contract and the /about section.
    const d = await page.evaluate(async () => { const x = await fetch("/api/v1/local/duplicates?limit=20", { cache: "no-store" }); return { s: x.status, j: await x.json().catch(() => null) }; });
    if (d.s !== 200 || !d.j || !Array.isArray(d.j.groups)) throw new Error("duplicates: " + JSON.stringify(d).slice(0, 120));
    await gotoQuiet(page, URL + "/about", { timeout: 45000 });
    await page.locator('[data-testid="about-duplicates"]').first().waitFor({ state: "visible", timeout: 15000 });
    return `duplicates total=${d.j.total} (groups shown ${d.j.groups.length}), about section ok`;
  });

  // Cycle 38 steps live in steps-c38-core.cjs (gated by its own C38_SKIP / env C38_SKIP).
  // Every module receives the same contract (DEPS): page helpers, fixtures, the skip / library
  // precondition helpers, the lid resolved above and whether the target counts harness plays.
  const DEPS = { page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, gotoQuiet, waitQuiet, tier: TIER, fixtures: FIX, newHarnessContext, rawRequest, skip, libraryAtLeast, requireLibrary, lid: LID, acquiredVideoId: VID, statsIncludeHarness: STATS_INCLUDE, envSkipped };
  // A module that throws outside a step (setup code) must not idle the run until the chain timeout
  // (chains 47-50: "URL is not a constructor" in steps-c45-core): it becomes a FAIL and the run goes on.
  try { await require("./steps-c38-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c38_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c38_core", "-", msg); }
  // Cycle 42 (c42b) and cycle 43 (c43a) steps live in their own modules (gated by C42_SKIP / C43_SKIP).
  // A module that throws outside a step (setup code) must not idle the run until the chain timeout
  // (chains 47-50: "URL is not a constructor" in steps-c45-core): it becomes a FAIL and the run goes on.
  try { await require("./steps-c42-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c42_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c42_core", "-", msg); }
  // A module that throws outside a step (setup code) must not idle the run until the chain timeout
  // (chains 47-50: "URL is not a constructor" in steps-c45-core): it becomes a FAIL and the run goes on.
  try { await require("./steps-c43-ux.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c43_ux", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c43_ux", "-", msg); }
  // A module that throws outside a step (setup code) must not idle the run until the chain timeout
  // (chains 47-50: "URL is not a constructor" in steps-c45-core): it becomes a FAIL and the run goes on.
  try { await require("./steps-c44-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c44_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c44_core", "-", msg); }
  // A module that throws outside a step (setup code) must not idle the run until the chain timeout
  // (chains 47-50: "URL is not a constructor" in steps-c45-core): it becomes a FAIL and the run goes on.
  try { await require("./steps-c45-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c45_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c45_core", "-", msg); }
  // A module that throws outside a step (setup code) must not idle the run until the chain timeout
  // (chains 47-50: "URL is not a constructor" in steps-c45-core): it becomes a FAIL and the run goes on.
  try { await require("./steps-c45-stats.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c45_stats", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c45_stats", "-", msg); }
  // Cycle 47 (c47c) steps: pack refresh preview + data saver; gated "enable with chain 55" in C47_SKIP until the
  // chain builds f257daa on staging (c47a). Same try/catch pattern.
  try { await require("./steps-c47-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c47_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c47_core", "-", msg); }
  try { await require("./steps-c48-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c48_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c48_core", "-", msg); }
  try { await require("./steps-c48-artists.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c48_artists", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c48_artists", "-", msg); }
  try { await require("./steps-c48-dayone.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c48_dayone", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c48_dayone", "-", msg); }
  try { await require("./steps-c51-ux.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c51_ux", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c51_ux", "-", msg); }
  try { await require("./steps-c51-home.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c51_home", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c51_home", "-", msg); }
  try { await require("./steps-c52-ux.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c52_ux", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c52_ux", "-", msg); }
  try { await require("./steps-c54-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c54_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c54_core", "-", msg); }
  try { await require("./steps-c56-core.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c56_core", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c56_core", "-", msg); }
  try { await require("./steps-c57-ux.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c57_ux", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c57_ux", "-", msg); }
  try { await require("./steps-c59-fr.cjs").run(DEPS); }
  catch (e) { const msg = "module_crash " + String((e && e.message) || e).split("\n")[0]; steps.push({ name: "module_c59_fr", ok: false, detail: msg, durationMs: 0 }); console.log("FAIL", "module_c59_fr", "-", msg); }

  await step(page, "home_personal_rows", async () => {
    // Cycle 8 (c8a): "Récemment acquis" (local albums, always available) renders on /home.
    await gotoQuiet(page, URL + "/home", { timeout: 45000 });
    // Cycle 44 (B7-2): "Arrive en <mois>" ranks above "Recemment acquis" and the home keeps 4 personal
    // rows (HOME_MAX_VISIBLE_ROWS): a profile with history shows Reprendre / Pour toi / ... and may drop
    // both library rows. The step now asserts the personal block itself: >= 3 rows painted, at least one
    // of them with 3+ cards, and names the rows (chain 51).
    const rowsLoc = page.locator("[data-row]");
    await pollUntil(async () => ((await rowsLoc.count()) >= 3 ? true : null), 15000, 500);
    const keys = await page.evaluate(() => [...document.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row")));
    if (keys.length < 3) throw new Error("personal rows painted=" + keys.length + " " + JSON.stringify(keys));
    let best = 0;
    for (const k of keys) { const c = await page.locator(`[data-row="${k}"]`).locator("article.item, .item").count(); if (c > best) best = c; }
    if (best < 3) throw new Error("no row with 3+ cards: " + JSON.stringify(keys));
    const local = keys.filter((k) => k === "recemment-acquis" || k === "row-arrived-month");
    return `rows=${keys.join(",")} (max cards=${best}, library rows=${local.length})`;
  });

  await step(page, "shortcuts_sheet", async () => {
    // Cycle 8 (c8b): "?" opens the keyboard cheat sheet, Escape closes it.
    await page.locator("body").click({ position: { x: 5, y: 400 } }).catch(() => {});
    await page.keyboard.press("?");
    const sheet = page.locator('[data-testid="shortcuts-sheet"]');
    await sheet.waitFor({ state: "visible", timeout: 8000 });
    const rows = await sheet.locator("tr, li, dt").count();
    if (rows < 12) throw new Error("shortcut rows=" + rows);
    await page.keyboard.press("Escape");
    await sleep(500);
    if (await sheet.isVisible().catch(() => false)) throw new Error("sheet still open after Escape");
    return `rows=${rows}`;
  });

  await step(page, "lyrics_from_player_mobile", async () => {
    // Cycle 5 (c5a): on a phone, Paroles from the fullscreen player must show the lyrics page.
    const mctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mlog = [];
    try {
      const mp = await mctx.newPage();
      mp.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") mlog.push(m.type() + ": " + m.text().slice(0, 140)); });
      mp.on("pageerror", (e) => mlog.push("pageerror: " + String(e).slice(0, 140)));
      mp.on("requestfailed", (r) => { if (/localf|\/aud\/|\/vp|player\.json/.test(r.url())) mlog.push("reqfail: " + (r.failure() && r.failure().errorText) + " " + r.url().slice(0, 90)); });
      const mobileFail = async (msg) => {
        await mp.screenshot({ path: path.join(OUT, "mobile-lyrics-FAIL.png") }).catch(() => {});
        const title = ((await mp.locator(".now-playing-title, .player-title").first().innerText().catch(() => "")) || "").trim();
        throw new Error(msg + " | title=" + JSON.stringify(title) + " | " + mlog.slice(0, 6).join(" || "));
      };
      await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 60000 });
      // On 390 px the subtitle wraps and its centre can land on the artist link: click the
      // row's title line (previous sibling of the "Song •" subtitle) instead.
      const sub = mp.getByText(/Song\s*•/).first();
      const titleEl = sub.locator("xpath=preceding-sibling::*[1]");
      if (await titleEl.count()) await titleEl.click({ timeout: 8000 }); else await sub.click({ position: { x: 8, y: 8 }, timeout: 8000 });
      await sleep(4000);
      // ".player-title" is also a class of the play button: only ".now-playing-title" names the track.
      await mp.locator(".now-playing-title").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      // Since cycle 11 the mobile mini-bar has no lyrics link: open the fullscreen (tap the cover)
      // and use its "Paroles" button; fall back to any visible Paroles control.
      await mp.locator("footer img").first().click({ timeout: 4000 }).catch(() => {}); await sleep(1500);
      const all = mp.locator('[data-testid="fullscreen-lyrics"], [aria-label*="parole" i], [aria-label="Lyrics"], button:has-text("Paroles")');
      let clicked = false;
      for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
        for (let i = 0; i < await all.count(); i++) {
          const c = all.nth(i);
          if (await c.isVisible().catch(() => false)) {
            try { await c.click({ timeout: 10000 }); clicked = true; break; } catch { /* retry */ }
          }
        }
        if (!clicked) await sleep(1500);
      }
      if (!clicked) await mobileFail("no visible Paroles control");
      await sleep(3000);
      if (!/\/lyrics/.test(mp.url())) throw new Error("no /lyrics route: " + mp.url());
      const mtitle = ((await mp.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
      if (!mtitle) throw new Error("current track lost on navigation to /lyrics (mobile)");
      // Audit UX v4 TOP 1: the popup itself (".fullscreen-player-popup") must be out of the way,
      // not just any element whose class mentions "fullscreen" (the Paroles button matched first).
      const fsState = await mp.evaluate(() => {
        const el = document.querySelector(".fullscreen-player-popup") || document.querySelector(".fullscreen, [class*='fullscreen']");
        if (!el) return { open: false, why: "no popup element" };
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        const onScreen = r.top < window.innerHeight - 100 && r.bottom > 100;
        const open = r.height > 300 && onScreen && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.5;
        return { open, why: `top=${Math.round(r.top)} h=${Math.round(r.height)} vis=${cs.visibility} op=${cs.opacity} state=${el.getAttribute("data-state")}` };
      });
      if (fsState.open) throw new Error("fullscreen player still covers the lyrics page: " + fsState.why);
      const h1 = await mp.locator("h1").first().isVisible().catch(() => false);
      if (!h1) throw new Error("lyrics heading not visible: " + fsState.why);
      const body = (await mp.locator("body").innerText()).replace(/\s+/g, " ");
      return `url ok, fullscreen closed (${fsState.why}), body=${body.length}`;
    } finally { await mctx.close(); }
  });

  await step(page, "lyrics_fast_after_open", async () => {
    // Audit UX v5 TOP 1: a deferred "open" timer in +layout.svelte could re-open the
    // fullscreen after Paroles when the tap came within ~425 ms of the opening. Tap fast.
    const mctx = await newHarnessContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 60000 });
      const sub = mp.getByText(/Song\s*•/).first();
      const titleEl = sub.locator("xpath=preceding-sibling::*[1]");
      if (await titleEl.count()) await titleEl.click({ timeout: 8000 }); else await sub.click({ position: { x: 8, y: 8 }, timeout: 8000 });
      await mp.locator(".now-playing-title").first().waitFor({ state: "visible", timeout: 15000 });
      await sleep(2500);
      await mp.locator("footer img").first().click({ timeout: 4000 });
      // Tap Paroles as soon as it is visible (no settle delay): this is the fast path.
      const btn = mp.locator('[data-testid="fullscreen-lyrics"]').first();
      await btn.waitFor({ state: "visible", timeout: 5000 });
      await btn.click({ timeout: 5000 });
      await sleep(3000);
      if (!/\/lyrics/.test(mp.url())) throw new Error("no /lyrics route: " + mp.url());
      const fs = await mp.evaluate(() => {
        const el = document.querySelector(".fullscreen-player-popup"); if (!el) return { open: false, why: "no popup" };
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        const open = r.height > 300 && r.top < window.innerHeight - 100 && r.bottom > 100 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.5;
        return { open, why: `top=${Math.round(r.top)} vis=${cs.visibility} op=${cs.opacity} state=${el.getAttribute("data-state")}` };
      });
      if (fs.open) { await mp.screenshot({ path: path.join(OUT, "mobile-lyrics-fast-FAIL.png") }).catch(() => {}); throw new Error("fullscreen re-opened over /lyrics: " + fs.why); }
      return `closed (${fs.why})`;
    } finally { await mctx.close(); }
  });

  await step(page, "nonlocal_track_plays", async () => {
    // A track that is NOT in the library must stream through iv-vp (/aud/<id>) and advance.
    // The gost /vp proxy is throttled by googlevideo (~18 KB/s) and ends in PIPELINE_ERROR_READ.
    // Playing it also acquires it (by design), so after the first run the source becomes /localf.
    // HD1: the fixture id is a YouTube track the library ALREADY owns by content, so no run
    // enqueues a new acquisition (the path under test is still the YouTube /listen?id= one).
    const vid = process.env.NONLOCAL_VIDEO_ID || VID;
    if (!vid) skip("needs the acquiredVideoId fixture (a YouTube track streamed through /aud)");
    await gotoQuiet(page, URL + "/listen?id=" + vid, { timeout: 45000 }).catch(() => {});
    await page.getByRole("button", { name: /start listening|écouter|lire/i }).first().click({ timeout: 15000 });
    const m0 = await pollUntil(async () => { const m = await media(page); return m && m.src ? m : null; }, 45000);
    if (!m0) throw new Error("no media src for non-local track " + vid);
    if (!/\/aud\/|\/localf\?/.test(m0.src)) throw new Error("expected /aud/ or /localf source, got " + m0.src.slice(0, 80));
    const s0 = await pollUntil(async () => { const m = await media(page); return m && m.t > 0 ? m : null; }, 45000);
    await sleep(3000); const s1 = await media(page);
    if (!s0 || !s1 || !(s1.t > s0.t)) throw new Error("non-local track not advancing " + JSON.stringify(s0) + " -> " + JSON.stringify(s1));
    return `src=${m0.src.slice(URL.length, URL.length + 24)} t ${s0.t.toFixed(1)}->${s1.t.toFixed(1)}`;
  });

  await step(page, "perf_headers", async () => {
    // Lane c2c: compression on shell/bundles/API, immutable cache on hashed assets, no-store on API.
    const res = await page.evaluate(async () => {
      const get = async (u) => { const r = await fetch(u, { cache: "no-store" }); return { u, st: r.status, enc: r.headers.get("content-encoding"), cc: r.headers.get("cache-control"), xc: r.headers.get("x-ytm-cache") }; };
      const html = await (await fetch("/home", { cache: "no-store" })).text();
      const m = html.match(/\/_app\/immutable\/[^"' ]+\.js/);
      const shell = await get("/home");
      await get("/api/v1/home.json?probe=cache"); // warm the server-side TTL cache
      const api = await get("/api/v1/home.json?probe=cache");
      return [shell, api, m ? await get(m[0]) : { u: "none", st: 0, enc: null, cc: null }];
    });
    const bad = [];
    const [shell, api, asset] = res;
    if (!shell.enc) bad.push("shell not compressed");
    if (!api.enc) bad.push("api not compressed");
    if (!(api.cc || "").includes("no-store")) bad.push("api cache-control=" + api.cc);
    if (asset.st === 200 && !(asset.cc || "").includes("immutable")) bad.push("asset cache-control=" + asset.cc);
    if (api.st === 200 && api.xc !== "HIT" && api.xc !== "STALE") bad.push("server cache not hit on 2nd call: x-ytm-cache=" + api.xc); // c33b: STALE = served from cache, refreshed in background
    if (bad.length) throw new Error(bad.join("; ") + " " + JSON.stringify(res));
    return `shell=${shell.enc} api=${api.enc}/${api.cc}/${api.xc} asset=${asset.cc}`;
  });

  await step(page, "no_page_errors", async () => {
    if (pageErrors.length) throw new Error(pageErrors.length + " page errors: " + pageErrors[0]);
    return `console errors=${consoleErrors.length}`;
  });

  fs.writeFileSync(path.join(OUT, "console.log"), consoleErrors.join("\n"));
  fs.writeFileSync(path.join(OUT, "pageerrors.log"), pageErrors.join("\n"));
  await ctx.close(); await browser.close();
  const report = writeReport(version);
  process.exit(report.failed ? 1 : 0);
})();
