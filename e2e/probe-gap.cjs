// probe-gap v2 (B7-18 / B9-24, lanes c44c then c53c): mesure du trou entre deux morceaux d une file LOCALE.
// Un enchainement n -> n+1 = le premier `playing` d une piste dont la cle de `src` (pathname+search) differe
// de la piste en cours (le lecteur enchaine AVANT `ended`, sur `timeupdate` ~1 s avant la fin : v1 a vu 9/10
// enchainements sans `ended`, v2 20/20). Le son s arrete quand le lecteur change le src du MEME element media
// (algorithme de chargement : `emptied` + `timeupdate` de remise a zero, ct 0, duration NaN, currentSrc encore
// l ancien) : ce marqueur est l instant du changement. Le trou (`gapMs`) = performance.now() du `playing` de
// n+1 moins ce marqueur (= le silence entendu). `lastRealMs` = depuis le dernier evenement de n avec une duree
// finie (borne haute, resolution ~250 ms du `timeupdate`) ; `cutBeforeEndMs` = son de n non joue (duree moins
// la position au marqueur, extrapolee depuis le dernier `timeupdate` reel) ; `lastEvent` = ce dernier evenement
// reel (`ended` jamais vu : le lecteur n attend pas la fin). Deux passes sur la meme file : passe 1 = pistes non mises en cache par
// le SW (contexte neuf), passe 2 = memes pistes, mises en cache (`cache-audio` du SW, cache `ytm-offline-audio`) ;
// chaque enchainement est classe `cached` / `uncached` d apres l etat REEL du cache au moment du `playing`.
// Depart : album de fixture (`localAlbumId`) par "Tout lire" ; au-dela des pistes de l album la file continue
// avec des pistes liees (continueLocalQueue, ON par defaut). Chaque piste est avancee a (duree - TAIL s) une
// fois `canplay` vu (readyState >= 2) : TAIL = 20 s (pas 8 : la fin d un FLAC servi par Range met plus de 8 s
// a se charger, B9-24). Le prefetch de la piste suivante est programme au DEBUT de la piste (sessionList
// updatePosition), il n est donc pas court-circuite par le saut.
// Lecture seule cote serveur. Sortie : mediane et p90 par classe sur stdout, /e2e/out/probe-gap.json (ecrit
// aussi apres la passe 1, pour qu un timeout du run laisse les chiffres de la passe 1).
//   cd /srv/beatbump/e2e && timeout 900 ./run.sh https://staging-music.ekaii.fr "daft punk" probe-gap.cjs
// Options (argv, run.sh ne transmet que --url/--out/--query/--repeat/--resolver ; les autres via env) :
//   --url=  --out=  --resolver=   GAP_TRANSITIONS (10)  GAP_TAIL (20 s)  GAP_WAIT (60 s sans enchainement = passe
//   arretee)  GAP_BUDGET (780 s pour tout le run : la passe 1 s arrete a 45 %, la passe 2 a la fin moins 20 s)
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const FIX = require("/e2e/fixtures.json");
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith("--" + k + "=")); return a ? a.split("=").slice(1).join("=") : d; };
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const OUT_DIR = arg("out", "/e2e/out");
const RESOLVER = arg("resolver", "MAP *.ekaii.fr 127.0.0.1, MAP *.example.org 127.0.0.1");
const TRANSITIONS = parseInt(process.env.GAP_TRANSITIONS || "10", 10) || 10;
const TAIL = parseFloat(process.env.GAP_TAIL || "20") || 20;
const WAIT_MS = (parseInt(process.env.GAP_WAIT || "60", 10) || 60) * 1000;
const BUDGET_MS = (parseInt(process.env.GAP_BUDGET || "780", 10) || 780) * 1000;
const OUT_JSON = "/e2e/out/probe-gap.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log("[gap " + ((Date.now() - t0) / 1000).toFixed(1) + "s]", ...a);

