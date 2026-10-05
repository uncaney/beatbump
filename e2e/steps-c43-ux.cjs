// steps-c43-ux.cjs: cycle 43 harness addition for harness-core.cjs (audit UX v12, lane c43a: U12-2, U12-10,
// U12-11, U12-13). Spliced into harness-core.cjs after the c42 steps with:
//   await require("./steps-c43-ux.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C43_SKIP (exported Set) lists step names to skip; env C43_SKIP="a,b" adds to it and
// C43_STEPS_ENABLED=0 skips them all. Steps:
//   ux_v12_open_fixes   one phone context (390x844, 2x): /home "Voir tout" (or "See All") link height >= 44
//                       (U12-10, Carousel index.scss .header > a); /library "Sync Your Data", "Export Data",
//                       "Import Data" >= 44 px tall (U12-10); /library/mixes first .mix-card computed
//                       border-top/right/bottom-width 0px (U12-2); a search Song row played, the fullscreen
//                       opened from the mini-bar cover, then a toast forced into [data-testid=alert-container]
//                       (class "alert m-alert m-alert-error", the real global rule) must have an opaque
//                       background (alpha 1, computed opacity 1), the container must carry .in-fullscreen with
//                       bottom:auto (docked under the top bar, U12-13) and the toast box must end above the
//                       "Suivant :" line and the queue handle when they are shown.
//                       No existing step triggers "Morceau indisponible" (player.ts handleError needs a real
//                       unplayable source), hence the forced-visible toast; the Alert component applies only
//                       pointer-events and the fullscreen anchor to .alert, the background is global _alert.scss.
const fs = require("fs");
const path = require("path");

const C43_SKIP = new Set(); // chain 47: ux_v12_open_fixes under diagnosis (c46b, fixed); re-enabled by c47a (B8-16) after a run alone 02/10 02:45 (PASS 5 s)
const STEP_NAMES = ["ux_v12_open_fixes"];
const MIN_TAP = 44;

const loadFixtures = () => require("./harness-lib.cjs").loadFixtures();

// Same play() hook as harness-core.cjs: the player's media element is an Audio() outside the DOM.
function mediaHook() {
  window.__ytmMedia = { plays: 0 };
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia.plays++; window.__ytmMedia.el = this; window.__ytmMedia.src = this.currentSrc || this.src; return o.apply(this, arguments); };
}

