// steps-c44-core.cjs: cycle 44 harness addition for harness-core.cjs (lane c44a: B7-1 artist of the day,
// B7-2 "Arrive en <mois>"). Spliced into harness-core.cjs after the c43 steps with:
//   await require("./steps-c44-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C44_SKIP (exported Set) lists step names to skip; env C44_SKIP="a,b" adds to it and
// C44_STEPS_ENABLED=0 skips them all. Steps:
//   artist_of_day_stable   API: two GETs of /api/v1/local/artist-of-the-day on the same day answer the same
//                          artist id (la-…), albumCount >= 2, a YYYY-MM-DD date, ?date=<today> = no date,
//                          malformed ?date= -> 400, far past -> 400. Browser (fresh phone context, media hook):
//                          logged in as a harness profile, /home shows [data-testid=artist-of-day] and its
//                          "Ecouter" button starts playback (media src set, currentTime advancing); a fresh
//                          ANONYMOUS context shows either the card or the first-run block ([data-testid=first-run]).
//   arrived_month_row      API: /api/v1/local/albums?filter=added-month&month=2026-06 -> 400 (migration bound),
//                          month=2026-07 -> 200 with filter/month in the envelope, no month -> 200 naming a month
//                          >= 2026-07 with per-month counts. Browser: when the server's month holds >= 4 albums,
//                          /home carries [data-testid=row-arrived-month] (above the fold or behind "Plus pour
//                          toi") titled "Arrive en <mois>", unless the dedupe left it under 4 cards (reported).
const fs = require("fs");
const path = require("path");
const https = require("https");

const C44_SKIP = new Set(); // chain 47: artist_of_day_stable under diagnosis (c46b, fixed); re-enabled by c47a (B8-16) after a run alone 02/10 02:45 (PASS 4 s)
const STEP_NAMES = ["artist_of_day_stable", "arrived_month_row"];
const MONTH_MIN = "2026-07";
const ROW_MIN = 4;

function loadFixtures() {
  for (const f of [path.join(__dirname, "fixtures.json"), "/e2e/fixtures.json"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* next */ }
  }
  return {};
}

