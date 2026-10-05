// Cycle 44 offline steps (44B: B7-7 "Rafraichir mon pack", B7-8 space guard), loaded by
// harness-offline.cjs after steps-c38-offline.cjs:
//   require("./steps-c44-offline.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, fixtures })
// Same contract as steps-c38-offline.cjs: every step goes through the harness `step()` (PASS/FAIL,
// screenshot, report entry), the step names are listed in STEP_NAMES, each step can be skipped with
// C44_SKIP=name,name or disabled altogether with C44_STEPS_ENABLED=0.
// Both steps share ONE fresh context (its own origin storage, SW and anonymous profile), closed at the
// end: nothing is pinned, uncached or re-quota'd in the main context. The 100 Mo pack of pack_refresh is
// the pinned base pack_too_big measures against.
//
// Steps:
//   pack_refresh   a 100 Mo pack completes; 2 of its (pinned, cached) tracks are marked listened through
//                  the play-event path (POST me/history, what recordHistory sends; the SW entries are also
//                  fetched once so lastAccess moves); "Rafraichir mon pack" -> those 2 are uncached, new
//                  ids of the same listening time are downloaded + pinned, every other pin is intact
//                  (SW list-audio before / after). window.__ytmPackRefresh carries the plan + outcome.
//   pack_too_big   Settings quota at its minimum (500 Mo) when that is above what the context has cached,
//                  else (c46b: the 28 FLAC pins of pack_refresh weigh ~800 Mo and the selector refuses a
//                  quota under the pinned total) a quota of cached + 20 Mo set through the SW
//                  (set-audio-quota); then the longest duration (4 h) on the Espace card:
//                  [data-testid=pack-progress][data-state=too-big] with "Pas assez de place : ...", and
//                  no download. When the estimate still fits (small library / low bitrate), a custom
//                  quota (pinned + 20 Mo) is set through the SW and the pack is asked again: the leg used
//                  is reported.
const fs = require("fs");
const path = require("path");

// chain 47: both under diagnosis (c46b, fixed). c47a (B8-16): pack_too_big re-enabled after a run alone 02/10 03:17
// (PASS 2 s). pack_refresh stays gated: enable with chain 55 (the c47c preview, B8-11, is at f257daa and the
// step now clicks pack-refresh-confirm after pack-refresh; the step handles both builds, see below).
const C44_SKIP = new Set(); // chain 55: pack_refresh enabled (cycle 47 build)
const STEP_NAMES = ["pack_refresh", "pack_too_big"];
const MB = 1024 * 1024;

const loadFixtures = () => require("./harness-lib.cjs").loadFixtures();

// SW audio list (raw entries + quota); the SW replies on the MessageChannel port.
const swListRaw = (p) => p.evaluate(async () => {
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
}).catch(() => null);
/** { total, pinned, pinnedIds, ids, pinnedBytes, quota, entries } or null. */
const swList = async (p) => {
  const d = await swListRaw(p);
  if (!d) return null;
  const entries = (d.entries || []).filter((e) => e && e.videoId);
  const pinnedE = entries.filter((e) => e.pinned);
  return { total: entries.length, pinned: pinnedE.length, pinnedIds: pinnedE.map((e) => e.videoId), ids: entries.map((e) => e.videoId), pinnedBytes: Number(d.pinnedBytes) || pinnedE.reduce((s, e) => s + (Number(e.bytes) || 0), 0), quota: Number(d.quota) || 0, entries };
};
// c46b: the SW answers on event.source (a client message, type "audio-quota"), never on the MessageChannel
// port (service-worker.ts reply()); listen on both like swListRaw does.
const setQuota = (p, bytes) => p.evaluate(async (b) => {
  const reg = await navigator.serviceWorker.ready;
  const ctl = navigator.serviceWorker.controller || reg.active;
  if (!ctl) return null;
  return await new Promise((resolve) => {
    const done = (d) => { navigator.serviceWorker.removeEventListener("message", on); resolve(d && typeof d.quota === "number" ? d.quota : null); };
    const on = (ev) => { if (ev.data && ev.data.type === "audio-quota") done(ev.data); };
    navigator.serviceWorker.addEventListener("message", on);
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => done(e.data);
    ctl.postMessage({ type: "set-audio-quota", bytes: b }, [ch.port2]);
    setTimeout(() => done(null), 5000);
  });
}, bytes).catch(() => null);