// Hook (addInitScript) : chaque element media passe par play() est instrumente une fois ; les evenements
// (timeupdate compris : ~4/s, c est le dernier signe de vie d une piste enchainee sans `ended`) sont
// horodates avec performance.now() et le src du moment. Les reponses `audio-cached` du SW sont comptees.
const HOOK = () => {
  window.__gap = { events: [], hooked: 0, cached: [] };
  const EVS = ["loadstart", "waiting", "canplay", "playing", "pause", "ended", "emptied", "error", "stalled", "timeupdate", "seeked"];
  const hook = (el) => {
    if (!el || el.__gapHooked) return;
    el.__gapHooked = true;
    el.__gapId = ++window.__gap.hooked;
    for (const ev of EVS) el.addEventListener(ev, () => {
      window.__gap.events.push({ ev, id: el.__gapId, t: performance.now(), src: el.currentSrc || el.src || "", ct: el.currentTime, dur: el.duration });
    });
  };
  window.__gapHook = hook;
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; hook(this); return orig.apply(this, arguments); };
  try { navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "audio-cached") window.__gap.cached.push({ url: e.data.url, ok: e.data.ok, reason: e.data.reason || null, already: !!e.data.already }); }); } catch {}
};

// v2.1 : globalThis.URL, le const URL de ce module (chaine) masquait le constructeur et `key` rendait le src entier,
// d ou isCached toujours faux (v1 "0/1 en cache", v2 run 1 "0/11" malgre 25 reponses audio-cached ok).
const key = (src) => { try { const u = new globalThis.URL(src, URL); return u.pathname + u.search; } catch { return src; } };
const quantile = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1)); return s[i]; };
const stats = (arr) => ({ n: arr.length, median: quantile(arr, 0.5), p90: quantile(arr, 0.9), min: arr.length ? Math.min(...arr) : null, max: arr.length ? Math.max(...arr) : null });
const r1 = (x) => Math.round(x * 10) / 10;

async function mediaState(page) {
  return page.evaluate(() => {
    const el = window.__ytmMedia || document.querySelector("audio,video");
    if (el && window.__gapHook) window.__gapHook(el);
    if (!el) return null;
    return { src: el.currentSrc || el.src || "", ct: el.currentTime, dur: el.duration, paused: el.paused, ended: el.ended, rs: el.readyState };
  });
}
async function isCached(page, src) {
  return page.evaluate(async (k) => {
    try {
      const c = await caches.open("ytm-offline-audio");
      const keys = await c.keys();
      return keys.some((r) => { const u = new URL(r.url); return u.pathname + u.search === k; });
    } catch { return false; }
  }, key(src));
}
async function drainEvents(page) {
  return page.evaluate(() => { const e = window.__gap ? window.__gap.events.splice(0) : []; return e; });
}
// SPA navigation (pas de rechargement : le lecteur survit) : SvelteKit intercepte le clic d un <a>.
async function spaGoto(page, href) {
  await page.evaluate((h) => { const a = document.createElement("a"); a.href = h; a.style.display = "none"; document.body.appendChild(a); a.click(); a.remove(); }, href);
  await sleep(1500);
}

