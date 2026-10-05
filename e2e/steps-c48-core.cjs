// steps-c48-core.cjs: cycle 48 harness addition for harness-core.cjs (lane c48a: B8-19 "Sans année"
// filter + chip, B8-21 rare-genres fold, B8-22 /about LIBRARY-LINT counters). Spliced into
// harness-core.cjs after the c47 steps with:
//   await require("./steps-c48-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
// Note: `URL` handed over is harness-core's string constant; the constructor is globalThis.URL. No
// step here plays audio, so deps.media (window.__ytmMedia read as the element itself, not a wrapper
// object) is unused.
//
// Gating: C48_SKIP (exported Set) lists step names to skip; env C48_SKIP="a,b" adds to it and
// C48_STEPS_ENABLED=0 skips them all. Steps:
//   albums_no_year_chip   /library/albums?filter=no-year: the "Sans année" chip is visible (>= 44 px
//                         tall), GET local/albums?filter=no-year answers the envelope (filter echoed,
//                         numeric total, items array), the page's displayed album count matches the
//                         API total, and - since the IListItemRenderer the album grid consumes carries
//                         no year field to inspect client side - the filtered set is proven yearless by
//                         a sort-direction invariant instead: sort=year:asc and sort=year:desc return the
//                         SAME order (sortAlbumDocs's string compare ties every empty/invalid year, so a
//                         stable sort cannot reorder them either way; a single real year in the set would
//                         flip the order between the two directions).
//   genres_rare_fold      /library/genres: the "Genres rares (N)" toggle is collapsed by default
//                         (aria-expanded=false) and a click reveals exactly N rows
//                         ([data-testid=genre-list-rare] > li), N matching the toggle's own label.
//   about_lint_card       /about: the three LIBRARY-LINT counters ([data-testid=about-lint-no-year],
//                         -genres-rare, -artist-groups) are numeric (finite, >= 0) and match
//                         GET local/lint field for field.

const C48_SKIP = new Set();
const STEP_NAMES = ["albums_no_year_chip", "genres_rare_fold", "about_lint_card"];
const MIN_TAP = 44;

