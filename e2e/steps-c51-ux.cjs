// steps-c51-ux.cjs: cycle 51 harness addition for harness-core.cjs (audit UX v13, lane c51a: U13-1, U13-2).
// Spliced into harness-core.cjs after the c48 steps with:
//   await require("./steps-c51-ux.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, tier, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C51_SKIP (exported Set) lists step names to skip; env C51_SKIP="a,b" adds to it and
// C51_STEPS_ENABLED=0 skips them all. Steps:
//   stats_tabs_visible        one phone context (390x844, 2x): /library/stats, the three period tabs
//                             [data-testid=stats-period-7|30|365] are visible, each >= 44 px tall and wide,
//                             and the contrast ratio of their text on their effective background (computed
//                             from getComputedStyle like the low_contrast metric of shots-c50.cjs: alpha
//                             blending up the ancestors, inherited opacity, WCAG relative luminance) is
//                             >= 4.5 for the inactive ones and the active one (U13-1: "7 jours" / "365 jours"
//                             used to be rgb(15,15,15) on the dark pill, ratio 1,01).
//   first_pack_size_announced fresh phone context (no memo, no history: the day-one card shows). c52d: since
//                             cycle 51 (U13-4, lane c51c) the card waits for the first sound of the session, so
//                             the step plays a library Song first and moves to /home in-SPA, exactly as
//                             first_pack_card does (steps-c48-dayone.cjs playThenHome); /home then shows
//                             [data-testid=first-pack-card] and, BEFORE any tap on it, [data-testid=first-pack-size]
//                             carries a size ("Mo" or "Go" after a number, U13-2); window.__ytmFirstPack.estimate
//                             agrees (bytes > 0, count >= 1). The card is not tapped: no pack is downloaded.
const fs = require("fs");
const path = require("path");

const C51_SKIP = new Set();
const STEP_NAMES = ["stats_tabs_visible", "first_pack_size_announced"];
const MIN_TAP = 44;
const MIN_RATIO = 4.5;

function loadFixtures() {
  for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

// Same play() hook as harness-core.cjs: window.__ytmMedia is the media element itself once play() ran.
function mediaHook() {
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return o.apply(this, arguments); };
}

