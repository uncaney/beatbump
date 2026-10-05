// steps-c48-dayone.cjs: cycle 48 harness addition for harness-core.cjs (lane c48c: B8-2 "Emporte 1 h de musique",
// B8-4 install bar after the first sound, BACKLOG P2 Compte login form wiped by the page's second mount).
// Spliced into harness-core.cjs after the c47 steps with:
//   try { await require("./steps-c48-dayone.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, gotoQuiet, tier: TIER, fixtures: FIX }); }
//   catch (e) { console.log("FAIL steps-c48-dayone (module)", String(e && e.message || e).split("\n")[0]); }
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C48_SKIP (exported Set) lists step names to skip; env C48_SKIP="a,b" adds to it and
// C48_STEPS_ENABLED=0 skips them all. Rule (c47a): a new step is played ALONE (HARNESS_ONLY=<name>) before it
// enters a chain. Steps (each in a fresh browser context: an anonymous profile without history):
//   first_pack_card           phone context A (fresh, anonymous, no history): /home painted 3 s WITHOUT
//                             [data-testid=first-pack-card] (c51c U13-4: shouldShowFirstPackCard needs heardSound,
//                             the first AudioPlayer.paused true -> false of the session); a library Song starts
//                             playing (same play mechanism as install_hint_after_sound: playLibrarySong +
//                             clickRowAndWaitForSound, fixture query), the page moves in-SPA to /home (playback
//                             kept: a full load would reset the player and the card's gate) and the card appears
//                             (service worker active); its "✕" ([first-pack-dismiss]) hides it and a reload keeps
//                             it hidden (localStorage ytm-first-pack-card = "1"). Phone context B: same play then
//                             in-SPA /home; the tap on
//                             [first-pack-start] plans a 1 h pack (window.__ytmFirstPack.started, count >= 1), the
//                             page moves to /library/downloads-offline (the Espace card shows the running pack:
//                             [data-testid=pack-progress] or the folded "pack en cours" line) and the service
//                             worker's list-audio grows to >= min(5, count) entries within 90 s; back on /home the
//                             card is gone.
//   install_hint_after_sound  iPhone user agent (canOffer on iOS without beforeinstallprompt), fresh context: /home
//                             painted 3 s without [data-testid=install-hint], the search page likewise; a library Song
//                             starts playing (media src, t > 2) and the bar appears within 15 s on the same document
//                             (2 s "just started" window), with its "Comment installer ?" link.
//   account_form_keeps_input  desktop context: a library Song starts playing, the page moves in-SPA to
//                             /library/account, the login name is filled ONCE; 5 s later the input still holds it and
//                             the submit button is enabled (no refill), exactly one <main> and one name input are in
//                             the DOM after 1 s (the page was mounted once: Wrapper key on the live location).
const fs = require("fs");
const path = require("path");

const C48_SKIP = new Set(); // chain 59: first_pack_card enabled (step fixed by c49b, PASS alone)
const STEP_NAMES = ["first_pack_card", "install_hint_after_sound", "account_form_keeps_input"];
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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

// The service worker's audio cache listing; -1 without a SW, -2 when it does not answer within 5 s.
// c49b: the SW answers `list-audio` with reply() -> event.source.postMessage({type:"audio-list"}), i.e. a
// "message" event on navigator.serviceWorker of the sending window, NEVER on a transferred port (the
// previous MessageChannel-only reader timed out at -2 even on an empty cache, chain 56). Same form as
// swList in steps-c38-offline.cjs / swRequest in app/src/lib/offline.ts.
async function swAudioCount(p) {
  return p.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    if (!r || !r.active) return -1;
    const ctl = navigator.serviceWorker.controller || r.active;
    return new Promise((res) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; navigator.serviceWorker.removeEventListener("message", on); res(v); };
      const count = (d) => ((d && d.entries) || []).length;
      const on = (ev) => { if (ev.data && ev.data.type === "audio-list") done(count(ev.data)); };
      navigator.serviceWorker.addEventListener("message", on);
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => done(count(e.data));
      ctl.postMessage({ type: "list-audio" }, [ch.port2]);
      setTimeout(() => done(-2), 5000);
    });
  }).catch(() => -3);
}

