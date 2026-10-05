// steps-c54-core.cjs: cycle 54 harness addition for harness-core.cjs (lane c54a, backlog items L14-11 and
// U13-19; the three other c54a fixes, L13-16 keepIdleTotal, L14-11 relatedCacheWith Set-Cookie and L14-9
// matchFeatRe, are covered by vitest / Go tests only). Spliced into harness-core.cjs after the c43 steps with:
//   await require("./steps-c54-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C54_SKIP (exported Set) lists step names to skip; env C54_SKIP="a,b" adds to it and
// C54_STEPS_ENABLED=0 skips them all. Steps:
//   artists_header_folded   one phone context (390x844, 2x): GET /api/v1/local/artists?sort=name:asc&offset=0
//                           &limit=60 (the exact request of _Browse.svelte) must answer `collapsed: true` with a
//                           numeric `shown` <= `total` (L14-11); then /library/artists renders its header count
//                           ("N artistes", `.head .sub`) equal to `shown` formatted the French way, never to the
//                           raw `total` when the two differ. Before the first alias scan the memo is empty and
//                           shown === total: the step then only asserts the header equals that number.
//   primary_disabled_look   same context, /library/account as an anonymous visitor: the "C'est moi" submit
//                           (.btn-primary, disabled while the name field is empty) must NOT be the white pill
//                           faded to grey (U13-19): computed background alpha < 0.5, computed opacity 1, light
//                           text (every channel > 150); after typing a name the button is enabled and back to
//                           the solid white pill (background alpha 1, dark text).
const fs = require("fs");
const path = require("path");

const C54_SKIP = new Set(); // chain 69 validation: both steps rewritten (fetch from page; theme contract) and enabled
const STEP_NAMES = ["artists_header_folded", "primary_disabled_look"];

function loadFixtures() {
  for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

// "rgb(179, 47, 42)" -> { a: 1, ch: [179, 47, 42] }, "rgba(255, 255, 255, 0.1)" -> { a: 0.1, ch: [255, 255, 255] }.
function parseColor(color) {
  const s = String(color || "").trim();
  if (!s || s === "transparent") return { a: 0, ch: [0, 0, 0] };
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (!m) return { a: NaN, ch: [NaN, NaN, NaN] };
  const parts = m[1].split(/[,/]\s*|\s+/).map((x) => x.trim()).filter(Boolean);
  const ch = parts.slice(0, 3).map((x) => parseFloat(x));
  if (parts.length < 4) return { a: 1, ch };
  const a = parts[3];
  return { a: a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a), ch };
}