// c52d: the "first sound" helpers of steps-c48-dayone.cjs (first_pack_card), copied: that module exports
// none of them. mediaOf accepts window.__ytmMedia as the element itself (mediaHook above) or as the
// dayone wrapper {el}.
async function mediaOf(p) {
  return p.evaluate(() => {
    const m = window.__ytmMedia;
    const el = (m && m.el) || (m && typeof m.currentTime === "number" ? m : null) || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}
// Click a same-origin link from inside the SPA (SvelteKit intercepts it: client-side navigation, playback kept).
async function spaNavigate(p, href) {
  await p.evaluate((h) => {
    const a = document.createElement("a");
    a.href = h; a.textContent = "harness-nav"; a.style.position = "fixed"; a.style.left = "-9999px";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }, href);
}
// Start a library Song from the search page (fixture query); resolves the media state once it plays past 2 s.
async function playLibrarySong(p, URL, QUERY) {
  await p.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=library", { waitUntil: "load", timeout: 45000 });
  let row = p.getByText(/Song\s*•/).first();
  if (!(await row.isVisible({ timeout: 8000 }).catch(() => false))) {
    await p.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
    row = p.getByText(/Song\s*•/).first();
    await row.waitFor({ state: "visible", timeout: 20000 });
  }
  return row;
}
async function clickRowAndWaitForSound(p, row, pollUntil) {
  try { await row.click({ position: { x: 8, y: 8 }, timeout: 8000 }); } catch (e) { throw new Error(`search row click failed: ${String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 200)}`); }
  const m0 = await pollUntil(async () => { const m = await mediaOf(p); return m && m.src && m.t > 2 ? m : null; }, 40000, 500);
  if (!m0) throw new Error("playback did not start");
  return m0;
}

// Runs in the page: the contrast ratio of an element's text on its effective background, the same
// computation as the low_contrast metric (shots-c50.cjs): rgba parse, alpha blending up the ancestors
// (the body colour as the root), the inherited opacity of up to four ancestors, WCAG relative luminance.
function contrastProbe(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const parse = (c) => { const m = String(c || "").match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (node) => {
    let e = node; let acc = null;
    while (e && e !== document.documentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { acc = acc ? blend(acc, c) : c; if (c.a >= 1 || (acc && acc.a >= 1)) return acc; }
      e = e.parentElement;
    }
    const root = parse(getComputedStyle(document.body).backgroundColor) || { r: 14, g: 17, b: 23, a: 1 };
    return acc ? blend(acc, root) : root;
  };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const fg = parse(cs.color);
  if (!fg) return { error: "unparsable color " + cs.color };
  const bg = bgOf(el);
  const f2 = fg.a < 1 ? blend(fg, bg) : fg;
  let op = 1, e2 = el; for (let i = 0; i < 4 && e2; i++, e2 = e2.parentElement) op *= parseFloat(getComputedStyle(e2).opacity || "1");
  const f3 = op < 1 ? blend({ ...f2, a: op }, bg) : f2;
  const L1 = lum(f3), L2 = lum(bg);
  const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  return {
    text: (el.textContent || "").replace(/\s+/g, " ").trim(), color: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
    opacity: +op.toFixed(2), ratio: +ratio.toFixed(2), w: Math.round(r.width), h: Math.round(r.height), fontPx: parseFloat(cs.fontSize),
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    selected: el.getAttribute("aria-selected") === "true", tt: cs.textTransform,
  };
}

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  // c52d: the fixture query of the search page the first sound comes from (harness-core hands QUERY over).
  const QUERY = deps.QUERY || (FIX && FIX.query) || "daft punk";
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const enabled = process.env.C51_STEPS_ENABLED !== "0";
  const skip = new Set([...C51_SKIP, ...String(process.env.C51_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c51step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const phone = () => newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  void FIX;

  await c51step("stats_tabs_visible", async () => {
    const mctx = await phone();
    try {
      const mp = await mctx.newPage();
      await mp.addInitScript(mediaHook);
      await mp.goto(URL + "/library/stats", { waitUntil: "load", timeout: 45000 });
      await mp.locator('[data-testid="stats-period-30"]').waitFor({ state: "visible", timeout: 20000 });
      await sleep(500);
      const probes = [];
      for (const d of [7, 30, 365]) {
        const r = await mp.evaluate(contrastProbe, `[data-testid="stats-period-${d}"]`);
        if (!r) throw new Error(`stats-period-${d} absent on /library/stats`);
        if (r.error) throw new Error(`stats-period-${d}: ${r.error}`);
        probes.push({ d, ...r });
      }
      const bad = [];
      for (const p of probes) {
        if (!p.visible) bad.push(`${p.d} jours: not visible`);
        if (p.ratio < MIN_RATIO) bad.push(`${p.d} jours: contrast ${p.ratio} (${p.color} on ${p.bg}, opacity ${p.opacity}; expected >= ${MIN_RATIO})`);
        if (p.h < MIN_TAP || p.w < MIN_TAP) bad.push(`${p.d} jours: ${p.w}x${p.h} px (expected >= ${MIN_TAP})`);
        if (p.fontPx < 12) bad.push(`${p.d} jours: font ${p.fontPx}px (expected >= 12)`);
        if (p.tt === "capitalize" || p.tt === "uppercase") bad.push(`${p.d} jours: text-transform ${p.tt}`);
        if (!new RegExp(`^${p.d}\\s*jours$`).test(p.text)) bad.push(`${p.d} jours: text "${p.text}"`);
      }
      const selected = probes.filter((p) => p.selected);
      if (selected.length !== 1) bad.push(`${selected.length} selected tabs (expected exactly 1)`);
      // The selected tab must look different from the others (its background, not only aria-selected).
      const others = probes.filter((p) => !p.selected);
      if (selected.length === 1 && others.length && others.every((p) => p.bg === selected[0].bg && p.color === selected[0].color)) bad.push("the selected tab has the same colours as the inactive ones");
      if (bad.length) throw new Error("stats period tabs: " + bad.join("; "));
      // Tapping another period keeps the contrast (the active pill is black on green).
      await mp.locator('[data-testid="stats-period-7"]').click({ timeout: 8000 });
      await sleep(400);
      const after = await mp.evaluate(contrastProbe, '[data-testid="stats-period-7"]');
      if (!after || !after.selected) throw new Error("7 jours not selected after its tap");
      if (after.ratio < MIN_RATIO) throw new Error(`active 7 jours: contrast ${after.ratio} (${after.color} on ${after.bg})`);
      return probes.map((p) => `${p.d}j ${p.selected ? "[active] " : ""}${p.color} on ${p.bg} ratio ${p.ratio}, ${p.w}x${p.h}, ${p.fontPx}px`).join("; ") + `; after tap 7j active ratio ${after.ratio}`;
    } finally { await mctx.close(); }
  }, { budgetMs: 60000 });

  await c51step("first_pack_size_announced", async () => {
    // Fresh context: no memo (ytm-first-pack-card), no history, the service worker installs on this visit.
    const fctx = await phone();
    try {
      const fp = await fctx.newPage();
      await fp.addInitScript(mediaHook);
      await fp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      // c52d (U13-4): the card waits for the first sound. Play a library Song, then /home in-SPA so the
      // player survives the navigation and the card's gate sees "not paused" on mount (as first_pack_card).
      const row = await playLibrarySong(fp, URL, QUERY);
      const m0 = await clickRowAndWaitForSound(fp, row, pollUntil);
      await spaNavigate(fp, "/home");
      await pollUntil(async () => (/\/home\/?(\?|#|$)/.test(fp.url()) ? fp.url() : null), 15000, 300);
      const card = fp.locator('[data-testid="first-pack-card"]');
      await card.waitFor({ state: "visible", timeout: 40000 }).catch(() => { throw new Error(`first-pack-card absent 40 s after the first sound (media t=${m0.t.toFixed(1)} s, in-SPA /home)`); });
      const sizeRe = /\d[\d\s  ,]*\s*(Mo|Go)\b/;
      // The size line arrives once the plan is computed (sources + cache listing): no tap meanwhile.
      const size = await pollUntil(async () => {
        const t = ((await fp.locator('[data-testid="first-pack-size"]').first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        return sizeRe.test(t) ? t : null;
      }, 40000, 500);
      const cardText = ((await card.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!size) throw new Error(`first-pack-size without a size before the tap (card text "${cardText.slice(0, 120)}")`);
      if (!sizeRe.test(cardText)) throw new Error(`card text has no "Mo" / "Go": "${cardText.slice(0, 120)}"`);
      if (!/qualité d'origine|qualite d'origine/i.test(size)) throw new Error(`size line does not name the quality: "${size}"`);
      const exposed = await fp.evaluate(() => { const p = window.__ytmFirstPack; return p && p.estimate ? { bytes: p.estimate.bytes, count: p.estimate.count, capped: p.estimate.capped, dataSaver: p.estimate.dataSaver, started: p.started } : null; });
      if (!exposed) throw new Error("window.__ytmFirstPack.estimate absent although the size line is shown");
      if (!(exposed.bytes > 0) || !(exposed.count >= 1)) throw new Error(`estimate bytes ${exposed.bytes}, count ${exposed.count} (expected > 0, >= 1)`);
      if (exposed.started === true) throw new Error("the pack started without a tap");
      if (/^Économie de données/.test(size) !== !!exposed.capped) throw new Error(`size line "${size}" vs capped=${exposed.capped}`);
      const memo = await fp.evaluate(() => { try { return localStorage.getItem("ytm-first-pack-card"); } catch { return null; } });
      if (memo === "1") throw new Error("memo ytm-first-pack-card=1 written without a tap or a dismiss");
      return `size before the tap: "${size}" (estimate ${exposed.bytes} bytes, ${exposed.count} tracks, capped ${exposed.capped}, data saver ${exposed.dataSaver}); nothing started`;
    } finally { await fctx.close(); }
  }, { budgetMs: 160000 }); // c52d: + the first sound (search, play past 2 s, in-SPA /home)
}

module.exports = { run, C51_SKIP, STEP_NAMES, contrastProbe };
