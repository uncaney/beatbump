// steps-c52-ux.cjs: cycle 52 harness addition for harness-core.cjs (audit UX v13 leftovers, lane c52a:
// U13-13, U13-14, U13-20 and the "Aujourd'hui" delights B9-26 / B9-27; B9-12 "Dernier ajout" link).
// Spliced into harness-core.cjs after the c51 steps with:
//   await require("./steps-c52-ux.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, tier, fixtures: FIX, newHarnessContext });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C52_SKIP (exported Set) lists step names to skip; env C52_SKIP="a,b" adds to it and
// C52_STEPS_ENABLED=0 skips them all. One step per item group (<= 3):
//   ux_v13_stats_about   one phone context: /library/stats <title> and <h1> = "Tes stats" with the active
//                        period as the subtitle (U13-20), and [data-testid=stats-period-sub] follows the tab
//                        (30 -> "7 derniers jours"); /about [data-testid=about-last-added] is a link to
//                        /library/albums?filter=added-month&month=YYYY-MM (B9-12); on /bienvenue the install
//                        bar carries NO self-referential link to /bienvenue (U13-13).
//   ux_v13_today_share   /home "Aujourd'hui": the one subtitle is the steady "un autre a minuit (UTC+2)" line
//                        (B9-27), and [data-testid=album-of-day-share] is a >= 44 px button whose click calls
//                        navigator.share (stubbed) with a /listen?id= URL (B9-26).
//   ux_v13_data_saver    toggle [data-testid=setting-data-saver] on in /settings: the "Garder hors-ligne
//                        chaque morceau ecoute" switch shows [data-testid=offline-autocache-suspended]; on
//                        /library/downloads-offline the notice [data-testid=data-saver-notice] shows an inline
//                        "Modifier" link [data-testid=data-saver-modify] >= 44 px tall to /settings (U13-14).
// B9-3 (Annuler contrast + 12 px progress) and B9-4 (pin badge) are asserted by the shots-c50.cjs metrics
// (low_contrast / small_text on offline_first_pack_running, offline_badges); B9-6 by the offlinePack vitest.
const fs = require("fs");
const path = require("path");

const C52_SKIP = new Set(); // chain 61: ux_v13_data_saver gated (locator.check on the display:none input); c53c clicks label.switch, played alone then ungated
const STEP_NAMES = ["ux_v13_stats_about", "ux_v13_today_share", "ux_v13_data_saver"];
const MIN_TAP = 44;

const loadFixtures = () => require("./harness-lib.cjs").loadFixtures();

// Same play() hook as harness-core.cjs: window.__ytmMedia IS the element (deps.media reads it as one).
function mediaHook() {
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return o.apply(this, arguments); };
}

// B9-26: a navigator.share stub that records what was shared (no real sheet in headless).
function shareStub() {
  try {
    Object.defineProperty(navigator, "share", { configurable: true, value: async (d) => { window.__ytmShare = d; } });
  } catch { /* some browsers freeze navigator; the step then falls back to the clipboard path */ }
}

