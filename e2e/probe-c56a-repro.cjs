// c56a probe: reproduce Camille's two Android PWA bugs on staging.
//  bug2: /home -> client-side nav to /library/downloads-offline?pack=dur:7200 (black screen?)
//  bug1: Hors-ligne page, offline (airplane mode), "Tout lire" -> toast "Lecture hors-ligne impossible." ?
const fs = require("fs");
const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const OUT = "/e2e/out/c56a";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const FIX = JSON.parse(fs.readFileSync("/e2e/fixtures.json", "utf8"));
const TAP = `(() => {
  window.__toasts = []; window.__errs = []; window.__swlog = []; window.__media = null;
  const push = (dir, m) => { try { window.__swlog.push({ dir, type: m && m.type, videoId: m && m.videoId, cached: m && m.cached, ok: m && m.ok, reason: m && m.reason, n: m && Array.isArray(m.entries) ? m.entries.length : undefined }); } catch (e) {} };
  try { const o = ServiceWorker.prototype.postMessage; ServiceWorker.prototype.postMessage = function (m, ...r) { push("send", m); return o.call(this, m, ...r); }; } catch (e) {}
  try { navigator.serviceWorker.addEventListener("message", (ev) => push("recv", ev.data)); } catch (e) {}
  window.addEventListener("unhandledrejection", (e) => { const r = e.reason; window.__errs.push("UNHANDLED " + String((r && r.stack) || r).slice(0, 500)); });
  window.addEventListener("error", (e) => { window.__errs.push("ERROR " + String((e.error && e.error.stack) || e.message).slice(0, 500)); });
  const ce = console.error; console.error = function (...a) { try { window.__errs.push("CONSOLE " + a.map((x) => (x && x.stack) || (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ").slice(0, 600)); } catch (e) {} return ce.apply(this, a); };
  const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__media = this; return o.apply(this, arguments); };
  const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType === 1) { const t = (n.innerText || "").trim(); if (t && t.length < 200 && /prêt|Annul|impossible|refus|Quota|version|service worker|Aucun|indisponible|invalide|introuvable|suivant/i.test(t)) window.__toasts.push(t); } } });
  document.addEventListener("DOMContentLoaded", () => { try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {} });
})();`;

