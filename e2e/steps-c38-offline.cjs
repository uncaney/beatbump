// Cycle 38 offline steps (HD3), loaded by harness-offline.cjs after its own steps:
//   require("./steps-c38-offline.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, fixtures })
// Same contract as steps-c38-core.cjs: every step goes through the harness `step()` (PASS/FAIL,
// screenshot, report entry), the step names are listed in STEP_NAMES (README / RUNBOOK), each step
// can be skipped with C38_SKIP=name,name or disabled altogether with C38_STEPS_ENABLED=0.
// Read-only on the server side (nothing is pinned in the main context, nothing is uncached).
//
// Steps:
//   pack_cancel_two_tabs  tab A starts a 100 Mo pack, tab B keeps the fixture album, A cancels its pack:
//                         B's keep must still complete (ready) within 120 s.
// Runs in its OWN context (two pages in it, so one origin, one SW, two clients): in the main context
// keep_album_offline already made the fixture album "Prêt hors-ligne", and B would have nothing to do.
//
// c43d: the pack of a fresh (anonymous) profile is a random library sample, so it almost never holds
// the fixture album and the UI flow alone never exercised the shared-download case (L8-16: abort-audio
// withdraws only the sender's waiter). The step now adds a deterministic shared leg: once B has its two
// first downloads in flight, A joins them (cache-audio, same videoId) and withdraws them (abort-audio),
// which is exactly what a pack cancel does for a track both tabs want. Asserted: A's acks for those ids
// are "cancelled", B's are "ok", B ends ready. The step also carries diagnostics (B reloaded? main-frame
// navigations, the SW messages each tab sent / received, toasts, page errors), printed as a DIAG line
// and appended to a failure, so a failure names its mechanism (an SW ack reason such as "status 503" /
// "network" on B is a transient of the box or the server, not A's cancel) instead of guessing.
const fs = require("fs");
const path = require("path");

const C38_SKIP = new Set();
const STEP_NAMES = ["pack_cancel_two_tabs"];

const loadFixtures = () => require("./harness-lib.cjs").loadFixtures();

// SW audio list; the SW replies on a MessageChannel port when one is given, else by client message.
const swList = (p) => p.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  const ctl = navigator.serviceWorker.controller || reg.active;
  if (!ctl) return null;
  return await new Promise((resolve) => {
    const done = (d) => { navigator.serviceWorker.removeEventListener("message", on); resolve(d); };
    const on = (ev) => { if (ev.data && ev.data.type === "audio-list") done(ev.data); };
    navigator.serviceWorker.addEventListener("message", on);
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => done(e.data);
    ctl.postMessage({ type: "list-audio" }, [ch.port2]);
    setTimeout(() => done(null), 5000);
  });
}).then((d) => (d ? { total: (d.entries || []).length, pinned: (d.entries || []).filter((e) => e && e.pinned).length, pinnedIds: (d.entries || []).filter((e) => e && e.pinned).map((e) => e.videoId) } : null)).catch(() => null);

