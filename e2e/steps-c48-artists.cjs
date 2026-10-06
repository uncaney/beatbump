// steps-c48-artists.cjs: cycle 48 harness addition for harness-core.cjs (lane c48b: B8-20 artist
// aliases, display only). Spliced into harness-core.cjs after the c48 core steps with:
//   await require("./steps-c48-artists.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, gotoQuiet, tier: TIER, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
// Note: `URL` handed over is harness-core's string constant; the constructor is globalThis.URL.
// deps.media reads window.__ytmMedia as the media ELEMENT itself (currentSrc / currentTime /
// paused), so the play() hook below stores the element there, not a wrapper object.
//
// Gating: C48B_SKIP (exported Set) lists step names to skip; env C48B_SKIP="a,b" adds to it and
// C48B_STEPS_ENABLED=0 skips them all. Steps:
//   artist_aliases   GET local/artists/aliases answers >= 1 group (numeric total, groups array,
//                    each with a primary id/name and >= 1 alias). For the largest group:
//                    GET local/songs?artist=<primary>&group=1 counts >= the plain
//                    GET local/songs?artist=<primary> (and `group` >= 2 credits unioned);
//                    the primary's page (/artist/la-…) shows the "Aussi sous :" chips
//                    ([data-testid=artist-aliases], one [data-testid=artist-alias-chip] per
//                    alias, each >= 44 px tall, href /artist/la-…, text = an alias name or,
//                    c52d / U13-3 (cycle 51), its short label: a name that starts with the
//                    primary and goes on with a feat. tail is shown as "ft. <guest>"
//                    (aliasChipLabel in app/src/lib/artistAliases.ts); at most 3 chips are
//                    shown, the rest behind [data-testid=artist-aliases-more] "+N autres");
//                    the play-all bar counts the union ("N titres" >= the plain count) and
//                    a click on "Tout lire" starts playback (media src within 30 s);
//                    /library/artists (sorted so the API's first collapsed page holds a
//                    primary) shows the "+N variantes" badge in a row's .artist-stats.

const C48B_SKIP = new Set();
const STEP_NAMES = ["artist_aliases"];
const MIN_TAP = 44;