// Une passe : joue jusqu a TRANSITIONS enchainements a partir de l etat courant (une piste en lecture) et
// renvoie les transitions {from, to, gapMs, lastEvent, endedSeen, cutBeforeEndMs, switchMs, cachedTo, cachedFrom,
// sample}. Le DERNIER evenement de la piste n exclut le `timeupdate` de remise a zero que l algorithme de
// chargement declenche quand le lecteur change de src (ct 0, duration NaN, currentSrc encore l ancien) : il
// marque l instant du changement (`switchMs` = de ce marqueur, ou du premier evenement de la piste n+1, au
// `playing`), pas la fin du son. `sample` = les 4 derniers evenements de n et les 4 premiers de n+1 (dt en ms
// par rapport au `playing`, id = element media).
const isReal = (e) => isFinite(e.dur) && e.dur > 0;
async function runPass(page, label, firstSrc, deadline) {
  const transitions = [];
  let curSrc = firstSrc, seekedFor = null, lastPrev = null, firstNew = null, oldTail = [], newHead = [];
  const cachedAtStart = {};
  cachedAtStart[key(curSrc)] = await isCached(page, curSrc);
  let lastProgress = Date.now();
  while (transitions.length < TRANSITIONS && Date.now() < deadline) {
    await sleep(250);
    const evs = await drainEvents(page);
    for (const e of evs) {
      if (!e.src) continue;
      if (key(e.src) === key(curSrc)) {
        oldTail.push(e); if (oldTail.length > 4) oldTail.shift();
        if (isReal(e)) { lastPrev = e; firstNew = null; } else if (lastPrev && !firstNew) firstNew = e; // marqueur du changement
        continue;
      }
      if (!firstNew) firstNew = e;
      if (newHead.length < 4) newHead.push(e);
      if (e.ev !== "playing") continue; // loadstart/canplay de la piste suivante : pas encore de son
      const cachedTo = await isCached(page, e.src);
      const gap = firstNew ? e.t - firstNew.t : null;
      const lastReal = lastPrev ? e.t - lastPrev.t : null;
      const cut = lastPrev && firstNew ? Math.max(0, Math.round((lastPrev.dur - lastPrev.ct - (firstNew.t - lastPrev.t) / 1000) * 1000)) : null;
      const sample = [...oldTail, ...newHead].map((x) => ({ ev: x.ev, id: x.id, dt: r1(x.t - e.t), ct: isFinite(x.ct) ? r1(x.ct) : null, dur: isFinite(x.dur) ? r1(x.dur) : null, old: key(x.src) === key(curSrc) }));
      transitions.push({ n: transitions.length + 1, from: key(curSrc), to: key(e.src), gapMs: gap != null ? r1(gap) : null,
        lastEvent: lastPrev ? lastPrev.ev : null, endedSeen: !!(lastPrev && lastPrev.ev === "ended"), cutBeforeEndMs: cut, lastRealMs: lastReal != null ? r1(lastReal) : null, marker: firstNew ? firstNew.ev : null,
        sameElement: !!(lastPrev && lastPrev.id === e.id), cachedTo, cachedFrom: !!cachedAtStart[key(curSrc)], sample });
      log(label, "enchainement", transitions.length, (gap != null ? gap.toFixed(0) + " ms" : "sans marqueur"), "depuis", firstNew ? firstNew.ev : "?", lastReal != null ? "(dernier " + (lastPrev.ev) + " reel " + lastReal.toFixed(0) + " ms avant" : "", cut != null ? ", coupe a " + cut + " ms de la fin)" : ")", cachedTo ? "cache" : "reseau", key(e.src).slice(0, 60));
      cachedAtStart[key(e.src)] = cachedTo;
      curSrc = e.src; seekedFor = null; lastPrev = null; firstNew = null; oldTail = []; newHead = []; lastProgress = Date.now();
    }
    const m = await mediaState(page);
    if (!m || !m.src) continue;
    if (key(m.src) !== key(curSrc)) continue; // la nouvelle piste sera vue par son `playing`
    if (seekedFor !== key(m.src) && m.dur > TAIL + 1 && m.ct < m.dur - TAIL - 0.5 && !m.paused && m.rs >= 2) {
      seekedFor = key(m.src);
      await page.evaluate((tail) => { const el = window.__ytmMedia || document.querySelector("audio,video"); if (el && isFinite(el.duration)) el.currentTime = Math.max(0, el.duration - tail); }, TAIL);
    }
    if (m.paused && !m.ended && Date.now() - lastProgress > 8000) {
      // lecture en pause (autoplay refuse ?) : relancer une fois
      await page.evaluate(() => { const el = window.__ytmMedia || document.querySelector("audio,video"); if (el) el.play().catch(() => {}); });
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > WAIT_MS + TAIL * 1000) { log(label, "pas d enchainement depuis", WAIT_MS / 1000 + TAIL, "s : passe arretee"); break; }
  }
  if (Date.now() >= deadline && transitions.length < TRANSITIONS) log(label, "budget de la passe atteint :", transitions.length, "enchainements");
  return transitions;
}

async function startQueue(page) {
  await page.goto(URL + "/release?id=" + encodeURIComponent(FIX.localAlbumId), { waitUntil: "load", timeout: 60000 });
  const play = page.locator('[data-testid="release-play"], [data-testid="play-all"], button:has-text("Tout lire")').first();
  await play.waitFor({ state: "visible", timeout: 20000 });
  await play.click({ timeout: 5000 });
  let m = null;
  for (let i = 0; i < 120 && !(m && m.src && m.ct > 0.5 && !m.paused); i++) { await sleep(250); m = await mediaState(page); }
  if (!m || !m.src) throw new Error("rien ne joue apres Tout lire");
  return m.src;
}

