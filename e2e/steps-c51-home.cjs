// steps-c51-home.cjs: cycle 51 harness addition for harness-core.cjs (audit UX v13, lane c51c: U13-4, U13-5,
// U13-3, U13-6, U13-10, U13-11). Spliced into harness-core.cjs after the c48 steps with:
//   try { await require("./steps-c51-home.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, gotoQuiet, waitQuiet, tier: TIER, fixtures: FIX }); }
//   catch (e) { console.log("FAIL steps-c51-home (module)", String(e && e.message || e).split("\n")[0]); }
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C51_SKIP (exported Set) lists step names to skip; env C51_SKIP="a,b" adds to it and
// C51_STEPS_ENABLED=0 skips them all. Rule (c47a): a new step is played ALONE (HARNESS_ONLY=<name>) before it
// enters a chain. Steps (each in a fresh phone context, 390x844: an anonymous profile without history):
//   home_today_header         U13-4: /home paints ONE "Aujourd'hui" header ([data-testid=today-row], one .h2, one
//                             one steady subtitle, B9-27) holding both tiles ([album-of-day] and [artist-of-day]);
//                             no "Album du jour" / "Artiste du jour" heading is left; [first-pack-card] is absent 5 s
//                             after the first paint (no sound yet), then "Écouter" on the album tile starts playback
//                             (media src, t > 0.5) and the card appears within 45 s ("Emporte 1 h de musique").
//   artist_alias_chips_folded U13-3: the largest group of GET /api/v1/local/artists/aliases whose credits dedupe to
//                             more than 3 chips (ft./feat./featuring, accents, "&"/"and" folded as the API does);
//                             its primary page shows at most 3 [artist-alias-chip] and a [artist-aliases-more]
//                             toggle "+N autres" (aria-expanded false), the [artist-aliases] box under 160 px tall;
//                             the tap shows 3 + N chips and "Replier"; no chip repeats the page's name before "ft.".
//   about_lint_links          U13-10 / U13-11: the three /about counters ([about-lint-no-year], [about-lint-genres-rare],
//                             [about-lint-artist-groups]) are links (>= 44 px tall) to /library/albums?filter=no-year,
//                             /library/genres#rares and /library/artists?collapse=1; /library/genres#rares opens the
//                             fold ([genres-rare-toggle] aria-expanded true, [genres-rare-list] shown) whose "(N)"
//                             matches the rows of the fold.
const fs = require("fs");
const path = require("path");

const C51_SKIP = new Set();
const STEP_NAMES = ["home_today_header", "artist_alias_chips_folded", "about_lint_links"];
const MIN_TAP = 44;
const ALIAS_CHIPS_SHOWN = 3;

const loadFixtures = () => require("./harness-lib.cjs").loadFixtures();

// Same play() hook as harness-core.cjs: window.__ytmMedia IS the element (deps.media reads it as one).
function mediaHook() {
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return o.apply(this, arguments); };
}