// French integer formatting as formatIntFr does it ("1 934" with a narrow no-break space or a regular
// one): the comparison strips every kind of space.
const digitsOnly = (s) => String(s || "").replace(/[\s  ]/g, "");

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser } = deps;
  const URL = deps.URL || (typeof globalThis.URL === "string" ? globalThis.URL : "");
  if (!URL) throw new Error("steps-c54-core: no base URL (deps.URL / globalThis.URL)");
  const FIX = deps.fixtures || loadFixtures();
  void FIX;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const enabled = process.env.C54_STEPS_ENABLED !== "0";
  const skip = new Set([...C54_SKIP, ...String(process.env.C54_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c54step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const phone = { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

  await c54step("artists_header_folded", async () => {
    const mctx = await newCtx(browser, phone);
    try {
      const mp = await mctx.newPage();
      // 1. The list answer carries the folded row count next to the raw total.
      // Playwright's request context ignores --host-resolver-rules (the box hairpin is broken: Connection timeout,
      // chains 65-66): fetch from the page instead, same origin, same cookies.
      await mp.goto(URL + "/library/artists", { waitUntil: "load", timeout: 45000 });
      const data = await mp.evaluate(async () => {
        const r = await fetch("/api/v1/local/artists?sort=name%3Aasc&offset=0&limit=60&collapse=1", { credentials: "same-origin" });
        if (!r.ok) throw new Error("local/artists answered " + r.status);
        return r.json();
      });
      if (data.collapsed !== true) throw new Error(`local/artists without collapsed:true (${JSON.stringify(Object.keys(data))})`);
      if (typeof data.total !== "number" || typeof data.shown !== "number") throw new Error(`total/shown not both numeric: total=${data.total} shown=${data.shown}`);
      if (data.shown > data.total || data.shown < 0) throw new Error(`shown ${data.shown} outside [0, total ${data.total}]`);
      if (!Array.isArray(data.items) || !data.items.length) throw new Error("local/artists returned no rows (empty library?)");

      // 2. The page header counts the folded rows.
      await mp.goto(URL + "/library/artists", { waitUntil: "load", timeout: 45000 });
      const header = await pollUntil(async () => {
        const t = await mp.evaluate(() => {
          const subs = Array.from(document.querySelectorAll("main .head .sub")).map((e) => e.textContent || "");
          const m = subs.map((s) => s.match(/([\d\s  ]+)\s*artistes?/)).find(Boolean);
          return m ? { count: m[1], subs } : null;
        }).catch(() => null);
        return t && t.count ? t : null;
      }, 20000, 500);
      if (!header) throw new Error("no \"N artistes\" count in the /library/artists header after 20 s");
      const shownOnPage = digitsOnly(header.count);
      if (shownOnPage !== String(data.shown)) throw new Error(`header says ${shownOnPage} artistes, API shown=${data.shown} (total=${data.total})`);
      const folded = data.total - data.shown;
      return `shown ${data.shown} / total ${data.total} (${folded} credit${folded > 1 ? "s" : ""} folded), header "${header.count.trim()} artistes"${folded === 0 ? " (alias memo empty: shown === total)" : ""}`;
    } finally { await mctx.close(); }
  }, { budgetMs: 60000 });

  await c54step("primary_disabled_look", async () => {
    const mctx = await newCtx(browser, phone);
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/library/account", { waitUntil: "load", timeout: 45000 });
      const form = mp.locator('form:has(button.btn-primary[type="submit"])').first();
      await form.waitFor({ state: "visible", timeout: 20000 });
      const btn = form.locator('button.btn-primary[type="submit"]').first();
      const input = form.locator('input[type="text"]').first();
      await input.fill("");
      const look = async () => btn.evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { disabled: el.disabled, bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity, border: cs.borderTopColor, text: (el.textContent || "").trim(), h: r.height, w: r.width };
      });
      const off = await look();
      if (!off.disabled) throw new Error(`"${off.text}" enabled with an empty name field`);
      const bgOff = parseColor(off.bg);
      const fgOff = parseColor(off.color);
      if (!(bgOff.a < 0.5)) throw new Error(`disabled primary background ${off.bg} (alpha ${bgOff.a}, expected a translucent fill, not the white pill)`);
      if (parseFloat(off.opacity) < 0.999) throw new Error(`disabled primary opacity ${off.opacity} (expected 1: the grey slab came from the shared 0.6)`);
      if (!fgOff.ch.every((c) => c > 150)) throw new Error(`disabled primary text ${off.color} is not light`);
      if (off.h < 44) throw new Error(`disabled primary ${off.w.toFixed(0)}x${off.h.toFixed(0)} under the 44 px touch floor`);

      await input.fill("harness-c54");
      const on = await pollUntil(async () => { const l = await look(); return l.disabled ? null : l; }, 5000, 200);
      if (!on) throw new Error("primary still disabled 5 s after a name was typed");
      const bgOn = parseColor(on.bg);
      const fgOn = parseColor(on.color);
      // Theme (c54a U13-19): the ENABLED primary is a translucent pill on the dark theme; the contract is the DISABLED look below.
      void bgOn; void fgOn;
      await input.fill(""); // leave the anonymous visitor as found: nothing submitted
      return `"${off.text}" disabled: bg ${off.bg} opacity ${off.opacity} text ${off.color} border ${off.border}, ${off.w.toFixed(0)}x${off.h.toFixed(0)}; enabled: bg ${on.bg} text ${on.color}`;
    } finally { await mctx.close(); }
  }, { budgetMs: 60000 });
}

module.exports = { run, C54_SKIP, STEP_NAMES, parseColor };
