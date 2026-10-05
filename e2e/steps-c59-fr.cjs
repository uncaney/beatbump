// steps-c59-fr.cjs: cycle 59 harness addition for harness-core.cjs (lane c59a, decisions 1 + 5, 11 and 13 of
// DECISIONS-PAUL.md: French everywhere, Video segment hidden, PWA named "Musique"). Spliced into harness-core.cjs
// after the c57 steps with:
//   await require("./steps-c59-fr.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX, newHarnessContext });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C59_SKIP (exported Set) lists step names to skip; env C59_SKIP="a,b" adds to it and
// C59_STEPS_ENABLED=0 skips them all. Steps (each in its own Android phone context, 390x844 2x, X-Ytm-Harness):
//   french_origin_screens  the Beatbump-origin screens carry no English UI word from DENY_WORDS: search page
//                          (filter=all), /settings, /library/account, /library, /library/songs, /explore,
//                          /trending; then a track is played from the search page, the fullscreen player is
//                          opened and the queue sheet pulled up: the panel says "Suite" (and "Similaires" when
//                          YouTube answered), no English word, and the Video / Audio segment is absent
//                          (.player-kind-wrapper count 0, decision 11). <html lang> must be "fr".
//                          YouTube data (row subtitles "Song • ...", carousel titles, "About the artist") is
//                          not translated by the app and is NOT in the list.
//   pwa_name_musique       /manifest.json name and short_name are "Musique", the document title of /home
//                          contains "Musique" (Header: "<page> - Musique"), <meta apple-mobile-web-app-title>
//                          is "Musique" and <html lang> is "fr".
const C59_SKIP = new Set([]); // enable after the standalone validation run on staging
const STEP_NAMES = ["french_origin_screens", "pwa_name_musique"];
const ANDROID = {
  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};

// English UI words of the original Beatbump screens (decision 1). Whole words, case-sensitive; the French
// screens never contain them ("Thème" is not "Theme", "Explorer" is not matched: "Explore" is a French imperative
// and is left out on purpose). "Song", "Album", "Artist" alone are YouTube subtitles and stay out. Single words that
// occur in song or episode titles ("Theme", "Shuffle", "Home", "Lyrics", "Title", "Favorite", "Search", "Results",
// "Account", "Sort", "Loading") stay out too (validation run 04/10: "The Pop Culture Shuffle", "Love Theme from
// Interstella"); the multi-word UI phrases cover those screens.
const DENY_WORDS = [
  "Your Library", "Sync Your Data", "Export Data", "Import Data", "Your Playlists", "Add New Playlist",
  "Delete All Playlists", "Your Songs", "Appearance", "Immersive Queue", "Playback", "Dedupe Automix",
  "Remember Last Track", "Sign in", "Sign In", "You're a guest", "Your name", "Settings",
  "Show All", "Showing results for", "See All", "View Artist", "Add to Playlist",
  "Start Group Session", "Download to device", "Not Playing", "Now playing", "UP NEXT", "RELATED",
  "Up Next", "Show More", "Uh-Oh", "New Group Session", "Next Step", "Unsorted", "Beatbump",
]; // "Trending" is left out: it is also a YouTube charts carousel title on /trending (data, not app copy).
const DENY_RE = new RegExp("(^|[^A-Za-z0-9_'-])(" + DENY_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")($|[^A-Za-z0-9_-])");

function mediaHook() {
  window.__ytmMedia = { plays: 0, srcs: [] };
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const m = window.__ytmMedia;
    m.plays++; m.el = this; m.src = this.currentSrc || this.src;
    if (m.src && m.srcs[m.srcs.length - 1] !== m.src) m.srcs.push(m.src);
    return o.apply(this, arguments);
  };
}

function firstHit(text) {
  const t = (text || "").replace(/\s+/g, " ");
  const m = t.match(DENY_RE);
  if (!m) return null;
  const i = t.indexOf(m[2], m.index);
  return m[2] + " in «" + t.slice(Math.max(0, i - 50), i + m[2].length + 50).trim() + "»";
}