// Start a library Song from the search page (fixture query); resolves the media state once it plays past 2 s.
async function playLibrarySong(p, URL, QUERY, pollUntil) {
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

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const QUERY = deps.QUERY || FIX.query || "daft punk";
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const enabled = process.env.C48_STEPS_ENABLED !== "0";
  const skip = new Set([...C48_SKIP, ...String(process.env.C48_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c48step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const phone = () => newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  // c51d (U13-4): the card waits for the first sound of the session. Play a library Song exactly as
  // install_hint_after_sound does (same helpers, same fixture query, media hook on the context), then move to
  // /home IN-SPA: the player survives the client-side navigation and the card's gate sees "not paused" on mount.
  const playThenHome = async (p) => {
    const row = await playLibrarySong(p, URL, QUERY, pollUntil);
    const m0 = await clickRowAndWaitForSound(p, row, pollUntil);
    await spaNavigate(p, "/home");
    await pollUntil(async () => (/\/home\/?(\?|#|$)/.test(p.url()) ? p.url() : null), 15000, 300);
    return m0;
  };

  await c48step("first_pack_card", async () => {
    const parts = [];
    // A. no card before the first sound; card after it; dismiss persists across a reload.
    const actx = await phone();
    try {
      await actx.addInitScript(mediaHook);
      const ap = await actx.newPage();
      await ap.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const card = ap.locator('[data-testid="first-pack-card"]');
      await sleep(3000);
      if (await card.count()) throw new Error("first-pack-card shown on the first paint of /home (before any sound)");
      const m0 = await playThenHome(ap);
      await card.waitFor({ state: "visible", timeout: 40000 }).catch(() => { throw new Error(`first-pack-card absent 40 s after the first sound (media t=${m0.t.toFixed(1)} s, in-SPA /home)`); });
      parts.push(`card absent before sound, present after (media t=${m0.t.toFixed(1)} s)`);
      const title = ((await card.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!/Emporte 1 h de musique/.test(title)) throw new Error(`first-pack-card text "${title.slice(0, 60)}" (expected "Emporte 1 h de musique")`);
      await ap.locator('[data-testid="first-pack-dismiss"]').click({ timeout: 8000 });
      await sleep(500);
      if (await card.count()) throw new Error("first-pack-card still shown after its dismiss");
      const memo = await ap.evaluate(() => { try { return localStorage.getItem("ytm-first-pack-card"); } catch { return null; } });
      if (memo !== "1") throw new Error(`dismiss memo ytm-first-pack-card=${JSON.stringify(memo)} (expected "1")`);
      await ap.reload({ waitUntil: "load", timeout: 45000 });
      await sleep(4000);
      if (await card.count()) throw new Error("first-pack-card back after a reload despite the dismiss");
      parts.push("dismiss persists across reload");
    } finally { await actx.close(); }

    // B. the tap prepares the pack and lands on the Hors-ligne page (fresh context: play first, card after the sound).
    const bctx = await phone();
    try {
      await bctx.addInitScript(mediaHook);
      const bp = await bctx.newPage();
      await bp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const card = bp.locator('[data-testid="first-pack-card"]');
      await playThenHome(bp);
      await card.waitFor({ state: "visible", timeout: 40000 }).catch(() => { throw new Error("first-pack-card absent 40 s after the first sound (context B, in-SPA /home)"); });
      const before = await swAudioCount(bp);
      await bp.locator('[data-testid="first-pack-start"]').click({ timeout: 8000 });
      const plan = await pollUntil(async () => bp.evaluate(() => { const p = window.__ytmFirstPack; return p && (p.started === true || p.reason) ? p : null; }), 40000, 500);
      if (!plan) throw new Error("no window.__ytmFirstPack after the tap (plan never computed)");
      if (plan.started !== true) throw new Error(`pack not started: ${plan.reason || "?"}${plan.message ? " " + String(plan.message).slice(0, 100) : ""}`);
      if (!(plan.count >= 1)) throw new Error(`pack plan count ${plan.count} (expected >= 1)`);
      const onOffline = await pollUntil(async () => (/\/library\/downloads-offline/.test(bp.url()) ? bp.url() : null), 15000, 300);
      if (!onOffline) throw new Error(`page stayed on ${bp.url().replace(URL, "")} (expected /library/downloads-offline)`);
      const shown = await pollUntil(async () => {
        const prog = await bp.locator('[data-testid="pack-progress"]').count();
        const txt = ((await bp.locator('[data-testid="offline-space"]').first().innerText().catch(() => "")) || "").replace(/\s+/g, " ");
        return prog > 0 ? "pack-progress" : /pack en cours|prêts hors-ligne|Pack terminé/.test(txt) ? "espace line" : null;
      }, 20000, 500);
      if (!shown) throw new Error("the Espace card does not show the running / finished pack");
      const want = Math.min(5, plan.count);
      const after = await pollUntil(async () => { const n = await swAudioCount(bp); return n >= want ? n : null; }, 90000, 2000);
      if (after === null || after === undefined) throw new Error(`service worker list-audio stayed below ${want} entries after 90 s (before ${before}, last ${await swAudioCount(bp)})`);
      await bp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await sleep(4000);
      if (await card.count()) throw new Error("first-pack-card shown again on /home after the pack was launched");
      parts.push(`tap: plan ${plan.count} tracks / ${plan.seconds} s, Espace card via ${shown}, list-audio ${before} -> ${after}, card gone`);
    } finally { await bctx.close(); }
    return parts.join("; ");
  }, { budgetMs: 210000 }); // c51d: two playbacks (search load + click + sound) added to the 150 s budget

  await c48step("install_hint_after_sound", async () => {
    const ictx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: IPHONE_UA });
    try {
      await ictx.addInitScript(mediaHook);
      const ip = await ictx.newPage();
      const bar = ip.locator('[data-testid="install-hint"]');
      await ip.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await sleep(3000);
      if (await bar.count()) throw new Error("install-hint shown on the first paint of /home (before any sound)");
      const row = await playLibrarySong(ip, URL, QUERY, pollUntil);
      await sleep(2500);
      if (await bar.count()) throw new Error("install-hint shown on the search page before any sound");
      const m0 = await clickRowAndWaitForSound(ip, row, pollUntil);
      await bar.waitFor({ state: "visible", timeout: 15000 }).catch(() => { throw new Error("install-hint absent 15 s after the first sound (iPhone UA, nothing snoozed)"); });
      const how = await ip.locator('[data-testid="install-hint-how"]').count();
      const text = ((await bar.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!how) throw new Error(`install-hint without its "Comment installer ?" link: "${text.slice(0, 80)}"`);
      return `no bar on first paint (home, search); bar after the first sound (media t=${m0.t.toFixed(1)} s): "${text.slice(0, 60)}"`;
    } finally { await ictx.close(); }
  }, { budgetMs: 90000 });

  await c48step("account_form_keeps_input", async () => {
    const lctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      await lctx.addInitScript(mediaHook);
      const lp = await lctx.newPage();
      const name = "harness-c48-" + Date.now().toString(36);
      const row = await playLibrarySong(lp, URL, QUERY, pollUntil);
      const m0 = await clickRowAndWaitForSound(lp, row, pollUntil);
      await spaNavigate(lp, "/library/account");
      const input = lp.locator('main input[placeholder*="prénom" i]').first();
      await input.waitFor({ state: "visible", timeout: 15000 });
      await input.fill(name);
      await sleep(1000);
      const dom = await lp.evaluate(() => ({ mains: document.querySelectorAll("main").length, inputs: document.querySelectorAll('main input[placeholder*="prénom" i]').length }));
      if (dom.mains !== 1 || dom.inputs !== 1) throw new Error(`page mounted more than once: ${dom.mains} <main>, ${dom.inputs} name inputs 1 s after the navigation`);
      await sleep(4000);
      const value = await input.inputValue().catch(() => "");
      const enabled = await lp.locator('main form button[type="submit"]').first().isEnabled().catch(() => false);
      if (value !== name) throw new Error(`login name wiped: input value ${JSON.stringify(value)} 5 s after ONE fill (expected ${JSON.stringify(name)})`);
      if (!enabled) throw new Error("login submit still disabled 5 s after the fill");
      const m1 = await mediaOf(lp);
      if (!m1 || m1.paused || !(m1.t > m0.t)) throw new Error("playback stopped across the navigation: " + JSON.stringify(m1));
      return `one fill, value kept 5 s later, submit enabled, 1 <main>, media ${m0.t.toFixed(1)} -> ${m1.t.toFixed(1)} s`;
    } finally { await lctx.close(); }
  }, { budgetMs: 90000 });
}

module.exports = { run, C48_SKIP, STEP_NAMES };
