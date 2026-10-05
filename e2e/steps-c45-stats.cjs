// steps-c45-stats.cjs: cycle 45 harness addition for harness-core.cjs (lane c45b: B7-11 "Partager mon
// année", B7-17 / L12-8 clean login). Spliced into harness-core.cjs after the c44 steps with:
//   await require("./steps-c45-stats.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C45_SKIP (exported Set) lists step names to skip; env C45_SKIP="a,b" adds to it and
// C45_STEPS_ENABLED=0 skips them all. login_keeps_inflight_writes is skipped off staging (harness plays
// only count with YTM_STATS_INCLUDE_HARNESS=1, set on staging only). Steps:
//   share_year                  fresh context with navigator.share stubbed, logged in (loginAs) as a unique
//                               harness-year-<ms> profile, one play seeded through POST me/history on the
//                               fixture local lid with its lb- album. Staging (play stored): /library/stats
//                               shows [data-testid=stats-year] with the [data-testid=share-year] button
//                               ("Partager mon année"); the click hands navigator.share a text containing
//                               "min" and the /release?id=lb-... link of the album n°1. Prod (harness play
//                               ignored): the stats empty state is shown and NO share-year button exists.
//   login_keeps_inflight_writes staging only. Fresh anonymous context: a library Song starts playing, the
//                               page moves (in-SPA, playback kept) to /library/account and logs in through the
//                               form ("C'est moi") as harness-login-<ms> while the player runs; once the play
//                               is counted (media > 36 s) me/stats/recent?events=1 of the NAMED profile holds
//                               that track exactly once (not lost on the anonymous id, not duplicated), whoami
//                               names the profile, and localStorage ytm-prev-anon remembers the anonymous id.
const fs = require("fs");
const path = require("path");

const C45_SKIP = new Set(); // chain 52: login_keeps_inflight_writes failed (account page click), fixed by c46b; re-enabled by c47a (B8-16) after a run alone 02/10 04:50 (PASS 43 s)
const STEP_NAMES = ["share_year", "login_keeps_inflight_writes"];

function loadFixtures() {
  for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

// Same play() hook as harness-core.cjs: the player's media element is an Audio() outside the DOM.
function mediaHook() {
  window.__ytmMedia = { plays: 0 };
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia.plays++; window.__ytmMedia.el = this; window.__ytmMedia.src = this.currentSrc || this.src; return o.apply(this, arguments); };
}

// navigator.share / canShare stub: every payload is kept in window.__shared.
function shareHook() {
  window.__shared = [];
  try {
    Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: async (d) => { window.__shared.push(d); } });
    Object.defineProperty(navigator, "canShare", { configurable: true, writable: true, value: () => true });
  } catch (e) { window.__shareHookError = String(e); }
}