// c43d diagnostics tap, installed in the two-tab context before its pages exist: a per-load marker
// (a reload gives a new one), every audio message the page sends to / gets from the SW, the toasts.
const DIAG_TAP = `(() => {
  window.__c43dMark = Math.random().toString(36).slice(2);
  window.__swlog = [];
  window.__toasts = [];
  const push = (dir, d) => { try { window.__swlog.push({ t: Date.now(), dir, type: d.type, videoId: d.videoId, ok: d.ok, reason: d.reason, url: typeof d.url === "string" ? d.url : undefined }); } catch (e) {} };
  try {
    const orig = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (m, ...rest) { if (m && typeof m.type === "string" && /^(cache-audio|abort-audio|pin-audio)$/.test(m.type)) push("send", m); return orig.call(this, m, ...rest); };
  } catch (e) {}
  try {
    navigator.serviceWorker.addEventListener("message", (ev) => { const d = ev.data; if (d && typeof d.type === "string" && /^audio-(cached|aborted|pinned)$/.test(d.type)) push("recv", d); });
    navigator.serviceWorker.addEventListener("controllerchange", () => push("evt", { type: "controllerchange" }));
  } catch (e) {}
  const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType === 1) { const t = (n.innerText || "").trim(); if (t && t.length < 160 && /prêt|Annul|impossible|refus|Quota|version|service worker/i.test(t)) window.__toasts.push(t); } } });
  document.addEventListener("DOMContentLoaded", () => { try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {} });
})();`;
const swLog = (p) => p.evaluate(() => window.__swlog || []).catch(() => []);
const fmtLog = (items, max) => (items || []).slice(-max).map((e) => `${e.dir === "send" ? ">" : e.dir === "recv" ? "<" : "!"}${e.type}${e.videoId ? ":" + e.videoId : ""}${e.ok === false ? "/" + (e.reason || "ko") : e.ok === true ? "/ok" : ""}`).join(" ");
/** Last audio-cached ack per videoId in a tab's log. */
const acksById = (items) => { const m = new Map(); for (const e of items) if (e.dir === "recv" && e.type === "audio-cached" && e.videoId) m.set(e.videoId, e.ok ? "ok" : e.reason || "ko"); return m; };

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL, step } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const FIX = deps.fixtures || loadFixtures();
  const enabled = process.env.C38_STEPS_ENABLED !== "0";
  const skip = new Set([...C38_SKIP, ...String(process.env.C38_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c38step = (name, fn, opts) => (enabled && !skip.has(name) ? step(page, name, fn, opts) : Promise.resolve());

  await c38step("pack_cancel_two_tabs", async () => {
    const tctx = await newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const diag = { aNavs: [], bNavs: [], errors: [], bMark: null };
    const watch = (p, tag) => {
      p.on("framenavigated", (f) => { if (f === p.mainFrame()) (tag === "A" ? diag.aNavs : diag.bNavs).push(f.url().replace(URL, "")); });
      p.on("pageerror", (e) => diag.errors.push(tag + " pageerror " + String((e && e.message) || e).slice(0, 120)));
      p.on("console", (m) => { if (m.type() === "error") diag.errors.push(tag + " console " + m.text().slice(0, 120)); });
      p.on("requestfailed", (r) => { if (/localf|\/aud\b|\/vp\b/.test(r.url())) diag.errors.push(tag + " reqfail " + ((r.failure() && r.failure().errorText) || "") + " " + r.url().slice(0, 80)); });
    };
    const diagLine = async (a, b, shared) => {
      const [al, bl, at, bt, bMark] = await Promise.all([swLog(a), swLog(b), a.evaluate(() => window.__toasts || []).catch(() => []), b.evaluate(() => window.__toasts || []).catch(() => []), b.evaluate(() => window.__c43dMark || null).catch(() => null)]);
      const packIds = new Set(al.filter((e) => e.dir === "send" && e.type === "cache-audio" && !shared.includes(e.videoId)).map((e) => e.videoId));
      const bIds = [...new Set(bl.filter((e) => e.dir === "send" && e.type === "cache-audio").map((e) => e.videoId))];
      const inPack = bIds.filter((id) => packIds.has(id));
      const reloaded = diag.bMark && bMark && bMark !== diag.bMark;
      const aAcks = acksById(al), bAcks = acksById(bl);
      const sharedTxt = shared.map((id) => `${id} A=${aAcks.get(id) || "?"} B=${bAcks.get(id) || "?"}`).join(", ");
      const bFailed = [...bAcks].filter(([, r]) => r !== "ok").map(([id, r]) => id + "/" + r);
      return { text: `shared ids [${sharedTxt}]; B acks not ok=${JSON.stringify(bFailed)}; album ids in A's pack=${inPack.length}; B reloaded=${reloaded ? "YES" : "no"} navsB=${diag.bNavs.length}; A: ${fmtLog(al.filter((e) => e.dir !== "recv" || e.ok === false || e.type === "audio-aborted"), 12)}; B: ${fmtLog(bl.filter((e) => !(e.type === "audio-pinned" && e.reason === "not_cached") && e.type !== "pin-audio"), 16)}; toastsB=${JSON.stringify(bt.slice(-3))}; toastsA=${JSON.stringify(at.filter((t) => !/^\d+\/\d+ prêts$/.test(t)).slice(-2))}; errors=${JSON.stringify(diag.errors.slice(-5))}`, aAcks, bAcks, bFailed, reloaded };
    };
    try {
      await tctx.addInitScript(DIAG_TAP);
      const a = await tctx.newPage();
      watch(a, "A");
      // The SW must control the client before a pack / keep (cache-audio goes through it).
      await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
      const ctlA = await pollUntil(() => a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false), 15000, 500);
      if (!ctlA) { await a.reload({ waitUntil: "load" }); await sleep(1500); }
      if (!(await a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false))) throw new Error("tab A not controlled by the SW");
      const albumId = FIX.localAlbumId || await a.evaluate(async () => { const d = await (await fetch("/api/v1/local/albums?limit=1&sort=dateAdded:desc")).json(); return d && d.items && d.items[0] && d.items[0].browseId; });
      if (!albumId) throw new Error("no local album (fixtures localAlbumId missing and no API answer)");

      // A: start a 100 Mo pack (the Espace card is folded by default since c37c, U12-9).
      const tg = a.locator('[data-testid="space-toggle"]').first();
      await tg.waitFor({ state: "visible", timeout: 15000 });
      if ((await tg.getAttribute("aria-expanded")) !== "true") { await tg.click({ timeout: 5000 }); await sleep(500); }
      const size = a.locator('[data-testid="pack-size"]').first();
      await size.waitFor({ state: "visible", timeout: 10000 });
      await size.selectOption("100");
      await a.locator('[data-testid="pack-start"]').first().click({ timeout: 5000 });
      const prog = a.locator('[data-testid="pack-progress"]').first();
      await prog.waitFor({ state: "visible", timeout: 15000 });
      const packSt = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s && s !== "planning" ? s : null; }, 20000, 300);
      if (packSt !== "running") throw new Error(`pack on tab A did not run (state=${packSt}, total=${await prog.getAttribute("data-total").catch(() => "?")}): nothing to cancel`);

      // B: keep the fixture album while A's pack is still running.
      const b = await tctx.newPage();
      watch(b, "B");
      await b.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
      diag.bMark = await b.evaluate(() => window.__c43dMark || null).catch(() => null);
      const keep = b.locator('[data-testid="keep-offline"]').first();
      await keep.waitFor({ state: "visible", timeout: 20000 });
      const keepBefore = await keep.getAttribute("data-state");
      if (keepBefore === "ready") throw new Error("album already ready in a fresh context (nothing for B to do)");
      await keep.click({ timeout: 5000 });
      const keepRun = await pollUntil(async () => { const s = await keep.getAttribute("data-state").catch(() => null); return s === "running" || s === "ready" ? s : null; }, 15000, 300);
      if (!keepRun) throw new Error("keep on tab B never started (data-state=" + (await keep.getAttribute("data-state").catch(() => "?")) + ")");

      // Shared leg (c43d): A joins B's first downloads in flight (same videoId = same SW job), so the
      // withdrawal below is exercised on tracks both tabs want, whatever the random pack holds.
      const shared = (await pollUntil(async () => { const l = await swLog(b); const s = []; const seen = new Set(); for (const e of l) if (e.dir === "send" && e.type === "cache-audio" && e.videoId && !seen.has(e.videoId)) { seen.add(e.videoId); s.push({ videoId: e.videoId, url: e.url || "" }); } return s.length ? s.slice(0, 2) : null; }, 10000, 100)) || [];
      if (shared.length) {
        await a.evaluate((list) => { const c = navigator.serviceWorker.controller; for (const s of list) c.postMessage({ type: "cache-audio", url: s.url, videoId: s.videoId, pinned: true }); }, shared).catch(() => {});
        await sleep(300);
      }

      // A: cancel the pack (its own downloads stop) and withdraw its wait on the shared tracks, as the
      // pack cancel does for tracks it holds; B's keep (another client) must not be aborted.
      const stillRunning = await prog.getAttribute("data-state").catch(() => null);
      if (stillRunning !== "running") throw new Error(`pack finished before the cancel (state=${stillRunning}): scenario not exercised`);
      const t0 = Date.now();
      await a.bringToFront().catch(() => {});
      await a.locator('[data-testid="pack-cancel"]').first().click({ timeout: 5000 });
      if (shared.length) await a.evaluate((list) => { const c = navigator.serviceWorker.controller; for (const s of list) c.postMessage({ type: "abort-audio", videoId: s.videoId, url: "" }); }, shared).catch(() => {});
      const fin = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s === "cancelled" || s === "done" ? s : null; }, 6000, 200);
      if (!fin) throw new Error("pack on tab A did not stop after cancel");
      const cancelMs = Date.now() - t0;

      // B: the keep completes. Ready = data-state "ready" (all keepable tracks pinned + cached) or the
      // finished counter data-ready == data-total; the SW pinned list is reported as evidence.
      await b.bringToFront().catch(() => {});
      let idleSince = 0;
      const res = await pollUntil(async () => {
        const st = await keep.getAttribute("data-state").catch(() => null);
        const ready = Number(await keep.getAttribute("data-ready").catch(() => 0)) || 0;
        const total = Number(await keep.getAttribute("data-total").catch(() => 0)) || 0;
        if (st === "ready" || (st !== "running" && total > 0 && ready === total)) return { st, ready, total };
        // Back to idle without being ready = the job ended short (failed / aborted tracks). Wait 4 s
        // before calling it: the ready state is derived from localStorage right after the job ends.
        if (st === "idle" && keepRun === "running") { if (!idleSince) idleSince = Date.now(); else if (Date.now() - idleSince > 4000) return { st, ready, total, stopped: true }; }
        else idleSince = 0;
        return null;
      }, 120000, 2000);
      const sw = await swList(b);
      const sharedIds = shared.map((s) => s.videoId);
      const d = await diagLine(a, b, sharedIds);
      // The album's keepable ids: B pins every track first (pin-audio), downloads the "not_cached" ones.
      const bl = await swLog(b);
      const albumIds = [...new Set(bl.filter((e) => e.dir === "send" && e.type === "pin-audio" && e.videoId).map((e) => e.videoId))];
      const pinnedSet = new Set((sw && sw.pinnedIds) || []);
      const missing = albumIds.filter((id) => !pinnedSet.has(id));
      // B's own view of the shared list (ytm-offline-tracks): the flags the button's ready state reads.
      const ls = await b.evaluate((ids) => { try { const l = JSON.parse(localStorage.getItem("ytm-offline-tracks") || "[]"); return ids.map((id) => { const t = l.find((x) => x && x.videoId === id); return id + ":" + (t ? (t._cached ? "c" : "-") + (t._pinned ? "p" : "-") : "absent"); }).join(" "); } catch (e) { return "ls-err"; } }, albumIds).catch(() => "ls-?");
      const pinnedTxt = `SW pinned=${sw ? sw.pinned : "?"}/${sw ? sw.total : "?"}, album ids pinned=${albumIds.length - missing.length}/${albumIds.length}, B localStorage=[${ls}]`;
      console.log("DIAG pack_cancel_two_tabs", pinnedTxt + "; " + d.text);
      // Product property first: a shared track withdrawn by A must not come back "cancelled" to B.
      const cancelledOnB = sharedIds.filter((id) => d.bAcks.get(id) === "cancelled");
      if (cancelledOnB.length) throw new Error(`A's abort-audio cancelled B's download of ${cancelledOnB.join(",")} (SharedJobs per-owner withdrawal broken); ${pinnedTxt}; ${d.text}`);
      // (A's own ack on a shared id is "cancelled" unless its joined download landed within the 300 ms
      // before the abort, files served from the companion cache can: reported in DIAG, not asserted.)
      // The keep is complete when the SW holds every album track pinned and no download of B failed,
      // whatever the button says: its "ready" state is read once from the localStorage list, which tab A
      // rewrites concurrently (pack acks, reconcile after the cancel) and can lose B's flags (c43d app fix).
      const keepComplete = albumIds.length > 0 && !missing.length && !d.bFailed.length && !d.reloaded;
      const why = d.reloaded ? "tab B reloaded" : d.bFailed.length ? `B's downloads failed on the SW side (${d.bFailed.join(", ")}: ${/network|status 5|timeout/.test(d.bFailed.join(" ")) ? "a transient of the box or the server, see net::ERR_ / status, not A's cancel" : "not A's cancel"})` : missing.length ? `album ids not pinned in the SW: ${missing.join(",")}` : "no failed ack on B";
      const btnTxt = `${await keep.getAttribute("data-ready").catch(() => "?")}/${await keep.getAttribute("data-total").catch(() => "?")} (${await keep.innerText().catch(() => "")})`;
      if (!keepComplete) {
        if (!res) throw new Error(`keep on tab B not ready 120 s after the pack cancel: ${btnTxt}; ${why}; ${pinnedTxt}; ${d.text}`);
        if (res.stopped) throw new Error(`keep on tab B stopped before ready (${res.ready}/${res.total}, ${await keep.innerText().catch(() => "")}); ${why}; ${pinnedTxt}; ${d.text}`);
        if (res.st !== "ready") throw new Error(`keep on tab B ended ${res.st} ${res.ready}/${res.total} with ${why}; ${pinnedTxt}; ${d.text}`);
      }
      const btnNote = res && res.st === "ready" ? "" : `; BUTTON idle after the complete keep (${btnTxt}): localStorage flags lost to tab A's writes, app fix c43d pending`;
      return `pack A running -> ${fin} in ${cancelMs} ms; shared ${sharedIds.length} ids: A cancelled, B ok; keep B (${albumId}) ${keepBefore}->${keepRun}->${res ? res.st : "?"} complete (${albumIds.length - missing.length}/${albumIds.length} pinned in the SW, acks ok); ${pinnedTxt}${btnNote}`;
    } finally { await tctx.close(); }
  }, { budgetMs: 180000 });
}

module.exports = { run, C38_SKIP, STEP_NAMES, swList };