// Node-side request to Traefik on 127.0.0.1 (run.sh uses --network host) with SNI + Host (same trick as
// steps-c42-core.cjs: Playwright's request context ignores --host-resolver-rules, the box hairpin is broken).
function rawRequest(base, method, reqPath, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const host = String(base).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const t0 = Date.now();
    const req = https.request({ host: "127.0.0.1", port: 443, path: reqPath, method, servername: host, rejectUnauthorized: false, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - t0 }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs} ms ${method} ${reqPath}`)));
    req.end();
  });
}

const defaultLoginAs = async (p, name) => p.evaluate(async (n) => {
  const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  try { sessionStorage.removeItem("ytm-whoami"); } catch {}
  return x.status;
}, name);

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

const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthNameFr = (m) => { const x = /^\d{4}-(\d{2})$/.exec(m || ""); return x ? MONTHS_FR[Number(x[1]) - 1] || "" : ""; };

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const FIX = deps.fixtures || loadFixtures();
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const loginAs = deps.loginAs || defaultLoginAs;
  // c46b: harness-core's media() expects window.__ytmMedia to BE the element (its own main-page hook);
  // this module's mediaHook stores { plays, el, src }, which that reader turns into { src, t: undefined }
  // (chain 47: "artist mix not advancing: null -> undefined"). Always read through the module's own helper.
  const media = mediaOf;
  const enabled = process.env.C44_STEPS_ENABLED !== "0";
  const skip = new Set([...C44_SKIP, ...String(process.env.C44_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c44step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  const raw = (method, p, headers, timeoutMs) => rawRequest(URL, method, p, headers, timeoutMs);
  const UA = { "User-Agent": "ytm-harness-c44" };
  const phoneContext = () => newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  await c44step("artist_of_day_stable", async () => {
    const parts = [];
    // 1. API: stable within the day, bounded ?date=.
    const get = async (qs) => {
      const r = await raw("GET", "/api/v1/local/artist-of-the-day" + qs, UA, 15000);
      const j = parseJSON(r.body);
      const a = j && j.artist && typeof j.artist === "object" ? j.artist : null;
      return { status: r.status, j, id: a ? String(a.browseId || (a.endpoint && a.endpoint.browseId) || "") : "", name: j ? String(j.name || "") : "", date: (j && j.date) || "", albums: j ? Number(j.albumCount) || 0 : 0, scope: j ? String(j.scope || "") : "" };
    };
    const a = await get(""), b = await get("");
    if (a.status !== 200 || !a.id) throw new Error("artist-of-the-day: " + a.status + " " + JSON.stringify(a.j).slice(0, 160));
    if (!a.id.startsWith("la-")) throw new Error("artist of the day is not a local artist: " + a.id);
    if (b.id !== a.id) throw new Error(`artist of the day unstable: ${a.id} then ${b.id}`);
    if (a.albums < 2) throw new Error(`artist of the day has ${a.albums} album(s), expected >= 2: ${a.name}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new Error("artist-of-the-day without a YYYY-MM-DD date: " + a.date);
    const today = await get("?date=" + a.date);
    if (today.status !== 200 || today.id !== a.id) throw new Error(`?date=${a.date} (today) gives ${today.id || today.status}, no date gives ${a.id}`);
    const bad = await get("?date=not-a-date");
    if (bad.status !== 400) throw new Error("malformed ?date= status " + bad.status + " (expected 400)");
    const far = await get("?date=1970-01-01");
    if (far.status !== 400) throw new Error("?date=1970-01-01 status " + far.status + " (expected 400)");
    parts.push(`${a.date} ${a.id} (${a.name.slice(0, 24)}, ${a.albums} albums, scope ${a.scope}) twice + ?date=today; malformed/far 400`);

    // 2. Browser, named harness profile: the card is on /home and "Ecouter" plays.
    const mctx = await phoneContext();
    try {
      const mp = await mctx.newPage();
      await mp.addInitScript(mediaHook);
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const st = await loginAs(mp, "harness-c44");
      if (st !== 200) throw new Error("login harness-c44: " + st);
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const card = mp.locator('[data-testid="artist-of-day"]');
      await card.waitFor({ state: "visible", timeout: 30000 });
      const shown = await card.evaluate((el) => ({ artist: el.getAttribute("data-artist"), date: el.getAttribute("data-date"), scope: el.getAttribute("data-scope"), reason: el.getAttribute("data-reason"), title: (el.querySelector(".aod-title") || {}).textContent || "" }));
      if (!shown.artist || !shown.artist.startsWith("la-")) throw new Error("card without a local artist: " + JSON.stringify(shown));
      if (shown.scope !== "profile") throw new Error("card scope for a named profile: " + JSON.stringify(shown));
      const open = mp.locator('[data-testid="artist-of-day-open"]');
      const href = await open.getAttribute("href");
      if (!href || !href.startsWith("/artist/la-")) throw new Error('"Voir" does not open the artist page: ' + href);
      const box = await mp.locator('[data-testid="artist-of-day-play"]').boundingBox();
      if (!box || box.height < 40) throw new Error(`"Ecouter" button box ${box ? box.width + "x" + box.height : "none"}`);
      await mp.locator('[data-testid="artist-of-day-play"]').click({ timeout: 8000 });
      const m0 = await pollUntil(async () => { const m = await media(mp); return m && m.src ? m : null; }, 30000, 500);
      if (!m0) throw new Error('no media src after "Ecouter" on the artist of the day');
      const s0 = await pollUntil(async () => { const m = await media(mp); return m && m.t > 0 ? m : null; }, 20000, 500);
      await sleep(2000);
      const s1 = await media(mp);
      if (!s0 || !s1 || !(s1.t > s0.t)) throw new Error(`artist mix not advancing: ${s0 && s0.t} -> ${s1 && s1.t}`);
      const ctxLabel = await mp.evaluate(() => { const el = document.querySelector('[data-testid="playback-context"]'); return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : ""; }).catch(() => "");
      parts.push(`card ${shown.artist} "${shown.title.trim().slice(0, 24)}" (${shown.scope}/${shown.reason}), Voir -> ${href}, Ecouter plays ${s0.t.toFixed(1)}s -> ${s1.t.toFixed(1)}s${ctxLabel ? ", context " + ctxLabel.slice(0, 40) : ""}`);
    } finally { await mctx.close(); }

    // 3. Browser, fresh anonymous profile: the card (library scope) or the first-run block.
    const actx = await phoneContext();
    try {
      const ap = await actx.newPage();
      await ap.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const which = await pollUntil(async () => {
        const c = await ap.locator('[data-testid="artist-of-day"]').isVisible().catch(() => false);
        if (c) return "card";
        const f = await ap.locator('[data-testid="first-run"]').isVisible().catch(() => false);
        return f ? "first-run" : null;
      }, 30000, 500);
      if (!which) throw new Error("anonymous /home: neither the artist card nor the first-run block is visible");
      const scope = which === "card" ? await ap.locator('[data-testid="artist-of-day"]').getAttribute("data-scope") : "";
      if (which === "card" && scope !== "library") throw new Error("anonymous card scope " + scope + " (expected library)");
      parts.push(`anonymous: ${which}${scope ? " (" + scope + ")" : ""}`);
    } finally { await actx.close(); }
    return parts.join("; ");
  }, { budgetMs: 150000 });

  await c44step("arrived_month_row", async () => {
    const parts = [];
    const get = async (qs) => { const r = await raw("GET", "/api/v1/local/albums?filter=added-month" + qs, UA, 20000); return { status: r.status, j: parseJSON(r.body), ms: r.ms }; };
    // 1. API bound: June 2026 and before refused with the migration reason; the bound month answers.
    const june = await get("&month=2026-06");
    if (june.status !== 400) throw new Error("month=2026-06 status " + june.status + " (expected 400)");
    const reason = String((june.j && june.j.reason) || "");
    if (!/2026-07/.test(reason)) throw new Error("month=2026-06 refused without naming the bound: " + reason.slice(0, 120));
    const jan = await get("&month=2026-01");
    if (jan.status !== 400) throw new Error("month=2026-01 status " + jan.status + " (expected 400)");
    const july = await get("&month=" + MONTH_MIN + "&limit=5");
    if (july.status !== 200 || !july.j || july.j.filter !== "added-month" || july.j.month !== MONTH_MIN || !Array.isArray(july.j.items)) throw new Error("month=2026-07: " + july.status + " " + JSON.stringify(july.j).slice(0, 160));
    const malformed = await get("&month=juillet");
    if (malformed.status !== 400) throw new Error("month=juillet status " + malformed.status + " (expected 400)");
    // 2. The server's month pick (no month=): a month >= the bound, with the counts.
    const pick = await get("&limit=" + ROW_MIN);
    if (pick.status !== 200 || !pick.j || typeof pick.j.month !== "string" || pick.j.month < MONTH_MIN) throw new Error("no month: " + pick.status + " " + JSON.stringify(pick.j).slice(0, 160));
    const total = Number(pick.j.total) || 0;
    const months = pick.j.months && typeof pick.j.months === "object" ? pick.j.months : {};
    const early = Object.keys(months).filter((k) => k < MONTH_MIN);
    if (early.length) throw new Error("months before the bound counted: " + early.join(", "));
    parts.push(`2026-06/2026-01/juillet -> 400 (${reason.slice(0, 40)}); ${MONTH_MIN} -> ${july.j.total} albums; pick ${pick.j.month} = ${total} albums${pick.j.reason ? " (" + pick.j.reason + ")" : ""}, months ${Object.keys(months).sort().map((k) => k + ":" + months[k]).join(" ")}`);

    // 3. Browser: the row is on /home when the server's month holds >= 4 albums.
    const mctx = await phoneContext();
    try {
      const mp = await mctx.newPage();
      await mp.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
      const rowSel = '[data-testid="row-arrived-month"]';
      const findRow = async () => {
        if (await mp.locator(rowSel).count()) return "visible";
        const more = mp.locator('[data-testid="home-more-rows"]');
        if (await more.count()) {
          if ((await more.getAttribute("aria-expanded")) !== "true") await more.click({ timeout: 5000 }).catch(() => {});
          if (await mp.locator(rowSel).count()) return "folded";
        }
        return null;
      };
      const where = await pollUntil(findRow, 25000, 1000);
      if (total >= ROW_MIN) {
        if (!where) {
          // The dedupe (a card appears in one row only) can leave the row under 4 cards: then it is hidden by design.
          const rows = await mp.evaluate(() => Array.from(document.querySelectorAll("[data-row]")).map((el) => el.getAttribute("data-row")));
          if (total >= ROW_MIN + 2) throw new Error(`row-arrived-month absent while the API lists ${total} albums for ${pick.j.month}; rows: ${rows.join(",")}`);
          parts.push(`row absent with only ${total} albums (dedupe can hide it), rows: ${rows.join(",")}`);
        } else {
          const title = await mp.locator(rowSel).first().evaluate((el) => { const h = el.querySelector("h1,h2,h3,.h2,.title,header"); return (h ? h.textContent : el.textContent || "").replace(/\s+/g, " ").trim(); });
          const want = "Arrivé en " + monthNameFr(pick.j.month);
          if (!title.includes(want)) throw new Error(`row title "${title.slice(0, 60)}" does not contain "${want}"`);
          const cards = await mp.locator(rowSel + ' a[href*="/release?id=lb-"], ' + rowSel + " [data-testid=card], " + rowSel + " img").count();
          const seeAll = await mp.locator(rowSel + ' a[href*="filter=added-month"]').first().getAttribute("href").catch(() => null);
          if (!seeAll || !seeAll.includes("month=" + pick.j.month)) throw new Error('"Voir tout" of the month row without the month: ' + seeAll);
          parts.push(`row ${where} "${want}", ${cards} card nodes, Voir tout -> ${seeAll}`);
        }
      } else {
        if (where) throw new Error(`row-arrived-month shown while the API lists only ${total} album(s) for ${pick.j.month}`);
        parts.push(`no row (API total ${total} < ${ROW_MIN}), as expected`);
      }
    } finally { await mctx.close(); }
    return parts.join("; ");
  }, { budgetMs: 90000 });
}

module.exports = { run, C44_SKIP, STEP_NAMES, rawRequest, mediaHook, monthNameFr };