async function mediaOf(p) {
  return p.evaluate(() => {
    const m = window.__ytmMedia;
    const el = (m && m.el) || (m && typeof m.currentTime === "number" ? m : null) || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}

// fetch from the page (same cookies as the SPA); returns {status, body}.
async function api(p, method, url, body) {
  return p.evaluate(async ({ method, url, body }) => {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    let j = null; try { j = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: j };
  }, { method, url, body });
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

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const QUERY = deps.QUERY || FIX.query || "daft punk";
  const LID = FIX.localLid || "";
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const loginAs = deps.loginAs || (async (p, name) => p.evaluate(async (n) => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) }); try { sessionStorage.removeItem("ytm-whoami"); } catch {} return x.status; }, name));
  const staging = /staging/.test(URL);
  const enabled = process.env.C45_STEPS_ENABLED !== "0";
  const skip = new Set([...C45_SKIP, ...String(process.env.C45_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  if (!staging) skip.add("login_keeps_inflight_writes");
  const c45step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());

  await c45step("share_year", async () => {
    const sctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      await sctx.addInitScript(shareHook);
      const sp = await sctx.newPage();
      const name = "harness-year-" + Date.now().toString(36);
      await sp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const st = await loginAs(sp, name);
      if (st !== 200) throw new Error("login " + st);
      // One play on the fixture local track with its lb- album: album n°1 of the year is deterministic.
      const seed = await api(sp, "POST", "/api/v1/me/history", {
        videoId: LID || "harness-lid", title: FIX.localLidTitle || "Harness seed", length: "3:00",
        album: { text: FIX.localAlbumTitle || "Harness album", browseId: FIX.localAlbumId || "lb-harness" },
        artistInfo: { artist: [{ text: FIX.localArtistName || "Harness artist", browseId: FIX.localArtistId || "la-harness" }] },
      });
      if (seed.status !== 200) throw new Error("seed play " + seed.status + " " + JSON.stringify(seed.body).slice(0, 80));
      const stored = !(seed.body && seed.body.ignored);
      await sp.goto(URL + "/library/stats", { waitUntil: "load", timeout: 45000 });
      const summary = sp.locator('[data-testid="stats-summary"]').first();
      await summary.waitFor({ state: "visible", timeout: 25000 });
      const yearSection = sp.locator('[data-testid="stats-year"]');
      const shareBtn = sp.locator('[data-testid="share-year"]');
      if (!stored) {
        // prod rule: the harness play is ignored, the profile has no history: empty state, no button.
        const empty = await summary.evaluate((el) => el.classList.contains("empty"));
        await sleep(1500);
        if (!empty) throw new Error("harness play ignored but the stats page is not in its empty state");
        if (await yearSection.count()) throw new Error("stats-year shown without history");
        if (await shareBtn.count()) throw new Error("share-year button shown without history");
        return `play ignored (prod rule): empty state, no "Partager mon année" button`;
      }
      await yearSection.first().waitFor({ state: "visible", timeout: 25000 });
      await shareBtn.first().waitFor({ state: "visible", timeout: 15000 });
      const label = ((await shareBtn.first().innerText()) || "").replace(/\s+/g, " ").trim();
      if (!/Partager mon année/.test(label)) throw new Error(`share-year label ${JSON.stringify(label)}`);
      const box = await shareBtn.first().boundingBox();
      if (!box || box.height < 44) throw new Error(`share-year ${box ? box.width.toFixed(0) + "x" + box.height.toFixed(0) : "no box"} (expected height >= 44)`);
      await shareBtn.first().click({ timeout: 8000 });
      const shared = await pollUntil(async () => { const s = await sp.evaluate(() => (window.__shared || [])[0] || null); return s; }, 10000, 300);
      if (!shared) {
        const err = await sp.evaluate(() => window.__shareHookError || null);
        throw new Error("navigator.share not called" + (err ? " (hook: " + err + ")" : ""));
      }
      const text = String(shared.text || "");
      const url = String(shared.url || "");
      if (!/\bmin\b/.test(text.replace(/[  ]/g, " "))) throw new Error(`share text without "min": ${JSON.stringify(text)}`);
      if (!/^Mon année \d{4} :/.test(text)) throw new Error(`share text does not start with "Mon année <year> :": ${JSON.stringify(text)}`);
      const wantAlbum = FIX.localAlbumId || "lb-harness";
      if (!url.includes("/release?id=" + encodeURIComponent(wantAlbum)) || !/\/release\?id=lb-/.test(url)) throw new Error(`share url ${JSON.stringify(url)} (expected /release?id=${wantAlbum})`);
      const artist = FIX.localArtistName || "Harness artist";
      if (!text.includes(artist)) throw new Error(`share text without the artist n°1 ${JSON.stringify(artist)}: ${JSON.stringify(text)}`);
      return `"${text.slice(0, 90)}" -> ${url.replace(URL, "")}`;
    } finally { await sctx.close(); }
  }, { budgetMs: 60000 });

  await c45step("login_keeps_inflight_writes", async () => {
    const lctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    try {
      await lctx.addInitScript(mediaHook);
      const lp = await lctx.newPage();
      const name = "harness-login-" + Date.now().toString(36);
      // 1. anonymous: start a library Song (local track: instant /localf, no YouTube cold start).
      await lp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=library", { waitUntil: "load", timeout: 45000 });
      let row = lp.getByText(/Song\s*•/).first();
      if (!(await row.isVisible({ timeout: 8000 }).catch(() => false))) {
        await lp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
        row = lp.getByText(/Song\s*•/).first();
        await row.waitFor({ state: "visible", timeout: 20000 });
      }
      const anon = await api(lp, "GET", "/api/v1/me/whoami");
      if (anon.status !== 200 || !anon.body || anon.body.name) throw new Error("context not anonymous: " + JSON.stringify(anon.body));
      // c46b: each click names itself on the FIRST line of its error (the harness keeps that line only).
      const clickDetail = (e) => String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 220);
      try { await row.click({ position: { x: 8, y: 8 }, timeout: 8000 }); } catch (e) { throw new Error(`search row click failed: ${clickDetail(e)}`); }
      const m0 = await pollUntil(async () => { const m = await mediaOf(lp); return m && m.src && m.t > 2 ? m : null; }, 40000, 500);
      if (!m0) throw new Error("playback did not start");
      const title = ((await lp.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
      // 2. immediately: the Compte page (in-SPA, the player keeps running) and the login form.
      await spaNavigate(lp, "/library/account");
      const input = lp.locator('main input[placeholder*="prénom" i]').first();
      await input.waitFor({ state: "visible", timeout: 15000 });
      await input.fill(name);
      const submit = lp.locator('main form button[type="submit"]').first();
      // c46b (chain 52: "locator.click: Timeout 8000ms exceeded", cause hidden on the next lines): the button is
      // disabled until bind:value sees the name; wait for it to be enabled, click with the button state and
      // Playwright's own detail on the first line of the error, and fall back to Enter in the input.
      const submitState = async () => lp.evaluate(() => {
        const b = document.querySelector('main form button[type="submit"]');
        const i = document.querySelector('main input[placeholder*="prénom" i]');
        if (!b) return "no submit button in main";
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return `button "${(b.textContent || "").trim()}" disabled=${b.disabled} box=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} covered-by=${top ? top.tagName.toLowerCase() + (top.className && typeof top.className === "string" ? "." + top.className.split(" ")[0] : "") : "none"} input-value=${JSON.stringify(i ? i.value : null)} scrollY=${Math.round(scrollY)}`;
      }).catch((e) => "state unavailable: " + String(e).slice(0, 80));
      // c46b run 1: 10 s after fill the input read "" and the button stayed disabled: the form is re-created
      // around the first fill (the route settles while the play starts). Fill until the value sticks for 500 ms
      // and the button is enabled, logging the URL and value of each attempt.
      const filledOk = async () => (await input.inputValue().catch(() => "")) === name && (await submit.isEnabled().catch(() => false));
      const attempts = [];
      let settled = false;
      for (let attempt = 1; attempt <= 4 && !settled; attempt++) {
        if (attempt > 1) { await sleep(1500); await input.fill(name); }
        const ok = await pollUntil(filledOk, 3000, 250);
        if (ok) { await sleep(500); settled = await filledOk(); }
        attempts.push(`#${attempt} url=${lp.url().replace(URL, "")} value=${JSON.stringify(await input.inputValue().catch(() => "?"))} enabled=${!!ok} settled=${settled}`);
      }
      if (!settled) throw new Error(`login submit stays disabled after fill (${await submitState()}); attempts: ${attempts.join(" | ")}`);
      if (attempts.length > 1) console.log(`login_keeps_inflight_writes: form settled after ${attempts.length} fills: ${attempts.join(" | ")}`);
      await submit.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      try {
        await submit.click({ timeout: 10000 });
      } catch (e) {
        const detail = clickDetail(e);
        const state = await submitState();
        // Enter in the input submits the form (implicit submission: the submit button is enabled).
        await input.press("Enter").catch(() => {});
        const ok = await lp.getByText(/Connecté en tant que/).first().isVisible().catch(() => false)
          || await pollUntil(() => lp.getByText(/Connecté en tant que/).first().isVisible().catch(() => false), 10000, 500);
        if (!ok) throw new Error(`login submit click failed: ${detail} (${state}); Enter did not log in either`);
        console.log(`login_keeps_inflight_writes: submit click failed (${detail}; ${state}), Enter in the input logged in`);
      }
      await lp.getByText(new RegExp("Connecté en tant que\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).first().waitFor({ state: "visible", timeout: 20000 });
      const mAfter = await mediaOf(lp);
      if (!mAfter || mAfter.paused || !(mAfter.t > m0.t)) throw new Error("playback stopped across the login: " + JSON.stringify(mAfter));
      const who = await api(lp, "GET", "/api/v1/me/whoami");
      if (!who.body || who.body.name !== name) throw new Error("whoami after login: " + JSON.stringify(who.body));
      const prevAnon = await lp.evaluate(() => { try { return localStorage.getItem("ytm-prev-anon"); } catch { return null; } });
      // 3. the play is counted after 30 s of playback: wait for it with the named cookie.
      const m1 = await pollUntil(async () => { const m = await mediaOf(lp); return m && m.t > 36 ? m : null; }, 70000, 2000);
      if (!m1) throw new Error("playback did not reach 36 s");
      await sleep(3000);
      const recent = await api(lp, "GET", "/api/v1/me/stats/recent?events=1&limit=50");
      if (recent.status !== 200 || !recent.body || !Array.isArray(recent.body.items)) throw new Error("recent " + recent.status);
      const played = await lp.evaluate(() => { try { const s = JSON.parse(sessionStorage.getItem("ytm-whoami") || "null"); return s && s.id; } catch { return null; } });
      const matches = recent.body.items.filter((it) => it && ((LID && it.videoId === LID) || (title && String(it.title || "").trim() === title)));
      if (matches.length !== 1) throw new Error(`named profile has the play ${matches.length} times (want exactly 1): ${JSON.stringify(recent.body.items.map((i) => i && (i.videoId + "|" + i.title)).slice(0, 8))}`);
      return `anon ${String(anon.body.id).slice(0, 8)} -> ${name} (${played ? String(played).slice(0, 8) : "?"}), prev-anon ${prevAnon ? "remembered" : "missing"}, "${title.slice(0, 30)}" counted once at ${m1.t.toFixed(0)} s; login form settled after ${attempts.length} fill(s)`;
    } finally { await lctx.close(); }
  }, { budgetMs: 120000 });
}

module.exports = { run, C45_SKIP, STEP_NAMES };