async function mediaOf(p) {
  return p.evaluate(() => {
    const m = window.__ytmMedia;
    const el = (m && m.el) || (m && typeof m.currentTime === "number" ? m : null) || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}

// "rgb(179, 47, 42)" -> 1, "rgba(179, 47, 42, 0.44)" -> 0.44, "transparent" -> 0.
function alphaOf(color) {
  const s = String(color || "").trim();
  if (!s || s === "transparent") return 0;
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (!m) return NaN;
  const parts = m[1].split(/[,/]\s*|\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3];
  return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
}

const fmtBox = (b) => (b ? `${b.width.toFixed(0)}x${b.height.toFixed(0)}` : "no box");

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const QUERY = deps.QUERY || FIX.query || "daft punk";
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const enabled = process.env.C43_STEPS_ENABLED !== "0";
  const skip = new Set([...C43_SKIP, ...String(process.env.C43_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c43step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());

  await c43step("ux_v12_open_fixes", async () => {
    const mctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    try {
      const mp = await mctx.newPage();
      await mp.addInitScript(mediaHook);
      const parts = [];

      // 1. U12-10: the "Voir tout" / "See All" carousel link on the home page.
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const seeAll = mp.locator('a:has-text("Voir tout"), a:has-text("See All"), a:has-text("Tout voir")').first();
      await seeAll.waitFor({ state: "visible", timeout: 20000 });
      const sa = await seeAll.boundingBox();
      if (!sa || sa.height < MIN_TAP) throw new Error(`"Voir tout" link ${fmtBox(sa)} (expected height >= ${MIN_TAP})`);
      parts.push(`Voir tout ${fmtBox(sa)}`);

      // 2. U12-10: Sync Your Data / Export Data / Import Data under the Library heading.
      await mp.goto(URL + "/library", { waitUntil: "load", timeout: 45000 });
      const btns = mp.locator("main header button");
      const n = await pollUntil(async () => { const c = await btns.count(); return c >= 3 ? c : null; }, 15000, 500);
      if (!n) throw new Error(`library header buttons: ${await btns.count()} found (expected 3)`);
      const libParts = [];
      for (let i = 0; i < n; i++) {
        const b = btns.nth(i);
        const label = ((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim() || `#${i}`;
        const box = await b.boundingBox();
        if (!box || box.height < MIN_TAP) throw new Error(`library button "${label}" ${fmtBox(box)} (expected height >= ${MIN_TAP})`);
        libParts.push(`${label} ${fmtBox(box)}`);
      }
      parts.push("library " + libParts.join(", "));

      // 3. U12-2: no default (UA) border on the Mixes cards, only the coloured left edge (a library without any
      //    mix card, below the 15-album threshold, ends the step as a SKIP with the reason).
      await require("./harness-lib.cjs").requireMixCards(URL);
      await mp.goto(URL + "/library/mixes", { waitUntil: "load", timeout: 45000 });
      const card = mp.locator(".mix-card").first();
      await card.waitFor({ state: "visible", timeout: 25000 });
      const bw = await card.evaluate((el) => { const cs = getComputedStyle(el); return { top: cs.borderTopWidth, right: cs.borderRightWidth, bottom: cs.borderBottomWidth, left: cs.borderLeftWidth }; });
      const bad = ["top", "right", "bottom"].filter((k) => parseFloat(bw[k]) !== 0);
      if (bad.length) throw new Error(`.mix-card border ${bad.map((k) => k + "=" + bw[k]).join(" ")} (expected 0px, left edge ${bw.left})`);
      if (!(parseFloat(bw.left) > 0)) throw new Error(`.mix-card lost its coloured left edge (border-left-width ${bw.left})`);
      parts.push(`mix-card border top/right/bottom ${bw.top}/${bw.right}/${bw.bottom}, left ${bw.left}`);

      // 4. U12-13: toast in the phone fullscreen player: opaque, docked under the top bar, clear of "Suivant :".
      await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
      const sub = mp.getByText(/Song\s*•/).first();
      await sub.waitFor({ state: "visible", timeout: 20000 });
      const titleEl = sub.locator("xpath=preceding-sibling::*[1]");
      if (await titleEl.count()) await titleEl.click({ timeout: 8000 }); else await sub.click({ position: { x: 8, y: 8 }, timeout: 8000 });
      const m0 = await pollUntil(async () => { const m = await mediaOf(mp); return m && m.src ? m : null; }, 30000, 500);
      if (!m0) throw new Error("no media src after the Song click (fullscreen toast check)");
      await sleep(1500);
      await mp.locator("footer img").first().click({ timeout: 5000 });
      const fsMarker = mp.locator('[data-testid="playback-context"], [data-testid="fullscreen-next-up"]').first();
      await fsMarker.waitFor({ state: "visible", timeout: 10000 });
      await sleep(600);
      const toast = await mp.evaluate(() => {
        const c = document.querySelector('[data-testid="alert-container"]');
        if (!c) return { error: "no [data-testid=alert-container]" };
        const d = document.createElement("div");
        d.className = "alert m-alert m-alert-error";
        d.setAttribute("data-harness", "c43a");
        d.textContent = "Morceau indisponible : Source audio illisible · passage au suivant";
        c.appendChild(d);
        try {
          const cs = getComputedStyle(d);
          const cc = getComputedStyle(c);
          const r = d.getBoundingClientRect();
          const next = document.querySelector('[data-testid="fullscreen-next-up"]');
          const handle = document.querySelector(".handle.horizontal, #fullscreen-queue-sheet");
          const nr = next ? next.getBoundingClientRect() : null;
          const hr = handle ? handle.getBoundingClientRect() : null;
          const cr = c.getBoundingClientRect();
          return {
            bg: cs.backgroundColor, opacity: cs.opacity, visible: r.width > 0 && r.height > 0,
            inFullscreen: c.classList.contains("in-fullscreen"), position: cc.position, bottom: cc.bottom, top: cc.top, zIndex: cc.zIndex,
            containerTop: Math.round(cr.top), containerBottom: Math.round(cr.bottom),
            box: { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) },
            nextTop: nr ? Math.round(nr.top) : null, handleTop: hr && hr.height > 0 ? Math.round(hr.top) : null,
            viewportH: window.innerHeight,
          };
        } finally { d.remove(); }
      });
      if (toast.error) throw new Error(toast.error);
      const alpha = alphaOf(toast.bg);
      if (!(alpha >= 0.999)) throw new Error(`fullscreen toast background ${toast.bg} (alpha ${alpha}, expected 1)`);
      if (parseFloat(toast.opacity) < 1) throw new Error(`fullscreen toast opacity ${toast.opacity} at rest (expected 1)`);
      if (!toast.visible) throw new Error("forced toast has no box in the fullscreen");
      if (!toast.inFullscreen) throw new Error("alert container without .in-fullscreen while the fullscreen player is open");
      // c46b: getComputedStyle() resolves top/bottom of a positioned (fixed) element to USED pixel values,
      // never "auto" (chain 47: "bottom 721.312px, top 54px" = 844 - 54 - 69, the dock WAS applied). The
      // dock is asserted by geometry: the container's box starts in the top third of the viewport (under the
      // 4.5rem top bar) instead of above the mini-bar at the bottom.
      if (!(toast.containerTop >= 0 && toast.containerTop < toast.viewportH / 3)) throw new Error(`alert container still anchored at the bottom (box top ${toast.containerTop}px of ${toast.viewportH}px, computed top ${toast.top} / bottom ${toast.bottom})`);
      if (parseFloat(toast.top) > 120) throw new Error(`alert container top ${toast.top} (expected ~4.5rem under the top bar)`);
      if (toast.nextTop !== null && toast.box.bottom > toast.nextTop) throw new Error(`toast bottom ${toast.box.bottom} overlaps "Suivant :" at ${toast.nextTop}`);
      if (toast.handleTop !== null && toast.box.bottom > toast.handleTop) throw new Error(`toast bottom ${toast.box.bottom} overlaps the queue handle at ${toast.handleTop}`);
      await mp.keyboard.press("Escape").catch(() => {});
      parts.push(`fullscreen toast ${toast.bg} opacity ${toast.opacity}, container docked at top ${toast.containerTop}px (computed top ${toast.top}), box ${toast.box.top}-${toast.box.bottom}/${toast.viewportH}, Suivant at ${toast.nextTop === null ? "n/a" : toast.nextTop}, handle at ${toast.handleTop === null ? "n/a" : toast.handleTop}, z ${toast.zIndex}`);

      return parts.join("; ");
    } finally { await mctx.close(); }
  }, { budgetMs: 90000 });
}

module.exports = { run, C43_SKIP, STEP_NAMES, alphaOf };