const state = (p) => p.evaluate(() => {
  const el = window.__media || document.querySelector("audio,video");
  return {
    url: location.href, controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller), online: navigator.onLine,
    bodyLen: (document.body && document.body.innerText || "").length, text: (document.body && document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200),
    mainChildren: document.querySelector("main") ? document.querySelector("main").children.length : -1,
    space: !!document.querySelector("[data-testid=offline-space]"), packSize: (document.querySelector("[data-testid=pack-size]") || {}).value || null,
    toggle: (document.querySelector("[data-testid=space-toggle]") || { getAttribute: () => null }).getAttribute("aria-expanded"),
    media: el ? { src: (el.currentSrc || el.src || "").slice(0, 120), t: el.currentTime, paused: el.paused, err: el.error ? el.error.code + ":" + el.error.message : null } : null,
    toasts: (window.__toasts || []).slice(-6), errs: (window.__errs || []).slice(-8), swlog: (window.__swlog || []).slice(-14).map((e) => `${e.dir === "send" ? ">" : "<"}${e.type}${e.videoId ? ":" + e.videoId : ""}${e.cached !== undefined ? "/" + e.cached : ""}${e.ok !== undefined ? "/" + (e.ok ? "ok" : e.reason || "ko") : ""}${e.n !== undefined ? "/n=" + e.n : ""}`),
    offlineList: (() => { try { const l = JSON.parse(localStorage.getItem("ytm-offline-tracks") || "[]"); return { n: l.length, cached: l.filter((t) => t._cached === true).length, sample: l.slice(0, 3).map((t) => ({ id: t.videoId, c: t._cached, u: String(t._offlineUrl || "").slice(0, 60) })) }; } catch (e) { return String(e); } })(),
  };
});
const log = (tag, o) => console.log(tag, JSON.stringify(o));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA, extraHTTPHeaders: { "X-Ytm-Harness": "1" } });
  await ctx.addInitScript(TAP);
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => { const u = r.url(); if (/player\.json|\/localf|\/vp\?|\/aud\//.test(u)) reqs.push(new Date().toISOString().slice(11, 23) + " " + u.replace(URL, "").slice(0, 110)); });
  page.on("pageerror", (e) => console.log("PAGEERROR", String((e && e.stack) || e).slice(0, 900)));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 400)); });
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` }).catch(() => {});
  const waitCtl = async () => { for (let i = 0; i < 30; i++) { if (await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)) return true; await sleep(500); } return false; };

  // --- setup: login, SW control, cached album, a YouTube queue to restore
  await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("GOTO home", String(e).slice(0, 100)));
  await sleep(1500);
  console.log("LOGIN", await page.evaluate(async () => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "c56a-paul" }) }); try { sessionStorage.removeItem("ytm-whoami"); } catch (e) {} return x.status; }));
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(1500);
  if (!(await waitCtl())) { await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); await sleep(1500); }
  console.log("SW controller", await page.evaluate(() => !!navigator.serviceWorker.controller));

  await page.goto(URL + "/release?id=" + encodeURIComponent(FIX.localAlbumId), { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("GOTO release", String(e).slice(0, 100)));
  const keep = page.locator('[data-testid="keep-offline"]').first();
  await keep.waitFor({ state: "visible", timeout: 20000 }).catch((e) => console.log("KEEP not visible", String(e).slice(0, 100)));
  const ks = await keep.getAttribute("data-state").catch(() => null);
  console.log("KEEP state before", ks);
  if (ks !== "ready") {
    await keep.click({ timeout: 5000 }).catch((e) => console.log("KEEP click", String(e).slice(0, 100)));
    for (let i = 0; i < 90; i++) { const s = await keep.getAttribute("data-state").catch(() => null); if (s === "ready") break; await sleep(1000); }
    console.log("KEEP state after", await keep.getAttribute("data-state").catch(() => null), "ready/total", await keep.getAttribute("data-ready").catch(() => "?"), await keep.getAttribute("data-total").catch(() => "?"));
  }
  // a YouTube track in the queue (Camille's restored queue was a YouTube track)
  await page.goto(URL + "/listen?id=" + (process.env.YT_ID || "B9TEdLaVWdI"), { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("GOTO listen", String(e).slice(0, 100)));
  for (let i = 0; i < 30; i++) { const m = await page.evaluate(() => { const el = window.__media; return el ? { src: el.currentSrc || el.src, t: el.currentTime } : null; }); if (m && m.src && m.t > 1) break; await sleep(1000); }
  log("LISTEN", (await state(page)).media);
  await sleep(2000);

  // --- bug 2: reload on /home (queue restored, paused), then client-side nav to the weekend link
  await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(3500);
  log("HOME", await state(page));
  const wk = page.locator('[data-testid="weekend-card-start"]');
  const hasWk = await wk.count();
  console.log("WEEKEND_CARD", hasWk);
  if (hasWk) await wk.first().click({ timeout: 5000 }).catch((e) => console.log("WK click", String(e).slice(0, 100)));
  else await page.evaluate(() => { const a = document.createElement("a"); a.href = "/library/downloads-offline?pack=dur:7200"; a.textContent = "probe"; a.id = "c56a-link"; document.body.appendChild(a); a.click(); });
  await sleep(4000);
  const s2 = await state(page);
  log("BUG2_AFTER_NAV", s2);
  await shot("bug2-after-nav");
  // frozen scheduler test: the Espace toggle must react
  const tg = page.locator('[data-testid="space-toggle"]').first();
  if (await tg.count()) {
    const before = await tg.getAttribute("aria-expanded");
    await tg.click({ timeout: 3000 }).catch((e) => console.log("TOGGLE click", String(e).slice(0, 100)));
    await sleep(800);
    console.log("BUG2_TOGGLE", before, "->", await tg.getAttribute("aria-expanded"));
  } else console.log("BUG2_TOGGLE missing (no SpaceCard rendered)");
  console.log("BUG2_REQS", JSON.stringify(reqs.slice(-8)));

  // --- bug 1: offline "Tout lire"
  reqs.length = 0;
  await page.goto(URL + "/library/downloads-offline", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(5000); // reconcile runs 4 s after load
  log("OFFLINE_PAGE_ONLINE", await state(page));
  await ctx.setOffline(true);
  await sleep(800);
  await page.evaluate(() => { window.__toasts = []; window.__errs = []; window.__swlog = []; });
  const tl = page.locator('button:has-text("Tout lire")').first();
  console.log("TOUT_LIRE visible", await tl.isVisible().catch(() => false), "aria-disabled", await tl.getAttribute("aria-disabled").catch(() => null));
  await tl.click({ timeout: 5000 }).catch((e) => console.log("TL click", String(e).slice(0, 100)));
  await sleep(6000);
  const s1 = await state(page);
  log("BUG1_AFTER_TOUT_LIRE_OFFLINE", s1);
  console.log("BUG1_REQS", JSON.stringify(reqs));
  await shot("bug1-offline-toutlire");
  const nx = page.locator('[aria-label="Morceau suivant"]:visible').first();
  await nx.click({ timeout: 5000 }).catch((e) => console.log("NEXT click", String(e).slice(0, 100)));
  await sleep(4000);
  log("BUG1_AFTER_NEXT", await state(page));
  console.log("BUG1_REQS2", JSON.stringify(reqs));
  await ctx.setOffline(false);

  // --- bug 1 bis: same, after a reload while offline (restored queue + offline)
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(4000);
  await ctx.setOffline(true);
  await sleep(500);
  await page.evaluate(() => { window.__toasts = []; window.__errs = []; window.__swlog = []; });
  reqs.length = 0;
  await page.locator('button:has-text("Tout lire")').first().click({ timeout: 5000 }).catch((e) => console.log("TL2 click", String(e).slice(0, 100)));
  await sleep(6000);
  log("BUG1B_AFTER_RELOAD_OFFLINE", await state(page));
  console.log("BUG1B_REQS", JSON.stringify(reqs));
  await shot("bug1b");
  await ctx.setOffline(false);
  await browser.close();
})().catch((e) => { console.log("FATAL", String((e && e.stack) || e).slice(0, 600)); process.exit(1); });