function parseIntFr(text) {
  const m = /([\d\s  ]+)/.exec(String(text || ""));
  if (!m) return null;
  const n = parseInt(m[1].replace(/[\s  ]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// c52d: the chip label rule of app/src/lib/artistAliases.ts (aliasChipLabel, U13-3), kept in step:
// a name that starts with the primary and goes on with "feat." / "ft." / "featuring" (optionally in
// brackets) is shown as "ft. <guest>"; any other name is shown whole.
const FEAT_TAIL = /^(?:\(|\[)?\s*(?:feat|ft|featuring)\b\.?\s*/i;
function aliasChipLabel(name, primary) {
  const n = String(name || "").trim();
  const p = String(primary || "").trim();
  if (!n || !p || n.toLowerCase() === p.toLowerCase()) return n;
  if (!n.toLowerCase().startsWith(p.toLowerCase())) return n;
  const rest = n.slice(p.length).trim();
  if (!FEAT_TAIL.test(rest)) return n;
  const guest = rest.replace(FEAT_TAIL, "").replace(/[\)\]]\s*$/, "").trim();
  return guest ? `ft. ${guest}` : n;
}

// play() hook: the player's media element is an Audio() outside the DOM; deps.media reads
// window.__ytmMedia as the element.
function mediaHook() {
  const o = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return o.apply(this, arguments); };
}

async function mediaOf(p) {
  return p.evaluate(() => {
    const el = window.__ytmMedia || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}

async function fetchJSON(p, url) {
  return p.evaluate(async (u) => {
    const r = await fetch(u, { cache: "no-store" });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, json };
  }, url);
}

const badgeOf = (item) => {
  const runs = Array.isArray(item && item.subtitle) ? item.subtitle : [];
  const text = runs.map((r) => (r && r.text) || "").join("");
  const m = /\+(\d+) variantes?/.exec(text);
  return m ? m[0] : "";
};

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const media = deps.media || mediaOf;
  const enabled = process.env.C48B_STEPS_ENABLED !== "0";
  const skip = new Set([...C48B_SKIP, ...String(process.env.C48B_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c48bstep = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const base = new globalThis.URL(URL).origin + "/";

  await c48bstep("artist_aliases", async () => {
    const ctx = await newCtx(browser, { ignoreHTTPSErrors: true });
    try {
      const p = await ctx.newPage();
      await p.addInitScript(mediaHook);
      await p.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const parts = [];

      // 1. The groups endpoint.
      const al = await fetchJSON(p, base + "api/v1/local/artists/aliases?limit=5");
      if (al.status !== 200 || !al.json || !Array.isArray(al.json.groups) || typeof al.json.total !== "number") throw new Error("GET local/artists/aliases: " + al.status + " " + JSON.stringify(al.json).slice(0, 120));
      // No group = no artist credited under two spellings of one name: a library precondition (SKIP), never on
      // the original production library (57 groups) where an empty answer would be a regression of the scan.
      if (al.json.total < 1 || !al.json.groups.length) require("./harness-lib.cjs").skip("no artist alias group in this library (GET local/artists/aliases total " + al.json.total + ": no artist credited under two spellings of one name)");
      const g = al.json.groups[0];
      if (!/^la-/.test(String(g.id)) || !g.name || !Array.isArray(g.aliases) || g.aliases.length < 1) throw new Error("first group malformed: " + JSON.stringify(g).slice(0, 160));
      const byId = await fetchJSON(p, base + "api/v1/local/artists/aliases?id=" + encodeURIComponent(g.aliases[0].id));
      if (byId.status !== 200 || !byId.json || !byId.json.group || byId.json.group.id !== g.id) throw new Error("?id=<alias> did not answer the group: " + byId.status + " " + JSON.stringify(byId.json).slice(0, 120));
      parts.push(`groups=${al.json.total}, "${g.name}" +${g.aliases.length}`);

      // 2. The songs union counts at least the plain list.
      const plain = await fetchJSON(p, base + "api/v1/local/songs?artist=" + encodeURIComponent(g.name) + "&limit=1");
      const union = await fetchJSON(p, base + "api/v1/local/songs?artist=" + encodeURIComponent(g.name) + "&group=1&limit=1");
      if (plain.status !== 200 || union.status !== 200) throw new Error(`local/songs HTTP ${plain.status} / group ${union.status}`);
      const plainN = Number(plain.json && plain.json.total) || 0;
      const unionN = Number(union.json && union.json.total) || 0;
      if (!(unionN >= plainN) || unionN < 1) throw new Error(`songs union ${unionN} < plain ${plainN}`);
      if (!(Number(union.json.group) >= 2)) throw new Error("group=1 unioned " + union.json.group + " credit(s), expected >= 2");
      parts.push(`songs plain=${plainN} union=${unionN} (credits ${union.json.group})`);

      // 3. The primary's page: chips and the play-all count.
      await p.goto(URL + "/artist/" + g.id, { waitUntil: "load", timeout: 45000 });
      const chips = p.locator('[data-testid="artist-aliases"] [data-testid="artist-alias-chip"]');
      await p.locator('[data-testid="artist-aliases"]').first().waitFor({ state: "visible", timeout: 20000 });
      const nChips = await chips.count();
      if (nChips < 1) throw new Error("no Aussi sous chip on " + g.id);
      // c52d (U13-3, cycle 51): a chip shows aliasChipLabel(name, primary), "ft. Daya" for
      // "The Chainsmokers ft. Daya" on The Chainsmokers' page, the full name otherwise. A chip
      // is accepted when its text is an alias name or the label of the alias its href points
      // to (else of any alias of the group).
      const names = new Set(g.aliases.map((a) => String(a.name)));
      const nameByHref = new Map(g.aliases.map((a) => ["/artist/" + String(a.id), String(a.name)]));
      const labels = new Set(g.aliases.map((a) => aliasChipLabel(String(a.name), String(g.name))));
      for (let i = 0; i < Math.min(nChips, 5); i++) {
        const c = chips.nth(i);
        const href = (await c.getAttribute("href")) || "";
        const text = ((await c.innerText()) || "").replace(/\s+/g, " ").trim();
        const box = await c.boundingBox();
        if (!/^\/artist\/la-[0-9a-f]+$/.test(href)) throw new Error(`chip ${i} href "${href}"`);
        const linked = nameByHref.get(href);
        const okText = names.has(text) || (linked ? aliasChipLabel(linked, String(g.name)) === text : labels.has(text));
        if (!okText) throw new Error(`chip ${i} text "${text}" is neither an alias of the group nor its ft. label (href ${href}${linked ? ` = "${linked}"` : ""})`);
        if (!box || box.height < MIN_TAP) throw new Error(`chip ${i} ${box ? box.height.toFixed(0) : 0}px tall (expected >= ${MIN_TAP})`);
      }
      const label = ((await p.locator('[data-testid="artist-aliases"] .aliases-label').first().innerText().catch(() => "")) || "").trim();
      if (!/^Aussi sous/.test(label)) throw new Error(`chips label "${label}" (expected "Aussi sous :")`);
      const bar = p.locator('[data-testid="play-all-bar"]').first();
      await bar.waitFor({ state: "visible", timeout: 20000 });
      const barText = ((await bar.innerText()) || "").replace(/\s+/g, " ").trim();
      const shown = parseIntFr((/([\d\s  ]+)\s*titres?/.exec(barText) || [])[1]);
      if (shown === null || shown < plainN) throw new Error(`play-all bar "${barText}" counts ${shown}, expected >= plain ${plainN}`);
      if (shown !== unionN) throw new Error(`play-all bar counts ${shown}, API union ${unionN}`);
      await bar.locator('button:has-text("Tout lire")').first().click({ timeout: 8000 });
      const m0 = await pollUntil(async () => { const m = await media(p); return m && m.src ? m : null; }, 30000, 500);
      if (!m0) throw new Error("Tout lire (group): no media src after 30 s");
      parts.push(`chips=${nChips}, Tout lire ${shown} titres (plays, src set)`);

      // 4. The Artists list: a primary row carries the "+N variantes" badge.
      let sortFor = "";
      let apiBadge = "";
      for (const s of ["albumCount:desc", "trackCount:desc", "name:asc"]) {
        const r = await fetchJSON(p, base + "api/v1/local/artists?collapse=1&limit=60&sort=" + encodeURIComponent(s));
        if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) throw new Error(`local/artists?collapse=1&sort=${s}: ${r.status}`);
        if (r.json.collapsed !== true || typeof r.json.nextOffset !== "number") throw new Error(`collapse=1 envelope: ${JSON.stringify({ collapsed: r.json.collapsed, nextOffset: r.json.nextOffset })}`);
        const hit = r.json.items.find((it) => badgeOf(it));
        if (hit) { sortFor = s; apiBadge = badgeOf(hit); break; }
      }
      if (!sortFor) throw new Error("no primary with a badge in the first collapsed page of any sort");
      await p.goto(URL + "/library/artists?sort=" + encodeURIComponent(sortFor), { waitUntil: "load", timeout: 45000 });
      const badge = p.locator(".artist-stats", { hasText: /\+\d+ variantes?/ }).first();
      await badge.waitFor({ state: "visible", timeout: 25000 });
      const badgeText = ((await badge.innerText()) || "").replace(/\s+/g, " ").trim();
      const bm = /\+(\d+) variantes?/.exec(badgeText);
      if (!bm) throw new Error(`badge row "${badgeText}"`);
      parts.push(`artists list (${sortFor}) badge "${bm[0]}" (API "${apiBadge}")`);

      return parts.join(" ; ");
    } finally { await ctx.close(); }
  }, { budgetMs: 90000 });
}

module.exports = { run, C48B_SKIP, STEP_NAMES };
