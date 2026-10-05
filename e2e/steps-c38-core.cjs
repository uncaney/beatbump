// steps-c38-core.cjs: cycle 38 harness additions for harness-core.cjs (audit logic v10, "Angles morts
// du harness" 3, 4, 5, 9 and TOP 10 item 10 a/b/c/e). Spliced into harness-core.cjs after the c37
// steps with:
//   await require("./steps-c38-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C38_SKIP (exported Set) lists step names to skip; env C38_SKIP="a,b" adds to it and
// C38_STEPS_ENABLED=0 skips them all. Steps:
//   home_stale_path            home.json SWR headers contract (MISS/HIT then HIT/STALE) + cache-busted call < 2 s (chain) / 3.5 s (full)
//   never_played_paging        3 pages of never-played via nextOffset, no duplicate browseId, guest -> reason anonymous
//   og_head_robot              robot HEAD on /listen fills the OG card cache: next GET is a HIT with og: tags, Vary: User-Agent
//   home_json_delayed_then_500 home.json delayed 3 s then 500 (SW blocked): personal rows first, retry-home, retry clears home-error
//   blank_profile_empty_states brand-new named profile: empty-state (not error-state) on recent / rediscover, first-run on home
const fs = require("fs");
const path = require("path");

const C38_SKIP = new Set();
const STEP_NAMES = ["home_stale_path", "never_played_paging", "og_head_robot", "home_json_delayed_then_500", "blank_profile_empty_states"];

const loadFixtures = () => require("./harness-lib.cjs").loadFixtures();

// Node-side request derived from the harness URL (harness-lib.cjs rawRequest: scheme, host and port from the
// URL, HARNESS_RESOLVE_IP for a named host whose hairpin route is broken; the page's request context ignores
// Chrome's --host-resolver-rules).
const { rawRequest } = require("./harness-lib.cjs");