async function ensureControlled(p, sleep, pollUntil) {
  const ctl = await pollUntil(() => p.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false), 15000, 500);
  if (!ctl) { await p.reload({ waitUntil: "load" }); await sleep(1500); }
  if (!(await p.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false))) throw new Error("page not controlled by the SW");
}
async function expandSpace(p, sleep) {
  const tg = p.locator('[data-testid="space-toggle"]').first();
  await tg.waitFor({ state: "visible", timeout: 15000 });
  if ((await tg.getAttribute("aria-expanded")) !== "true") { await tg.click({ timeout: 5000 }); await sleep(500); }
}
/** Starts a pack for `choice` ("100" / "dur:14400") and returns the first non-planning state. */
async function startPack(p, choice, pollUntil) {
  const size = p.locator('[data-testid="pack-size"]').first();
  await size.waitFor({ state: "visible", timeout: 10000 });
  await size.selectOption(choice);
  await p.locator('[data-testid="pack-start"]').first().click({ timeout: 5000 });
  const prog = p.locator('[data-testid="pack-progress"]').first();
  await prog.waitFor({ state: "visible", timeout: 15000 });
  const st = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s && s !== "planning" ? s : null; }, 30000, 300);
  return { prog, st };
}
const packText = (p) => p.locator("#offline-pack-text").first().innerText().catch(() => "");

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL, step } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const FIX = deps.fixtures || loadFixtures();
  void FIX;
  const enabled = process.env.C44_STEPS_ENABLED !== "0";
  const skip = new Set([...C44_SKIP, ...String(process.env.C44_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c44step = (name, fn, opts) => (enabled && !skip.has(name) ? step(page, name, fn, opts) : Promise.resolve());
  if (!enabled || (skip.has("pack_refresh") && skip.has("pack_too_big"))) return;

  // A small library finishes a pack in a second or two, before startPack() reads "running" (pack_too_big then saw
  // "done"): there every audio download is held 0.8 s (harness-lib slowAudioContext), nothing changes elsewhere.
  const slow = await require("./harness-lib.cjs").slowAudioContext(URL, () => newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } }), 800);
  const tctx = slow.ctx;
  const errors = [];
  let a = null;
  try {
    a = await tctx.newPage();
    a.on("pageerror", (e) => errors.push("pageerror " + String((e && e.message) || e).slice(0, 120)));
    a.on("console", (m) => { if (m.type() === "error") errors.push("console " + m.text().slice(0, 120)); });
    await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
    await ensureControlled(a, sleep, pollUntil);

    await c44step("pack_refresh", async () => {
      // 1. A 100 Mo pack, run to the end (the Espace card is folded by default, U12-9).
      await expandSpace(a, sleep);
      if (await a.locator('[data-testid="pack-refresh"]').count()) throw new Error("pack-refresh visible before any pack in a fresh context");
      const { prog, st } = await startPack(a, "100", pollUntil);
      if (st !== "running") throw new Error(`pack did not run (state=${st}, total=${await prog.getAttribute("data-total").catch(() => "?")}, text=${await packText(a)})`);
      const fin = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s === "done" || s === "cancelled" ? s : null; }, 300000, 2000);
      if (fin !== "done") throw new Error(`pack not done after 300 s (state=${fin}, ${await prog.getAttribute("data-ready").catch(() => "?")}/${await prog.getAttribute("data-total").catch(() => "?")})`);
      const plan = await a.evaluate(() => window.__ytmPackPlan || null);
      const ready = plan && plan.result ? plan.result.ready : -1;
      const before = await swList(a);
      if (!before) throw new Error("SW list-audio unanswered after the pack");
      const packIds = ((plan && plan.videoIds) || []).filter((id) => before.pinnedIds.includes(id));
      if (ready < 3 || packIds.length < 3) throw new Error(`pack too small to refresh: ready=${ready}, pinned pack ids=${packIds.length} (need 3: 2 listened + 1 intact); SW pinned=${before.pinned}/${before.total}`);
      const refreshBtn = a.locator('[data-testid="pack-refresh"]').first();
      await refreshBtn.waitFor({ state: "visible", timeout: 10000 });
      const remembered = Number(await refreshBtn.getAttribute("data-pack-count").catch(() => 0)) || 0;
      if (remembered !== ((plan && plan.videoIds) || []).length) throw new Error(`last pack remembered with ${remembered} tracks, plan had ${(plan.videoIds || []).length}`);

      // 2. Two pack tracks "listened". Since cycle 46 (L13-1, listenLog.ts) the refresh trusts only this
      //    device's listen log: localStorage "ytm-listen-log", an array of { videoId, at, seconds, duration }
      //    appended by Player.svelte once >= 2 min or half of the track really played here (recordListen);
      //    listenedPackIds keeps an entry dated after the pack began whose seconds reach that rule, and
      //    ignores the SW lastAccess and bare play events. The log is seeded here the way the app writes it
      //    (seconds = 120, the length-independent threshold), after the dated play of the play-event path
      //    (POST me/history, what recordHistory sends) which no longer counts on its own.
      const listened = packIds.slice(0, 2);
      const posted = await a.evaluate(async (ids) => {
        const out = [];
        for (const videoId of ids) {
          try {
            const r = await fetch("/api/v1/me/history", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId, title: "c44 listened " + videoId }) });
            out.push(videoId + ":" + r.status);
          } catch (e) { out.push(videoId + ":err"); }
        }
        return out;
      }, listened);
      const okPosts = posted.filter((s) => /:2\d\d$/.test(s)).length;
      const seeded = await a.evaluate((ids) => {
        const KEY = "ytm-listen-log";
        let log = [];
        try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); if (Array.isArray(v)) log = v; } catch { log = []; }
        const at = Date.now();
        for (const videoId of ids) log.push({ videoId, at, seconds: 120, duration: 0 });
        localStorage.setItem(KEY, JSON.stringify(log));
        return { at, size: log.length };
      }, listened);
      const packAt = Number(await a.evaluate(() => { try { return JSON.parse(localStorage.getItem("ytm-offline-pack-last") || "{}").at; } catch { return 0; } })) || 0;
      if (!(seeded.at > packAt)) throw new Error(`listen log seeded at ${seeded.at}, not after the pack began (${packAt})`);
      // getRecent memoises 5 s per tab: let it expire so the refresh reads the two new plays.
      await sleep(6000);

      // 3. "Rafraichir mon pack": the two listened tracks go, new ones of the same time come.
      const pinnedBeforeSet = new Set(before.pinnedIds);
      await refreshBtn.click({ timeout: 5000 });
      // c47a: since c47c (B8-11, _SpaceCard.svelte refreshPack / confirmRefresh, chain 55) the click computes the
      // plan and shows [data-testid=pack-refresh-preview] (window.__ytmPackRefresh.preview === true, no `applied`,
      // nothing uncached) and [data-testid=pack-refresh-confirm] runs it; before c47c the click applied at once
      // (`applied` boolean). Both builds are handled: wait for the preview OR the outcome, confirm on a preview.
      const first = await pollUntil(() => a.evaluate(() => { const r = window.__ytmPackRefresh; return r && (r.preview === true || typeof r.applied === "boolean") ? r : null; }).catch(() => null), 30000, 300);
      let previewNote = "no preview (build before c47c)";
      if (first && first.preview === true && typeof first.applied !== "boolean") {
        const pv = a.locator('[data-testid="pack-refresh-preview"]').first();
        await pv.waitFor({ state: "visible", timeout: 10000 });
        const rows = await a.locator('[data-testid="pack-refresh-row"]').count();
        previewNote = `preview ${rows} rows (data-count ${await pv.getAttribute("data-count").catch(() => "?")}) confirmed`;
        await a.locator('[data-testid="pack-refresh-confirm"]').first().click({ timeout: 5000 });
      }
      const rf = await pollUntil(() => a.evaluate(() => (window.__ytmPackRefresh && typeof window.__ytmPackRefresh.applied === "boolean") ? window.__ytmPackRefresh : null).catch(() => null), 30000, 300);
      if (!rf) throw new Error(`no window.__ytmPackRefresh after the click (${previewNote}; text=${await packText(a)}; posts=${posted.join(",")}; errors=${JSON.stringify(errors.slice(-3))})`);
      const diag = `${previewNote}; posts=${posted.join(",")} (ok ${okPosts}/2), listen log seeded ${listened.length} entries (120 s each, at ${seeded.at} > pack ${packAt}), listened=${JSON.stringify(rf.listened)}, dropped=${JSON.stringify(rf.dropped)}, added=${JSON.stringify(rf.added)} (${rf.addedSeconds || 0} s for ${rf.seconds || 0} s dropped), kept=${(rf.kept || []).length}`;
      const missing = listened.filter((id) => !(rf.listened || []).includes(id));
      if (missing.length) throw new Error(`listened tracks not detected: ${missing.join(",")} (listen log seeded, me/history ${okPosts}/2 ok); ${diag}; text=${await packText(a)}`);
      if (rf.applied !== true) throw new Error(`refresh not applied: ${await packText(a)}; ${diag}`);
      const dropped = (rf.dropped || []).slice().sort();
      if (JSON.stringify(dropped) !== JSON.stringify(listened.slice().sort())) throw new Error(`dropped ${JSON.stringify(dropped)} != listened ${JSON.stringify(listened)}; ${diag}`);
      if (!(rf.added || []).length) throw new Error(`no new track planned for the ${rf.seconds} s freed; ${diag}`);
      const overlap = (rf.added || []).filter((id) => (plan.videoIds || []).includes(id) || pinnedBeforeSet.has(id));
      if (overlap.length) throw new Error(`added ids already in the pack / pinned: ${overlap.join(",")}; ${diag}`);
      // The refresh runs as THE pack job (same progress panel, same "Annuler").
      const st2 = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s === "running" || s === "done" || s === "cancelled" ? s : null; }, 15000, 300);
      if (!st2) throw new Error(`refresh pack job never showed (state=${await prog.getAttribute("data-state").catch(() => "?")}); ${diag}`);
      const fin2 = await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s === "done" || s === "cancelled" ? s : null; }, 180000, 2000);
      if (fin2 !== "done") throw new Error(`refresh pack not done (state=${fin2}); ${diag}`);
      const after = await pollUntil(async () => { const l = await swList(a); return l && !l.ids.some((id) => listened.includes(id)) ? l : null; }, 15000, 1000) || await swList(a);
      if (!after) throw new Error("SW list-audio unanswered after the refresh");
      const still = listened.filter((id) => after.ids.includes(id));
      if (still.length) throw new Error(`listened tracks still cached after the refresh: ${still.join(",")}; ${diag}`);
      const pinsLost = before.pinnedIds.filter((id) => !listened.includes(id) && !after.pinnedIds.includes(id));
      if (pinsLost.length) throw new Error(`pins outside the two dropped tracks lost: ${pinsLost.join(",")}; ${diag}`);
      const addedPinned = (rf.added || []).filter((id) => after.pinnedIds.includes(id));
      const p2 = await a.evaluate(() => window.__ytmPackPlan || null);
      const ready2 = p2 && p2.result ? p2.result.ready : -1;
      if (!addedPinned.length || addedPinned.length < ready2) throw new Error(`new tracks not pinned in the SW: ${addedPinned.length} pinned of ${(rf.added || []).length} planned (ready=${ready2}); ${diag}`);
      const remembered2 = Number(await a.locator('[data-testid="pack-refresh"]').first().getAttribute("data-pack-count").catch(() => 0)) || 0;
      if (remembered2 !== (rf.kept || []).length + (rf.added || []).length) throw new Error(`last pack after refresh remembers ${remembered2} tracks, expected kept ${(rf.kept || []).length} + added ${(rf.added || []).length}`);
      return `pack 100 Mo ready=${ready}/${plan.videoIds.length}; 2 listened (${listened.join(",")}) -> dropped, ${(rf.added || []).length} new (${addedPinned.length} pinned, ready=${ready2}); pins intact ${before.pinned}-2+${addedPinned.length}=${after.pinned}; ${diag}`;
    }, { budgetMs: 600000 });

    await c44step("pack_too_big", async () => {
      // 1. A quota the longest pack cannot fit in. The Settings selector offers 500 Mo at least and refuses a
      //    quota under the pinned total (OfflineSettings onQuotaChange): after pack_refresh in this context
      //    the 28 pins of a FLAC library weigh ~800 Mo (chain 47), so the selector leg only applies when its
      //    minimum is above what is cached; otherwise the quota is set through the SW (set-audio-quota) at
      //    cached + 20 Mo: nothing is evicted (enforceQuota never touches pins, and the total stays under
      //    the quota) and the room left for a pack is 20 Mo at most (c46b).
      const l0 = await swList(a);
      if (!l0) throw new Error("SW list-audio unanswered before the quota leg");
      const cachedBytes = l0.entries.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
      const floorBytes = Math.max(cachedBytes, l0.pinnedBytes);
      await a.goto(URL + "/settings", { waitUntil: "load", timeout: 45000 });
      const sel = a.locator("#offline-quota").first();
      await sel.waitFor({ state: "visible", timeout: 20000 });
      await pollUntil(() => sel.isEnabled().catch(() => false), 15000, 300);
      const values = await sel.locator("option").evaluateAll((os) => os.map((o) => Number(o.value)).filter((v) => v > 0));
      const minQuota = Math.min(...values);
      let q = null;
      let leg;
      if (minQuota > floorBytes + 20 * MB) {
        await sel.selectOption(String(minQuota));
        q = await pollUntil(async () => { const l = await swList(a); return l && l.quota === minQuota ? l : null; }, 15000, 500);
        if (!q) { const l = await swList(a); throw new Error(`quota not applied: wanted ${minQuota}, SW says ${l ? l.quota : "?"} (pinned ${l ? Math.round(l.pinnedBytes / MB) : "?"} Mo, cached ${Math.round(cachedBytes / MB)} Mo)`); }
        leg = `selector ${Math.round(minQuota / MB)} Mo`;
      } else {
        await ensureControlled(a, sleep, pollUntil);
        const wanted = Math.floor(floorBytes + 20 * MB);
        const got = await setQuota(a, wanted);
        if (got !== wanted) throw new Error(`SW quota not applied (${got} for ${wanted}; selector minimum ${Math.round(minQuota / MB)} Mo is under the ${Math.round(l0.pinnedBytes / MB)} Mo pinned)`);
        q = await pollUntil(async () => { const l = await swList(a); return l && l.quota === wanted ? l : null; }, 15000, 500);
        if (!q) { const l = await swList(a); throw new Error(`SW quota set to ${wanted} but list-audio says ${l ? l.quota : "?"}`); }
        leg = `SW quota cached+20 Mo = ${Math.round(wanted / MB)} Mo (selector minimum ${Math.round(minQuota / MB)} Mo under the ${Math.round(l0.pinnedBytes / MB)} Mo pinned / ${Math.round(cachedBytes / MB)} Mo cached)`;
      }
      const quotaBytes = q.quota;

      // 2. The longest duration on the Espace card.
      await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
      await ensureControlled(a, sleep, pollUntil);
      await expandSpace(a, sleep);
      const durations = await a.locator('[data-testid="pack-size"] option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^dur:\d+$/.test(v)).map((v) => Number(v.slice(4))));
      const longest = "dur:" + Math.max(...durations);
      const pinnedBefore = q.pinned;
      let { prog, st } = await startPack(a, longest, pollUntil);
      // The estimate fit (small library / low bitrate): stop at once, then force a custom quota, pinned + 20 Mo,
      // and on a library whose whole remainder weighs less than that (the sample library: 15 short tracks,
      // about 12 Mo) pinned + 2 Mo.
      for (const roomMb of [20, 2]) {
        if (st !== "running") break;
        await a.locator('[data-testid="pack-cancel"]').first().click({ timeout: 5000 });
        await pollUntil(async () => { const s = await prog.getAttribute("data-state").catch(() => null); return s === "cancelled" || s === "done" ? s : null; }, 10000, 300);
        const g0 = await a.evaluate(() => (window.__ytmPackPlan && window.__ytmPackPlan.guard) || null);
        const l = await swList(a);
        const forced = Math.floor((l ? l.pinnedBytes : 0) + roomMb * MB);
        const got = await setQuota(a, forced);
        if (got !== forced) throw new Error(`fallback quota not applied (${got} for ${forced}); the try before ran with guard=${JSON.stringify(g0)}`);
        await a.reload({ waitUntil: "load" });
        await ensureControlled(a, sleep, pollUntil);
        await expandSpace(a, sleep);
        leg = `${leg} (${Math.round(quotaBytes / MB)} Mo) let the estimate through (guard=${JSON.stringify(g0)}), forced quota pinned+${roomMb} Mo=${Math.round(forced / MB)} Mo`;
        ({ prog, st } = await startPack(a, longest, pollUntil));
      }
      const txt = await packText(a);
      const guard = await a.evaluate(() => (window.__ytmPackPlan && window.__ytmPackPlan.guard) || null);
      if (st !== "too-big") throw new Error(`state=${st}, expected too-big (${leg}); text=${txt}; guard=${JSON.stringify(guard)}`);
      if (!/^Pas assez de place : /.test(txt)) throw new Error(`too-big without the message: "${txt}"`);
      if (!guard || guard.fits !== false || !(guard.estimated > guard.available)) throw new Error(`guard inconsistent: ${JSON.stringify(guard)}`);
      const after = await swList(a);
      if (after && after.pinned !== pinnedBefore) throw new Error(`too-big yet pins moved: ${pinnedBefore} -> ${after.pinned}`);
      const shrink = a.locator('[data-testid="pack-shrink"]').first();
      const shrinkTxt = (await shrink.count()) ? await shrink.innerText().catch(() => "") : "(nothing fits)";
      await a.locator('[data-testid="pack-dismiss"]').first().click({ timeout: 5000 });
      const cleared = await pollUntil(async () => ((await a.locator('[data-testid="pack-progress"]').count()) === 0 ? "gone" : null), 5000, 200);
      return `${leg}; ${longest.replace("dur:", "")} s asked -> too-big; "${txt.slice(0, 140)}"; estimate ${Math.round(guard.estimated / MB)} Mo > available ${Math.round(guard.available / MB)} Mo (${guard.limit}); shrink offer: ${shrinkTxt}; pins ${pinnedBefore} unchanged; dismiss ${cleared || "panel still shown"}`;
    }, { budgetMs: 120000 });
  } finally {
    await tctx.close().catch(() => {});
    slow.release();
  }
}

module.exports = { run, C44_SKIP, STEP_NAMES, swList };