async function mediaOf(p) {
  return p.evaluate(() => {
    const m = window.__ytmMedia;
    const el = (m && typeof m.currentTime === "number" ? m : null) || (m && m.el) || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}

const fmtBox = (b) => (b ? `${b.width.toFixed(0)}x${b.height.toFixed(0)}` : "no box");
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

// The chip key of the API (aliasDisplayKey, backend/api/local_artist_alias.go): case, accents, "ft." / "feat." /
// "featuring" as one word, "&" = "and", punctuation and spacing. Used to predict how many chips a group yields.
function aliasDisplayKey(name) {
  let s = String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/\b(?:feat|ft|featuring)\b\.?/g, " feat ");
  s = s.replace(/&/g, " and ").replace(/'/g, "");
  s = s.replace(/[^a-z0-9]+/g, " ");
  return s.trim().split(/\s+/).filter(Boolean).join(" ");
}
function distinctChips(group) {
  const seen = new Set();
  for (const a of group.aliases || []) {
    const k = aliasDisplayKey(a.name) || String(a.name || "").toLowerCase();
    if (k && k !== aliasDisplayKey(group.name)) seen.add(k);
  }
  return seen.size;
}

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const media = deps.media || mediaOf;
  const enabled = process.env.C51_STEPS_ENABLED !== "0";
  const skip = new Set([...C51_SKIP, ...String(process.env.C51_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c51step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const phone = () => newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  void FIX;

  await c51step("home_today_header", async () => {
    const mctx = await phone();
    try {
      await mctx.addInitScript(mediaHook);
      const mp = await mctx.newPage();
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const parts = [];

      // 1. One "Aujourd'hui" header, both tiles under it, the old per-card headings gone.
      const row = mp.locator('[data-testid="today-row"]');
      await row.waitFor({ state: "visible", timeout: 25000 }).catch(() => { throw new Error("no [data-testid=today-row] on /home within 25 s (album / artist of the day not painted under one header)"); });
      const head = await mp.evaluate(() => {
        const r = document.querySelector('[data-testid="today-row"]');
        const h2 = Array.from(r.querySelectorAll(".h2")).map((e) => (e.textContent || "").trim());
        const subs = Array.from(r.querySelectorAll(".subheading")).map((e) => (e.textContent || "").trim());
        const stray = Array.from(document.querySelectorAll(".h2, h2")).map((e) => (e.textContent || "").trim()).filter((t) => /^(Album du jour|Artiste du jour)$/.test(t));
        const album = r.querySelector('[data-testid="album-of-day"]');
        const artist = r.querySelector('[data-testid="artist-of-day"]');
        const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
        return { h2, subs, stray, tiles: r.getAttribute("data-tiles"), album: box(album), artist: box(artist), playBtn: !!r.querySelector('[data-testid="album-of-day-play"]'), openLink: !!r.querySelector('[data-testid="artist-of-day-open"]') };
      });
      if (head.h2.length !== 1 || head.h2[0] !== "Aujourd'hui") throw new Error(`today-row headings ${JSON.stringify(head.h2)} (expected exactly ["Aujourd'hui"])`);
      if (head.subs.length !== 1) throw new Error(`today-row subtitles ${JSON.stringify(head.subs)} (expected one)`);
      // B9-27 (c52a): the subtitle is now one steady line ("Le meme pour tout le monde, un autre a minuit (UTC+2)"), no "demain".
      if (!/un autre \u00e0 minuit/.test(head.subs[0])) throw new Error(`today-row subtitle "${head.subs[0]}" (expected the steady "un autre a minuit" line, B9-27)`);
      if (head.stray.length) throw new Error(`per-card headings still painted: ${JSON.stringify(head.stray)}`);
      if (!head.album || head.album.h < 40) throw new Error(`album-of-day tile missing or flat inside today-row (${JSON.stringify(head.album)})`);
      if (!head.artist || head.artist.h < 40) throw new Error(`artist-of-day tile missing or flat inside today-row (${JSON.stringify(head.artist)}, data-tiles=${head.tiles})`);
      if (head.tiles !== "2") throw new Error(`today-row data-tiles=${head.tiles} (expected 2)`);
      if (!head.playBtn || !head.openLink) throw new Error(`tile actions missing: album play ${head.playBtn}, artist Voir ${head.openLink}`);
      parts.push(`one "Aujourd'hui" header, subtitle "${head.subs[0].slice(0, 50)}…", tiles album ${head.album.w}x${head.album.h} + artist ${head.artist.w}x${head.artist.h}`);

      // 2. U13-4 (a): no "Emporte 1 h" card before any sound of the session.
      await sleep(5000);
      const card = mp.locator('[data-testid="first-pack-card"]');
      if (await card.count()) throw new Error("first-pack-card painted before any sound (fresh context, 5 s after load)");
      parts.push("no first-pack-card before a sound (5 s)");

      // 3. A sound (the album tile's "Écouter"), then the card.
      await mp.locator('[data-testid="album-of-day-play"]').click({ timeout: 8000 });
      const m0 = await pollUntil(async () => { const m = await media(mp); return m && m.src && m.t > 0.5 ? m : null; }, 40000, 500);
      if (!m0) throw new Error("playback did not start from the album-of-day tile (no media src / currentTime)");
      await card.waitFor({ state: "visible", timeout: 45000 }).catch(() => { throw new Error(`first-pack-card absent 45 s after the first sound (media t=${m0.t.toFixed(1)} s)`); });
      const text = squash(await card.innerText().catch(() => ""));
      if (!/Emporte 1 h de musique/.test(text)) throw new Error(`first-pack-card text "${text.slice(0, 60)}" (expected "Emporte 1 h de musique")`);
      const cb = await card.boundingBox();
      parts.push(`card after the first sound (media t=${m0.t.toFixed(1)} s): ${fmtBox(cb)}`);
      return parts.join("; ");
    } finally { await mctx.close(); }
  }, { budgetMs: 120000 });

  await c51step("artist_alias_chips_folded", async () => {
    const mctx = await phone();
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const api = await mp.evaluate(async () => { const r = await fetch("/api/v1/local/artists/aliases?limit=50", { cache: "no-store" }); return { status: r.status, body: await r.json().catch(() => null) }; });
      if (api.status !== 200 || !api.body || !Array.isArray(api.body.groups)) throw new Error(`aliases API ${api.status}: ${JSON.stringify(api.body).slice(0, 120)}`);
      const groups = api.body.groups.map((g) => ({ g, chips: distinctChips(g) })).filter((x) => x.chips > ALIAS_CHIPS_SHOWN).sort((a, b) => b.chips - a.chips);
      if (!groups.length) require("./harness-lib.cjs").skip(`no artist group with more than ${ALIAS_CHIPS_SHOWN} distinct credits in this library (${api.body.groups.length} groups, largest: ${api.body.groups[0] ? api.body.groups[0].name + " size " + api.body.groups[0].size : "none"}): nothing to fold`);
      const { g, chips: expected } = groups[0];

      await mp.goto(URL + "/artist/" + encodeURIComponent(g.id), { waitUntil: "load", timeout: 45000 });
      const nav = mp.locator('[data-testid="artist-aliases"]');
      await nav.waitFor({ state: "visible", timeout: 25000 }).catch(() => { throw new Error(`no [data-testid=artist-aliases] on /artist/${g.id} (${g.name}, ${g.size} credits)`); });
      const chipLoc = mp.locator('[data-testid="artist-alias-chip"]');
      const toggle = mp.locator('[data-testid="artist-aliases-more"]');
      const shown = await chipLoc.count();
      if (shown > ALIAS_CHIPS_SHOWN) throw new Error(`${shown} alias chips painted folded on ${g.name} (expected <= ${ALIAS_CHIPS_SHOWN})`);
      if (!(await toggle.count())) throw new Error(`no "+N autres" toggle on ${g.name} (${expected} distinct credits expected, ${shown} chips shown)`);
      const label = squash(await toggle.innerText());
      const m = label.match(/^\+(\d+) autres?$/);
      if (!m) throw new Error(`toggle label "${label}" (expected "+N autres")`);
      const hidden = Number(m[1]);
      if (shown + hidden !== expected) throw new Error(`${shown} chips + ${hidden} hidden = ${shown + hidden} on ${g.name}, the API's ${g.aliases.length} credits dedupe to ${expected} (ft./feat./featuring spellings must be one chip)`);
      if ((await toggle.getAttribute("aria-expanded")) !== "false") throw new Error("toggle aria-expanded is not false while folded");
      const box = await nav.boundingBox();
      if (!box || box.height >= 160) throw new Error(`[artist-aliases] ${fmtBox(box)} folded at 390 px (expected under 160 px tall)`);
      const tb = await toggle.boundingBox();
      if (!tb || tb.height < MIN_TAP) throw new Error(`toggle ${fmtBox(tb)} (expected height >= ${MIN_TAP})`);
      const primary = String(g.name || "").toLowerCase();
      const labels = await chipLoc.allInnerTexts();
      const repeated = labels.map(squash).filter((t) => t.toLowerCase().startsWith(primary) && /\b(ft|feat|featuring)\b/i.test(t.slice(primary.length)));
      if (repeated.length) throw new Error(`chips still repeat the page's name before the credit: ${JSON.stringify(repeated)}`);

      await toggle.click({ timeout: 8000 });
      const opened = await pollUntil(async () => { const n = await chipLoc.count(); return n === expected ? n : null; }, 8000, 250);
      if (opened === null || opened === undefined) throw new Error(`${await chipLoc.count()} chips after the tap (expected ${expected})`);
      const after = squash(await toggle.innerText());
      if (after !== "Replier" || (await toggle.getAttribute("aria-expanded")) !== "true") throw new Error(`toggle after the tap: "${after}" aria-expanded=${await toggle.getAttribute("aria-expanded")} (expected "Replier", true)`);
      return `${g.name}: ${g.aliases.length} credits -> ${expected} chips, folded ${shown} + "${label}" (${fmtBox(box)}), open ${opened}, labels ${JSON.stringify(labels.map(squash).slice(0, 3))}`;
    } finally { await mctx.close(); }
  }, { budgetMs: 90000 });

  await c51step("about_lint_links", async () => {
    const mctx = await phone();
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/about", { waitUntil: "load", timeout: 45000 });
      const lint = mp.locator('[data-testid="about-library-lint"]');
      await lint.waitFor({ state: "visible", timeout: 25000 }).catch(() => { throw new Error("no [data-testid=about-library-lint] on /about within 25 s (lint failed or not painted)"); });
      const want = {
        "about-lint-no-year": "/library/albums?filter=no-year",
        "about-lint-genres-rare": "/library/genres#rares",
        "about-lint-artist-groups": "/library/artists?collapse=1",
      };
      const parts = [];
      for (const [tid, target] of Object.entries(want)) {
        const a = mp.locator(`[data-testid="${tid}"] a[href]`).first();
        if (!(await a.count())) throw new Error(`${tid}: no link (expected a[href="${target}"])`);
        const href = await a.getAttribute("href");
        const u = new globalThis.URL(href, URL);
        const got = u.pathname + u.search + u.hash;
        if (got !== target) throw new Error(`${tid}: href ${got} (expected ${target})`);
        const b = await a.boundingBox();
        if (!b || b.height < MIN_TAP) throw new Error(`${tid}: link ${fmtBox(b)} (expected height >= ${MIN_TAP})`);
        parts.push(`${tid} -> ${got} (${fmtBox(b)}, "${squash(await a.innerText()).slice(0, 30)}")`);
      }

      // U13-11: the genres link lands on the open fold, its "(N)" = the rows of the fold.
      await require("./harness-lib.cjs").requireRareGenre(URL);
      await mp.goto(URL + "/library/genres#rares", { waitUntil: "load", timeout: 45000 });
      const tg = mp.locator('[data-testid="genres-rare-toggle"]');
      await tg.waitFor({ state: "visible", timeout: 25000 }).catch(() => { throw new Error("no [genres-rare-toggle] on /library/genres#rares (no rare genre, or the page did not load)"); });
      const open = await pollUntil(async () => ((await tg.getAttribute("aria-expanded")) === "true" ? true : null), 10000, 250);
      if (!open) throw new Error("#rares did not open the fold (aria-expanded stays false)");
      const list = mp.locator('[data-testid="genre-list-rare"]');
      await list.waitFor({ state: "visible", timeout: 5000 });
      const rows = await list.locator("li").count();
      const tl = squash(await tg.innerText());
      const n = Number((tl.match(/\((\d+)\)/) || [])[1]);
      if (!(n >= 1) || n !== rows) throw new Error(`fold label "${tl}" vs ${rows} rare rows`);
      const topLink = mp.locator('[data-testid="genres-rare-link"]');
      if (!(await topLink.count())) throw new Error("no header link [genres-rare-link] to the fold");
      parts.push(`#rares opened: "${tl}" = ${rows} rows, header link present`);
      return parts.join("; ");
    } finally { await mctx.close(); }
  }, { budgetMs: 90000 });
}

module.exports = { run, C51_SKIP, STEP_NAMES, aliasDisplayKey };