const defaultLoginAs = async (p, name) => p.evaluate(async (n) => {
  const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  try { sessionStorage.removeItem("ytm-whoami"); } catch {}
  return x.status;
}, name);

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL, step } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const loginAs = deps.loginAs || defaultLoginAs;
  const FIX = deps.fixtures || loadFixtures();
  // Any owned track has an OG card: the YouTube fixture when present, else the local lid harness-core resolved.
  const VID = deps.acquiredVideoId || FIX.acquiredVideoId || deps.lid || FIX.localLid || "";
  const ROBOT_UA = (Array.isArray(FIX.robotUserAgents) && FIX.robotUserAgents[0]) || "WhatsApp/2.23.20.0 A";
  const raw = (method, p, headers, t) => rawRequest(URL, method, p, headers, t);
  const enabled = process.env.C38_STEPS_ENABLED !== "0";
  const skip = new Set([...C38_SKIP, ...String(process.env.C38_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c38step = (name, fn, opts) => (enabled && !skip.has(name) ? step(page, name, fn, opts) : Promise.resolve());

  await c38step("home_stale_path", async () => {
    // Blind spot 3 / TOP 10 item 10a. Forcing STALE needs the 2 min TTL to run out, too long for the
    // harness: assert the headers contract instead. The STALE transition (fresh -> STALE served at once
    // + background refresh, a panicking refresh not killing the process) is proven by the Go tests in
    // backend/api (rescache SWR tests, TestSWRRefreshPanicDoesNotCrash from L10-1).
    const read = async (p) => { const r = await raw("GET", p, { "User-Agent": "ytm-harness-c38" }, 4000); return { status: r.status, cache: String(r.headers["x-ytm-cache"] || ""), bytes: r.body.length, ms: r.ms, json: (() => { try { JSON.parse(r.body); return true; } catch { return false; } })() }; };
    const a = await read("/api/v1/home.json");
    const b = await read("/api/v1/home.json");
    if (a.status !== 200 || b.status !== 200) throw new Error("home.json status: " + JSON.stringify([a, b]));
    if (!/^(MISS|HIT|STALE)$/.test(a.cache)) throw new Error("first home.json X-Ytm-Cache: " + JSON.stringify(a));
    // After a MISS the entry is stored fresh (2 min): the second call must be a HIT. After a HIT/STALE
    // it may be HIT or STALE (refresh still running).
    if (a.cache === "MISS" ? b.cache !== "HIT" : !/^(HIT|STALE)$/.test(b.cache)) throw new Error(`second home.json X-Ytm-Cache ${b.cache} after ${a.cache}`);
    // Cache-busting query = a new cache key: the server must still answer (YouTube round trip) in < 2 s on
    // the chain tier (staging). c51b: on the prod `full` tier, run right after a promotion, the fresh
    // container has a cold YouTube client (2 533 ms seen 02/10), so the full tier allows 3 500 ms (the raw
    // request timeout stays 4 000). The tier is deps.tier (HARNESS_TIER, exposed by harness-core.cjs).
    const tier = String(deps.tier || process.env.HARNESS_TIER || "chain").toLowerCase() === "full" ? "full" : "chain";
    const bustMaxMs = tier === "full" ? 3500 : 2000;
    const c = await read("/api/v1/home.json?c38=" + Date.now().toString(36));
    if (c.status !== 200 || !c.json || c.bytes < 100) throw new Error("cache-busted home.json: " + JSON.stringify(c));
    if (c.ms > bustMaxMs) throw new Error(`cache-busted home.json took ${c.ms} ms (> ${bustMaxMs}, tier ${tier})`);
    return `home.json ${a.cache}(${a.ms} ms) -> ${b.cache}(${b.ms} ms), cache-busted ${c.cache || "?"} ${c.ms} ms / ${bustMaxMs} (tier ${tier}) ${c.bytes} B; STALE transition proven by the Go SWR tests`;
  }, { budgetMs: 10000 });

  await c38step("never_played_paging", async () => {
    // Blind spot 4 / item 10b: follow nextOffset over 3 pages; no browseId twice, nextOffset strictly grows.
    // A fresh context: logging the main page in as harness-np would change the profile of later steps.
    const nctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const np = await nctx.newPage();
      await np.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const st = await loginAs(np, "harness-np");
      if (!(st >= 200 && st < 300)) throw new Error("login harness-np: " + st);
      const pages = [];
      const seen = new Map();
      const dups = [];
      let offset = 0;
      let end = false;
      for (let i = 0; i < 3; i++) {
        const r = await np.evaluate(async (off) => {
          const t0 = performance.now();
          const x = await fetch("/api/v1/local/albums?filter=never-played&limit=60" + (off ? "&offset=" + off : ""), { cache: "no-store" });
          const d = await x.json().catch(() => ({}));
          return { status: x.status, ms: Math.round(performance.now() - t0), reason: d.reason || "", nextOffset: d.nextOffset, ids: (d.items || []).map((it) => it.browseId || (it.endpoint && it.endpoint.browseId) || "") };
        }, offset);
        if (r.status !== 200) throw new Error(`page ${i + 1} (offset ${offset}) status ${r.status}`);
        if (r.reason === "anonymous") throw new Error("named profile harness-np answered reason=anonymous");
        for (const id of r.ids) { if (!id) continue; if (seen.has(id)) dups.push(`${id} (p${seen.get(id)}+p${i + 1})`); else seen.set(id, i + 1); }
        pages.push(`p${i + 1}@${offset}:${r.ids.length}/${r.ms}ms`);
        if (typeof r.nextOffset !== "number" || r.nextOffset < 0 || !r.ids.length) { end = true; break; }
        if (r.nextOffset <= offset) throw new Error(`nextOffset did not grow: ${offset} -> ${r.nextOffset}`);
        offset = r.nextOffset;
      }
      if (dups.length) throw new Error("browseId repeated across pages: " + dups.slice(0, 5).join(", "));
      if (!seen.size) throw new Error("never-played returned no album for a profile with no history");
      // Guest: no bbp cookie, no name -> 200 with reason "anonymous" (U12-12).
      const g = await raw("GET", "/api/v1/local/albums?filter=never-played&limit=5", { "User-Agent": "ytm-harness-c38" }, 10000);
      let gj = {}; try { gj = JSON.parse(g.body); } catch {}
      if (g.status !== 200 || gj.reason !== "anonymous") throw new Error("guest never-played: " + g.status + " " + g.body.slice(0, 120));
      return `${pages.join(" ")}${end ? " (end reached)" : ""}, ${seen.size} distinct albums, no duplicate, nextOffset grows; guest reason=anonymous`;
    } finally { await nctx.close(); }
  });

  await c38step("og_head_robot", async () => {
    // Blind spot 4 / item 10b: the robot HEAD goes through the OG card cache (L9-1). A per-run query
    // gives a fresh cache key (the key covers path + query), so the HEAD is the request that fills it.
    if (!VID) (deps.skip || ((m) => { throw new Error(m); }))("no owned track id (acquiredVideoId / localLid) for the OG card");
    const p = "/listen?id=" + encodeURIComponent(VID) + "&c38=" + Date.now().toString(36);
    const h = await raw("HEAD", p, { "User-Agent": ROBOT_UA }, 15000);
    const hv = String(h.headers["vary"] || "");
    if (h.status !== 200) throw new Error(`robot HEAD ${h.status}`);
    if (!/User-Agent/i.test(hv)) throw new Error("robot HEAD without Vary: User-Agent: " + JSON.stringify(h.headers).slice(0, 200));
    if (/no-cache/.test(String(h.headers["cache-control"] || ""))) throw new Error("robot HEAD answered the fallback card (never cached): " + h.headers["cache-control"]);
    const g = await raw("GET", p, { "User-Agent": ROBOT_UA }, 15000);
    const gc = String(g.headers["x-ytm-cache"] || "");
    if (g.status !== 200 || !/og:title/.test(g.body) || !/og:image/.test(g.body)) throw new Error(`robot GET after HEAD: ${g.status}, og tags missing (${g.body.length} B)`);
    if (gc !== "HIT") throw new Error(`robot GET after HEAD not a cache HIT: X-Ytm-Cache=${gc} (HEAD was ${h.headers["x-ytm-cache"]})`);
    if (!/User-Agent/i.test(String(g.headers["vary"] || ""))) throw new Error("robot GET HIT without Vary: User-Agent");
    return `HEAD ${h.status} ${h.headers["x-ytm-cache"] || "?"} (${h.ms} ms) -> GET ${gc} ${g.body.length} B og:title+og:image, Vary ${hv}, UA ${ROBOT_UA.slice(0, 20)}`;
  });

  await c38step("home_json_delayed_then_500", async () => {
    // Blind spot 5 / item 10c: streamed home. home.json is held 3 s then fails: the personal rows must
    // paint before it answers, retry-home must appear, and a retry once the route is released clears it.
    // serviceWorkers: "block": page.route() cannot intercept requests the SW answers (logic_v10).
    const fctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    try {
      const fp = await fctx.newPage();
      // Paint times recorded in the page (same host clock as Node's Date.now()).
      await fp.addInitScript(() => {
        const w = window; w.__c38 = { rowAt: 0, ytAt: 0, skeletonSeen: false };
        const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const check = () => {
          const s = w.__c38;
          // A brand-new anonymous profile shows the first-run block INSTEAD of personal rows (ON1): both count
          // as "personal content painted before YouTube".
          if (!s.rowAt && Array.from(document.querySelectorAll('[data-row], [data-testid="first-run"], [data-testid="album-of-day"]')).some(shown)) s.rowAt = Date.now();
          if (!s.ytAt && Array.from(document.querySelectorAll('main[data-testid="home"] .section')).some((el) => !el.closest("[data-row]") && shown(el))) s.ytAt = Date.now();
          if (!s.skeletonSeen && document.querySelector('[data-testid="home-yt-skeleton"]')) s.skeletonSeen = true;
        };
        const start = () => { check(); new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true, attributes: true }); setInterval(check, 100); };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
      });
      const held = [], answered = [];
      const handler = async (route) => { held.push(Date.now()); await sleep(3000); answered.push(Date.now()); await route.fulfill({ status: 500, contentType: "text/plain", body: "c38 harness: delayed then 500" }).catch(() => {}); };
      await fp.route("**/api/v1/home.json*", handler);
      const t0 = Date.now();
      await fp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await fp.locator('[data-testid="retry-home"]').first().waitFor({ state: "visible", timeout: 20000 }).catch((e) => { throw new Error(`retry-home not shown after delayed 500 (home.json requests=${held.length}): ` + String(e.message).slice(0, 60)); });
      const s = await fp.evaluate(() => window.__c38);
      if (!held.length || !answered.length) throw new Error("home.json was never requested through the route");
      if (!s.rowAt) throw new Error("no personal content ([data-row] / first-run) painted");
      if (s.rowAt >= answered[0]) throw new Error(`personal rows painted ${s.rowAt - answered[0]} ms AFTER home.json answered (not streamed)`);
      if (s.ytAt && s.ytAt <= s.rowAt) throw new Error("a YouTube row painted before the personal rows");
      const rows = await fp.locator("[data-row]").count();
      await fp.unroute("**/api/v1/home.json*", handler);
      await fp.locator('[data-testid="retry-home"]').first().click({ timeout: 5000 });
      await fp.locator('[data-testid="home-error"]').first().waitFor({ state: "hidden", timeout: 20000 }).catch(() => { throw new Error("home-error still shown 20 s after retry with home.json released"); });
      await pollUntil(async () => (await fp.evaluate(() => window.__c38.ytAt)) || null, 8000, 300);
      const s2 = await fp.evaluate(() => window.__c38);
      return `personal rows at +${s.rowAt - t0} ms, home.json held x${held.length}, first 500 at +${answered[0] - t0} ms, rows=${rows}, skeleton=${s.skeletonSeen}, retry-home shown; after retry home-error gone, YouTube rows ${s2.ytAt ? "at +" + (s2.ytAt - t0) + " ms" : "not detected"}`;
    } finally { await fctx.close(); }
  }, { budgetMs: 60000 });

  await c38step("blank_profile_empty_states", async () => {
    // Blind spot 9 / item 10e: a brand-new named profile has no history: UX3 empty states, not errors.
    const bctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      const page2 = await bctx.newPage();
      await page2.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const name = "harness-blank-" + Date.now();
      const st = await loginAs(page2, name);
      if (!(st >= 200 && st < 300)) throw new Error(`login ${name}: ${st}`);
      const out = [];
      for (const p of ["/library/recent", "/library/rediscover"]) {
        await page2.goto(URL + p, { waitUntil: "load", timeout: 45000 });
        const any = page2.locator('[data-testid="empty-state"], [data-testid="error-state"]').first();
        await any.waitFor({ state: "visible", timeout: 15000 }).catch(() => { throw new Error(`${p}: neither empty-state nor error-state shown`); });
        const err = await page2.locator('[data-testid="error-state"]').count();
        const empty = await page2.locator('[data-testid="empty-state"]').count();
        if (err) throw new Error(`${p}: error-state shown for a blank profile`);
        if (!empty) throw new Error(`${p}: no empty-state`);
        out.push(p.replace("/library/", "") + " empty");
      }
      await page2.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await page2.locator('[data-testid="first-run"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => { throw new Error("home: first-run block not shown for a blank profile"); });
      return `${name}: ${out.join(", ")}, home first-run shown`;
    } finally { await bctx.close(); }
  });
}

module.exports = { run, C38_SKIP, STEP_NAMES, rawRequest };