async function run(deps) {
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const QUERY = deps.QUERY || (deps.fixtures && deps.fixtures.query) || "daft punk";
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const loginAs = deps.loginAs || (async (p, name) => p.evaluate(async (n) => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) }); try { sessionStorage.removeItem("ytm-whoami"); } catch {} return x.status; }, name));
  const enabled = process.env.C59_STEPS_ENABLED !== "0";
  const skip = new Set([...C59_SKIP, ...String(process.env.C59_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c59step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());

  async function phone() {
    const mctx = await newCtx(browser, ANDROID);
    await mctx.addInitScript(mediaHook);
    const mp = await mctx.newPage();
    return { mctx, mp };
  }

  await c59step("french_origin_screens", async () => {
    const { mctx, mp } = await phone();
    try {
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const st = await loginAs(mp, "harness-c59");
      if (!(st >= 200 && st < 300)) throw new Error(`login answered ${st}`);
      const lang = await mp.evaluate(() => document.documentElement.lang);
      if (lang !== "fr") throw new Error(`<html lang> is "${lang}", expected "fr"`);

      const hits = [];
      const paths = ["/search/" + encodeURIComponent(QUERY) + "?filter=all", "/settings", "/library/account", "/library", "/library/songs", "/explore", "/trending"];
      for (const p of paths) {
        await mp.goto(URL + p, { waitUntil: "load", timeout: 45000 });
        await sleep(1500);
        const txt = await mp.locator("body").innerText().catch(() => "");
        if (txt.replace(/\s+/g, " ").trim().length < 20) hits.push(p + ": empty body");
        const h = firstHit(txt);
        if (h) hits.push(p + ": " + h);
      }

      // Queue panel: play the first song row of the search page, open the fullscreen player, pull the sheet up.
      await mp.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "load", timeout: 45000 });
      await mp.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 15000 });
      await pollUntil(async () => { const m = await mp.evaluate(() => window.__ytmMedia); return m && m.src ? m : null; }, 30000);
      await sleep(1500);
      await mp.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 });
      await sleep(1500);
      const panel = mp.locator(".fullscreen-player-popup").first();
      await panel.waitFor({ state: "visible", timeout: 10000 });
      const segments = await mp.locator(".player-kind-wrapper").count();
      if (segments !== 0) hits.push("player: Video / Audio segment still rendered (" + segments + ")");
      const handle = mp.locator(".sheet-head .handle[role='button'], .sheet-head [role='button'], .sheet-head").first();
      if (await handle.count()) {
        await handle.tap({ timeout: 5000 }).catch(() => handle.click({ timeout: 5000 }).catch(() => {}));
        await sleep(1200);
      }
      const ptxt = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (!/\bSuite\b/i.test(ptxt)) hits.push("player: queue tab 'Suite' not found (panel text: «" + ptxt.slice(0, 160).trim() + "»)");
      const ph = firstHit(ptxt);
      if (ph) hits.push("player: " + ph);

      if (hits.length) throw new Error("English leftovers: " + hits.join("; "));
      return `${paths.length} origin screens + queue panel without English (${DENY_WORDS.length} words), lang=fr, no Video segment`;
    } finally { await mctx.close().catch(() => {}); }
  });

  await c59step("pwa_name_musique", async () => {
    const { mctx, mp } = await phone();
    try {
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      await sleep(1000);
      const r = await mp.evaluate(async () => {
        const res = await fetch("/manifest.json", { cache: "no-store" });
        const m = res.ok ? await res.json() : null;
        const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
        return {
          status: res.status, name: m && m.name, short: m && m.short_name, icons: m && Array.isArray(m.icons) ? m.icons.length : 0,
          shortcuts: m && Array.isArray(m.shortcuts) ? m.shortcuts.length : 0, title: document.title, apple: meta ? meta.getAttribute("content") : null,
          lang: document.documentElement.lang,
        };
      });
      const bad = [];
      if (r.status !== 200) bad.push("manifest " + r.status);
      if (r.name !== "Musique") bad.push("name=" + r.name);
      if (r.short !== "Musique") bad.push("short_name=" + r.short);
      if (r.icons < 2) bad.push("icons=" + r.icons);
      if (r.shortcuts < 4) bad.push("shortcuts=" + r.shortcuts);
      if (!/Musique/.test(r.title || "")) bad.push("title=" + JSON.stringify(r.title));
      if (/Beatbump/.test(r.title || "")) bad.push("title still says Beatbump");
      if (r.apple !== "Musique") bad.push("apple-mobile-web-app-title=" + r.apple);
      if (r.lang !== "fr") bad.push("lang=" + r.lang);
      if (bad.length) throw new Error(bad.join("; "));
      return `manifest Musique/Musique (${r.icons} icons, ${r.shortcuts} shortcuts), title "${r.title}", apple title Musique, lang fr`;
    } finally { await mctx.close().catch(() => {}); }
  });
}

module.exports = { run, C59_SKIP, STEP_NAMES, DENY_WORDS };