const fmtBox = (b) => (b ? `${b.width.toFixed(0)}x${b.height.toFixed(0)}` : "no box");

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  void FIX;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const enabled = process.env.C52_STEPS_ENABLED !== "0";
  const skip = new Set([...C52_SKIP, ...String(process.env.C52_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c52step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());

  // Every context is created here and then tagged with the harness header via setExtraHTTPHeaders.
  async function phone() {
    const c = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await c.setExtraHTTPHeaders({ "X-Ytm-Harness": "1" });
    return c;
  }

  await c52step("ux_v13_stats_about", async () => {
    const mctx = await phone();
    try {
      const mp = await mctx.newPage();
      const parts = [];

      // 1. U13-20: /library/stats is "Tes stats", the active period is the subtitle and follows the tab.
      await mp.goto(URL + "/library/stats", { waitUntil: "load", timeout: 45000 });
      await mp.locator('[data-testid="stats-period-30"]').waitFor({ state: "visible", timeout: 20000 });
      const title = (await mp.title()) || "";
      if (title.trim() !== "Tes stats") throw new Error(`stats <title> "${title}" (expected "Tes stats")`);
      const h1 = (await mp.locator("main h1").first().innerText().catch(() => "")).trim();
      if (h1 !== "Tes stats") throw new Error(`stats <h1> "${h1}" (expected "Tes stats")`);
      const sub = mp.locator('[data-testid="stats-period-sub"]');
      await sub.waitFor({ state: "visible", timeout: 10000 });
      const sub30 = (await sub.innerText()).trim();
      if (!/derniers jours$/.test(sub30)) throw new Error(`stats subtitle "${sub30}" (expected "… derniers jours")`);
      await mp.locator('[data-testid="stats-period-7"]').click({ timeout: 8000 });
      const sub7 = await pollUntil(async () => { const t = (await sub.innerText()).trim(); return /^7 derniers jours$/.test(t) ? t : null; }, 8000, 300);
      if (!sub7) throw new Error(`stats subtitle did not follow the 7-day tab (still "${(await sub.innerText()).trim()}")`);
      parts.push(`stats "Tes stats", subtitle "${sub30}" -> "${sub7}"`);

      // 2. B9-12: the "Dernier ajout" row links to that month's added-month list.
      await mp.goto(URL + "/about", { waitUntil: "load", timeout: 45000 });
      const href = await pollUntil(async () => mp.evaluate(() => {
        const a = document.querySelector('[data-testid="about-last-added"] a[href]');
        return a ? a.getAttribute("href") : null;
      }), 20000, 500);
      if (!href) throw new Error("no [data-testid=about-last-added] a[href] on /about (Dernier ajout not a link)");
      const u = new globalThis.URL(href, URL);
      if (u.searchParams.get("filter") !== "added-month" || !/^\d{4}-\d{2}$/.test(u.searchParams.get("month") || "")) {
        throw new Error(`Dernier ajout link "${href}" (expected filter=added-month&month=YYYY-MM)`);
      }
      parts.push(`Dernier ajout -> ${u.pathname}?${u.searchParams.toString()}`);

      // 3. U13-13: on /bienvenue the install bar never carries the self-referential link.
      await mp.goto(URL + "/bienvenue", { waitUntil: "load", timeout: 45000 });
      await sleep(1200);
      const selfLink = await mp.evaluate(() => {
        const a = document.querySelector('[data-testid="install-hint-how"]');
        if (!a) return { present: false };
        const href = a.getAttribute("href") || "";
        return { present: true, toBienvenue: new URL(href, location.href).pathname.replace(/\/+$/, "") === "/bienvenue" };
      });
      if (selfLink.present && selfLink.toBienvenue) throw new Error('/bienvenue install bar still shows the self-referential "Comment installer ?" link to /bienvenue');
      parts.push(`/bienvenue install link ${selfLink.present ? "present but not to /bienvenue" : "absent"}`);

      return parts.join("; ");
    } finally { await mctx.close(); }
  }, { budgetMs: 70000 });

  await c52step("ux_v13_today_share", async () => {
    const mctx = await phone();
    try {
      await mctx.addInitScript(mediaHook);
      await mctx.addInitScript(shareStub);
      const mp = await mctx.newPage();
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const parts = [];

      const row = mp.locator('[data-testid="today-row"]');
      await row.waitFor({ state: "visible", timeout: 25000 }).catch(() => { throw new Error("no [data-testid=today-row] on /home within 25 s"); });

      // B9-27: one steady subtitle naming when the next one comes.
      const subtxt = (await row.locator(".subheading").first().innerText().catch(() => "")).trim();
      // L15-8 (cycle 57): the subtitle now names midnight UTC in local time ("02:00 (minuit UTC)"); any "minuit" wording is the steady line.
      if (!/minuit/i.test(subtxt)) throw new Error(`"Aujourd'hui" subtitle "${subtxt}" (expected the steady "minuit" line)`);
      parts.push(`subtitle "${subtxt}"`);

      // B9-26: the share button of the album of the day, >= 44 px, shares a /listen?id= link.
      const share = mp.locator('[data-testid="album-of-day-share"]');
      await share.waitFor({ state: "visible", timeout: 15000 }).catch(() => { throw new Error("no [data-testid=album-of-day-share] in the album-of-day tile"); });
      const sb = await share.boundingBox();
      if (!sb || sb.height < MIN_TAP || sb.width < MIN_TAP) throw new Error(`album-of-day share button ${fmtBox(sb)} (expected >= ${MIN_TAP}x${MIN_TAP})`);
      await share.click({ timeout: 8000 });
      const shared = await pollUntil(async () => mp.evaluate(() => (window.__ytmShare && window.__ytmShare.url) || null), 20000, 500);
      if (!shared) throw new Error("navigator.share was not called from the album-of-day share button");
      if (!/\/listen\?id=/.test(shared)) throw new Error(`album-of-day share URL "${shared}" (expected a /listen?id= link)`);
      parts.push(`share ${fmtBox(sb)} -> navigator.share ${new globalThis.URL(shared).pathname}?${new globalThis.URL(shared).searchParams.toString().slice(0, 40)}`);

      return parts.join("; ");
    } finally { await mctx.close(); }
  }, { budgetMs: 70000 });

  await c52step("ux_v13_data_saver", async () => {
    const mctx = await phone();
    try {
      const mp = await mctx.newPage();
      const parts = [];

      // Turn Data Saver on through the real switch. c53c: the checkbox input [data-testid=setting-data-saver] is
      // display:none (settings/+page.svelte `[type="checkbox"] { display: none }`), so check() fails even with
      // force; the visible control is its sibling <label class="switch" for="data-saver">. The step clicks it,
      // then asserts the input and the persisted store localStorage("settings").playback["Data Saver"].
      await mp.goto(URL + "/settings", { waitUntil: "load", timeout: 45000 });
      const toggle = mp.locator('[data-testid="setting-data-saver"]');
      await toggle.waitFor({ state: "attached", timeout: 20000 });
      if (await toggle.isChecked()) throw new Error("Data Saver already on in a fresh context");
      const sw = mp.locator('label.switch[for="data-saver"]');
      await sw.waitFor({ state: "visible", timeout: 10000 }).catch(() => { throw new Error("no visible label.switch[for=data-saver] next to the hidden input"); });
      await sw.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      const swBox = await sw.boundingBox();
      await sw.click({ timeout: 8000 });
      const on = await pollUntil(async () => ((await toggle.isChecked()) ? true : null), 5000, 200);
      if (!on) throw new Error("could not turn Data Saver on (click on label.switch[for=data-saver])");
      const stored = await pollUntil(async () => mp.evaluate(() => { try { const s = JSON.parse(localStorage.getItem("settings") || "null"); return s && s.playback && s.playback["Data Saver"] === true ? true : null; } catch { return null; } }), 5000, 200);
      if (!stored) throw new Error('localStorage "settings".playback["Data Saver"] is not true after the switch');
      parts.push(`switch ${fmtBox(swBox)} on, settings.playback["Data Saver"]=true`);

      // B9-2 (U13-14): the "Garder hors-ligne chaque morceau ecoute" switch now says it is suspended. c53c: at
      // f995374 the note appears only after a reload (OfflineSettings' `$: dataSaverWhy` does not follow the live
      // bind:checked of the settings page; the setting itself is persisted): live is tried for 4 s, then the page
      // is reloaded; the detail says which one it was ("live" / "after reload only" = app follow-up, not a failure).
      const suspended = mp.locator('[data-testid="offline-autocache-suspended"]');
      let live = true;
      await suspended.waitFor({ state: "visible", timeout: 4000 }).catch(() => { live = false; });
      if (!live) {
        await mp.reload({ waitUntil: "load", timeout: 45000 });
        if (!(await toggle.isChecked())) throw new Error("Data Saver not persisted across a reload");
        await suspended.waitFor({ state: "visible", timeout: 10000 }).catch(() => { throw new Error("[data-testid=offline-autocache-suspended] not shown under the Garder switch while Data Saver is on (even after a reload)"); });
      }
      const susTxt = (await suspended.innerText()).trim();
      if (!/économie de données/i.test(susTxt)) throw new Error(`suspended note "${susTxt}" (expected it to mention l'economie de donnees)`);
      parts.push(`Reglages: "${susTxt}" (${live ? "live" : "after reload only"})`);

      // B9-2 (U13-14): the offline page notice carries an inline 44 px "Modifier" link to /settings.
      await mp.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
      const notice = mp.locator('[data-testid="data-saver-notice"]');
      await notice.waitFor({ state: "visible", timeout: 15000 }).catch(() => { throw new Error("[data-testid=data-saver-notice] not shown on the offline page while Data Saver is on"); });
      const modify = mp.locator('[data-testid="data-saver-modify"]');
      await modify.waitFor({ state: "visible", timeout: 8000 }).catch(() => { throw new Error("no inline [data-testid=data-saver-modify] link in the data-saver notice"); });
      const mb = await modify.boundingBox();
      // U14-10 (cycle 57): inline link measured at 43.5-44 px depending on sub-pixel rounding: half a pixel of tolerance.
      if (!mb || mb.height < MIN_TAP - 0.5) throw new Error(`"Modifier" link ${fmtBox(mb)} (expected height >= ${MIN_TAP})`);
      const mhref = await modify.getAttribute("href");
      if ((mhref || "").replace(/\/+$/, "") !== "/settings") throw new Error(`"Modifier" href "${mhref}" (expected /settings)`);
      parts.push(`offline notice "Modifier" ${fmtBox(mb)} -> ${mhref}`);

      return parts.join("; ");
    } finally { await mctx.close(); }
  }, { budgetMs: 70000 });
}

module.exports = { run, C52_SKIP, STEP_NAMES };