function summarize(result, p1, p2, pageErrors) {
  const all = [...p1, ...p2].filter((t) => t.gapMs != null);
  const cached = all.filter((t) => t.cachedTo).map((t) => t.gapMs);
  const uncached = all.filter((t) => !t.cachedTo).map((t) => t.gapMs);
  result.byClass = { uncached: stats(uncached), cached: stats(cached), all: stats(all.map((t) => t.gapMs)) };
  result.byPass = { first: stats(p1.filter((t) => t.gapMs != null).map((t) => t.gapMs)), second: stats(p2.filter((t) => t.gapMs != null).map((t) => t.gapMs)) };
  const both = [...p1, ...p2];
  result.measured = all.length;
  result.noEnded = both.filter((t) => !t.endedSeen).length;
  result.noPrevEvent = both.filter((t) => t.gapMs == null).length;
  result.lastEvents = both.reduce((acc, t) => { const k = t.lastEvent || "none"; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  result.cutBeforeEnd = stats(both.filter((t) => t.cutBeforeEndMs != null).map((t) => t.cutBeforeEndMs));
  result.lastRealToPlaying = stats(both.filter((t) => t.lastRealMs != null).map((t) => t.lastRealMs));
  result.sameElement = both.filter((t) => t.sameElement).length;
  result.pageErrors = pageErrors.slice(0, 10);
  result.verdict = result.byClass.cached.p90 != null && result.byClass.cached.n >= 5 && result.byClass.cached.p90 < 300
    ? "p90 local en cache < 300 ms (n >= 5) : ne rien faire (brainstorm-v7 B7-18)"
    : (result.byClass.cached.n ? "p90 cache SW " + result.byClass.cached.p90 + " ms (n=" + result.byClass.cached.n + ") >= 300 ms ou n < 5 : decision technique a prendre" : "pas de mesure en cache SW : decision technique a prendre");
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), headless: true, chromiumSandbox: false,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage", ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(HOOK);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e).slice(0, 200)));
  const load1 = () => { try { return fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]; } catch { return null; } };
  const result = { version: 2.2, url: URL, album: FIX.localAlbumId, transitions: TRANSITIONS, tailSeconds: TAIL, waitSeconds: WAIT_MS / 1000, budgetSeconds: BUDGET_MS / 1000, loadAtStart: load1(), startedAt: new Date().toISOString(), passes: {}, byClass: {}, notes: [] };
  let p1 = [], p2 = [];
  try {
    // Passe 1 : contexte neuf, rien en cache.
    const first = await startQueue(page);
    await drainEvents(page);
    log("passe 1 : premiere piste", key(first).slice(0, 80));
    p1 = await runPass(page, "p1", first, t0 + BUDGET_MS * 0.45);
    result.passes.first = { transitions: p1 };
    if (p1.length < TRANSITIONS) result.notes.push("passe 1 : " + p1.length + "/" + TRANSITIONS + " enchainements (file plus courte, attente depassee ou budget)");
    summarize(result, p1, p2, pageErrors);
    fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));

    // Mise en cache des pistes jouees (le chemin du bouton "Garder hors ligne" : message cache-audio au SW).
    // v2 : si la page n est pas encore controlee par le SW (contexte neuf), on passe par registration.active.
    const srcs = [first, ...p1.map((t) => t.to)].map(key);
    const uniq = [...new Set(srcs)];
    const before = [];
    for (const s of uniq) if (await isCached(page, s)) before.push(s);
    log("cache apres passe 1 :", before.length + "/" + uniq.length, "pistes deja en cache");
    const swHow = await page.evaluate(async (list) => {
      try {
        if (!navigator.serviceWorker) return "no-sw-api";
        let target = navigator.serviceWorker.controller;
        let how = "controller";
        if (!target) { const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]); target = reg && reg.active; how = "ready.active"; }
        if (!target) return "no-sw";
        for (const u of list) target.postMessage({ type: "cache-audio", url: u, videoId: "" });
        return how;
      } catch (e) { return "error " + String(e && e.message || e).slice(0, 80); }
    }, uniq);
    log("cache-audio envoye via", swHow, "pour", uniq.length, "pistes");
    let cachedNow = 0;
    const cacheDeadline = Date.now() + 90000;
    while (Date.now() < cacheDeadline) { cachedNow = 0; for (const s of uniq) if (await isCached(page, s)) cachedNow++; if (cachedNow === uniq.length) break; await sleep(1000); }
    const replies = await page.evaluate(() => (window.__gap && window.__gap.cached) || []);
    log("cache avant passe 2 :", cachedNow + "/" + uniq.length, "; reponses audio-cached :", replies.length, "ok", replies.filter((r) => r.ok).length, replies.filter((r) => !r.ok).map((r) => r.reason).slice(0, 3).join(","));
    result.cache = { tracks: uniq.length, cachedAfterPass1: before.length, cachedBeforePass2: cachedNow, swHow, replies: replies.length, repliesOk: replies.filter((r) => r.ok).length, reasons: [...new Set(replies.filter((r) => !r.ok).map((r) => r.reason))] };
    if (cachedNow < uniq.length) result.notes.push("passe 2 : " + (uniq.length - cachedNow) + " piste(s) pas en cache (SW " + swHow + ") : classe par piste d apres l etat reel");

    // Passe 2 : meme file. Retour a la piste 0 par la file (ligne 0), sinon Tout lire a nouveau.
    await page.evaluate(() => { const el = window.__ytmMedia || document.querySelector("audio,video"); if (el) el.pause(); });
    let second = null;
    try {
      await page.locator("footer img, footer .now-playing img").first().click({ timeout: 5000 });
      await sleep(1200);
      const row0 = page.locator('[data-testid="queue-row"][data-index="0"], [data-testid="queue-row"]').first();
      await row0.waitFor({ state: "visible", timeout: 8000 });
      await row0.click({ timeout: 5000 });
      await page.keyboard.press("Escape").catch(() => {});
      let m = null;
      for (let i = 0; i < 60 && !(m && m.src && key(m.src) === key(first) && m.ct > 0.3 && m.ct < 20 && !m.paused); i++) { await sleep(250); m = await mediaState(page); }
      if (m && m.src && key(m.src) === key(first) && !m.paused) second = m.src;
    } catch (e) { log("retour en tete de file par la file impossible :", String(e).slice(0, 120)); }
    if (!second) {
      await page.keyboard.press("Escape").catch(() => {});
      await spaGoto(page, "/release?id=" + encodeURIComponent(FIX.localAlbumId));
      const play = page.locator('[data-testid="release-play"], [data-testid="play-all"], button:has-text("Tout lire")').first();
      await play.waitFor({ state: "visible", timeout: 20000 });
      await play.click({ timeout: 5000 });
      let m = null;
      for (let i = 0; i < 80 && !(m && m.src && m.ct > 0.3 && !m.paused); i++) { await sleep(250); m = await mediaState(page); }
      if (!m || !m.src) throw new Error("passe 2 : rien ne joue");
      second = m.src;
      result.notes.push("passe 2 relancee par Tout lire (la file liee peut differer de la passe 1)");
    }
    await drainEvents(page);
    log("passe 2 : premiere piste", key(second).slice(0, 80), "en cache :", await isCached(page, second));
    p2 = await runPass(page, "p2", second, t0 + BUDGET_MS - 20000);
    result.passes.second = { transitions: p2 };
    if (p2.length < TRANSITIONS) result.notes.push("passe 2 : " + p2.length + "/" + TRANSITIONS + " enchainements");

    summarize(result, p1, p2, pageErrors);
    result.loadAtEnd = load1();
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
    const f = (s) => s.n ? `n=${s.n} mediane ${s.median} ms p90 ${s.p90} ms (min ${s.min}, max ${s.max})` : "n=0";
    console.log("GAP non cache (reseau) : " + f(result.byClass.uncached));
    console.log("GAP cache SW          : " + f(result.byClass.cached));
    console.log("GAP passe 1 / passe 2 : " + f(result.byPass.first) + " / " + f(result.byPass.second));
    console.log("GAP mesures : " + result.measured + "/" + (p1.length + p2.length) + " ; sans `ended` : " + result.noEnded + " ; dernier evenement : " + JSON.stringify(result.lastEvents) + " ; coupe avant la fin : " + f(result.cutBeforeEnd) + " ; erreurs page : " + pageErrors.length);
    console.log("GAP dernier evenement reel -> playing (borne haute) : " + f(result.lastRealToPlaying) + " ; meme element media : " + result.sameElement + "/" + (p1.length + p2.length));
    console.log("GAP verdict : " + result.verdict);
    if (result.notes.length) console.log("NOTES " + result.notes.join(" | "));
    console.log("rapport: " + OUT_JSON);
  } catch (e) {
    result.error = String(e && e.stack || e).slice(0, 600);
    summarize(result, p1, p2, pageErrors);
    fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
    console.log("FATAL", result.error);
    process.exitCode = 1;
  } finally {
    await page.screenshot({ path: path.join(OUT_DIR, "probe-gap.png") }).catch(() => {});
    await browser.close().catch(() => {});
  }
})();