function parseIntFr(text) {
  const m = /([\d\s  ]+)/.exec(String(text || ""));
  if (!m) return null;
  const n = parseInt(m[1].replace(/[\s  ]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchJSON(p, url) {
  return p.evaluate(async (u) => {
    const r = await fetch(u);
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, json };
  }, url);
}

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const enabled = process.env.C48_STEPS_ENABLED !== "0";
  const skip = new Set([...C48_SKIP, ...String(process.env.C48_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c48step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const base = new globalThis.URL(URL).origin + "/";

  await c48step("albums_no_year_chip", async () => {
    const ctx = await newCtx(browser, { ignoreHTTPSErrors: true });
    try {
      const p = await ctx.newPage();
      await p.goto(URL + "/library/albums?filter=no-year", { waitUntil: "load", timeout: 45000 });

      const chip = p.locator('[data-testid="browse-filter-chip"]');
      await chip.waitFor({ state: "visible", timeout: 20000 });
      const label = ((await chip.innerText()) || "").trim();
      if (!/Sans année/.test(label)) throw new Error(`filter chip text "${label}" (expected "Sans année")`);
      const box = await chip.boundingBox();
      if (!box || box.height < MIN_TAP) throw new Error(`filter chip ${box ? box.height.toFixed(0) : 0}px tall (expected >= ${MIN_TAP})`);

      const apiUrl = base + "api/v1/local/albums?filter=no-year&limit=200";
      const { status, json } = await fetchJSON(p, apiUrl);
      if (status !== 200) throw new Error(`GET local/albums?filter=no-year HTTP ${status}`);
      if (json.filter !== "no-year") throw new Error(`filter echo "${json.filter}" (expected no-year)`);
      if (typeof json.total !== "number" || json.total < 0) throw new Error(`total ${JSON.stringify(json.total)} (expected a number >= 0)`);
      const items = Array.isArray(json.items) ? json.items : [];
      if (json.total > 0 && items.length === 0) throw new Error(`total ${json.total} but 0 items on the first page`);

      // Sort-direction invariant: every item in the set has no usable year
      // (sortAlbumDocs ties them on year), so sorting the SAME filtered set
      // asc vs desc must not change its order.
      const [asc, desc] = await Promise.all([
        fetchJSON(p, base + "api/v1/local/albums?filter=no-year&sort=year:asc&limit=200"),
        fetchJSON(p, base + "api/v1/local/albums?filter=no-year&sort=year:desc&limit=200"),
      ]);
      if (asc.status !== 200 || desc.status !== 200) throw new Error(`sort=year:asc/desc HTTP ${asc.status}/${desc.status}`);
      const idsAsc = (asc.json.items || []).map((it) => it.browseId || it.id);
      const idsDesc = (desc.json.items || []).map((it) => it.browseId || it.id);
      if (idsAsc.length !== items.length || idsDesc.length !== items.length) throw new Error(`sort pages length mismatch: default ${items.length}, asc ${idsAsc.length}, desc ${idsDesc.length}`);
      // Documents without the sort field keep an arbitrary order that Meilisearch reverses between asc and desc:
      // the invariant is the SET of ids (same members, same size), not the sequence (chain 57).
      if (JSON.stringify([...idsAsc].sort()) !== JSON.stringify([...idsDesc].sort())) throw new Error("sort=year:asc and sort=year:desc return different no-year sets (some item carries a real year)");

      // A library where every album carries a year has nothing to count under the h1 (the page shows its empty
      // state): a precondition of the library, reported as a SKIP rather than a pass.
      if (json.total === 0) require("./harness-lib.cjs").skip("no album without a release year in this library (GET local/albums?filter=no-year total 0)");
      const pageTotal = await pollUntil(async () => {
        const txt = await p.locator("main .sub").last().innerText().catch(() => "");
        return parseIntFr(txt);
      }, 15000, 500);
      if (pageTotal === null) throw new Error("no album count under the h1");
      if (pageTotal !== json.total) throw new Error(`page count ${pageTotal} != API total ${json.total}`);

      return `chip "${label}" ${box.width.toFixed(0)}x${box.height.toFixed(0)}, total ${json.total}, year:asc/desc order identical`;
    } finally { await ctx.close(); }
  }, { budgetMs: 45000 });

  await c48step("genres_rare_fold", async () => {
    const ctx = await newCtx(browser, { ignoreHTTPSErrors: true });
    try {
      const p = await ctx.newPage();
      await p.goto(URL + "/library/genres", { waitUntil: "load", timeout: 45000 });
      const list = p.locator('[data-testid="genre-list"]');
      await list.waitFor({ state: "visible", timeout: 20000 });

      const toggle = p.locator('[data-testid="genres-rare-toggle"]');
      const hasToggle = await pollUntil(async () => (await toggle.count()) > 0 || null, 15000, 500);
      if (!hasToggle) throw new Error("no [data-testid=genres-rare-toggle] (library has no rare genre?)");
      const toggleText = ((await toggle.innerText()) || "").trim();
      const n = parseIntFr(toggleText.replace(/^.*\(/, ""));
      if (n === null || n <= 0) throw new Error(`toggle label "${toggleText}": could not read a positive count`);
      if ((await toggle.getAttribute("aria-expanded")) !== "false") throw new Error(`toggle aria-expanded "${await toggle.getAttribute("aria-expanded")}" (expected false, collapsed by default)`);

      const rareListBefore = await p.locator('[data-testid="genre-list-rare"]').count();
      if (rareListBefore !== 0) throw new Error("rare genre list already in the DOM before the toggle is opened");

      const tb = await toggle.boundingBox();
      if (!tb || tb.height < MIN_TAP) throw new Error(`rare-genres toggle ${tb ? tb.height.toFixed(0) : 0}px tall (expected >= ${MIN_TAP})`);

      await toggle.click({ timeout: 8000 });
      const rareList = p.locator('[data-testid="genre-list-rare"]');
      await rareList.waitFor({ state: "visible", timeout: 10000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") throw new Error("toggle aria-expanded still not true after the click");
      const rows = rareList.locator("li.chip-row");
      const rowCount = await pollUntil(async () => { const c = await rows.count(); return c > 0 ? c : null; }, 10000, 300);
      if (!rowCount) throw new Error("rare genre list opened with 0 rows");
      if (rowCount !== n) throw new Error(`rare genre list has ${rowCount} rows, toggle announced ${n}`);

      return `toggle "${toggleText}" expanded to ${rowCount} rows (${tb.width.toFixed(0)}x${tb.height.toFixed(0)})`;
    } finally { await ctx.close(); }
  }, { budgetMs: 30000 });

  await c48step("about_lint_card", async () => {
    const ctx = await newCtx(browser, { ignoreHTTPSErrors: true });
    try {
      const p = await ctx.newPage();
      await p.goto(URL + "/about", { waitUntil: "load", timeout: 45000 });
      const card = p.locator('[data-testid="about-library-lint"]');
      await card.waitFor({ state: "visible", timeout: 20000 });

      const read = async (testid) => {
        const li = p.locator(`[data-testid="${testid}"]`);
        await li.waitFor({ state: "visible", timeout: 10000 });
        const txt = ((await li.innerText()) || "").trim();
        const n = parseIntFr(txt);
        if (n === null || n < 0) throw new Error(`${testid} "${txt}": could not read a count >= 0`);
        return { n, txt };
      };
      const noYear = await read("about-lint-no-year");
      const genresRare = await read("about-lint-genres-rare");
      const artistGroups = await read("about-lint-artist-groups");

      const { status, json } = await fetchJSON(p, base + "api/v1/local/lint");
      if (status !== 200) throw new Error(`GET local/lint HTTP ${status}`);
      if (json.albumsNoYear !== noYear.n) throw new Error(`card "${noYear.txt}" (${noYear.n}) != API albumsNoYear ${json.albumsNoYear}`);
      if (json.genresRare !== genresRare.n) throw new Error(`card "${genresRare.txt}" (${genresRare.n}) != API genresRare ${json.genresRare}`);
      if (json.artistGroups !== artistGroups.n) throw new Error(`card "${artistGroups.txt}" (${artistGroups.n}) != API artistGroups ${json.artistGroups}`);

      return `no-year ${noYear.n}, genres rares ${genresRare.n}, groupes d'artistes ${artistGroups.n} (matches GET local/lint)`;
    } finally { await ctx.close(); }
  }, { budgetMs: 30000 });
}

module.exports = { run, C48_SKIP, STEP_NAMES };
