// dx-probe-pack-cancel2-c43d: same as dx-probe-pack-cancel-c43d but with the harness step's exact
// timing (A cancels the instant B's button reads "running"), N iterations in fresh contexts, B's toast
// captured, and every SW request on B timed (send -> matching reply) to spot lost replies.
const { chromium } = require("playwright");
const FIX = require("/e2e/fixtures.json");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const ITER = Number(process.env.ITER || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => String(Date.now() - T0).padStart(6, " ");
const log = (...a) => console.log(ts(), ...a);

const TAP = `(() => {
  window.__swlog = [];
  const push = (dir, d) => { try { window.__swlog.push({ t: Date.now(), dir, d: JSON.parse(JSON.stringify(d)) }); } catch (e) { window.__swlog.push({ t: Date.now(), dir, d: String(d) }); } };
  try {
    const orig = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (m, ...rest) {
      if (m && typeof m.type === "string") push("send", m);
      return orig.call(this, m, ...rest);
    };
  } catch (e) {}
  try {
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const d = ev.data;
      if (d && typeof d.type === "string") push("recv", { type: d.type, videoId: d.videoId, ok: d.ok, reason: d.reason, bytes: d.bytes, url: typeof d.url === "string" ? d.url.slice(0, 60) : undefined, n: Array.isArray(d.entries) ? d.entries.length : undefined });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => push("evt", { type: "controllerchange" }));
  } catch (e) {}
  window.__toasts = [];
  const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType === 1) { const t = (n.innerText || "").trim(); if (t && /prêt|Annul|impossible|refus|hors-ligne|Quota/i.test(t) && t.length < 200) window.__toasts.push({ t: Date.now(), text: t }); } } });
  document.addEventListener("DOMContentLoaded", () => mo.observe(document.body, { childList: true, subtree: true }));
})();`;

async function drain(page, tag, state) {
  const items = await page.evaluate((from) => (window.__swlog || []).slice(from), state.n).catch(() => []);
  state.n += items.length;
  for (const it of items) {
    const d = it.d || {};
    if (it.dir === "send") {
      if (d.type === "cache-audio" && d.videoId) state.sent.add(d.videoId);
      if (d.type === "abort-audio" && d.videoId) state.aborts.add(d.videoId);
      if (/^(pin-audio|cache-audio|list-audio|is-cached)$/.test(d.type)) state.open.push({ type: d.type, videoId: d.videoId, t: it.t });
    } else if (it.dir === "recv") {
      const want = { "audio-pinned": "pin-audio", "audio-cached": "cache-audio", "audio-list": "list-audio", "audio-is-cached": "is-cached" }[d.type];
      let lat = "";
      if (want) {
        const i = state.open.findIndex((o) => o.type === want && (o.videoId || "") === (d.videoId || "") || (o.type === want && want === "list-audio"));
        if (i >= 0) { lat = " lat=" + (it.t - state.open[i].t) + "ms"; state.open.splice(i, 1); }
      }
      if (d.type === "audio-cached") state.acks.push({ videoId: d.videoId, ok: d.ok, reason: d.reason });
      if (d.type !== "audio-list" || tag === "B") log(tag, "RECV", JSON.stringify(d) + lat);
      continue;
    } else { log(tag, "EVT", JSON.stringify(d)); continue; }
    if (d.type !== "list-audio") log(tag, "SEND", JSON.stringify({ type: d.type, videoId: d.videoId, pinned: d.pinned, url: typeof d.url === "string" ? d.url.slice(0, 60) : undefined }));
  }
}

async function one(browser, k) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(TAP);
  const SA = { n: 0, sent: new Set(), aborts: new Set(), acks: [], open: [] };
  const SB = { n: 0, sent: new Set(), aborts: new Set(), acks: [], open: [] };
  try {
    const a = await ctx.newPage();
    a.on("pageerror", (e) => log("A", "PAGEERROR", String(e && e.stack || e).slice(0, 300)));
    await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
    for (let i = 0; i < 30 && !(await a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)); i++) await sleep(500);
    if (!(await a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false))) { await a.reload({ waitUntil: "load" }); await sleep(1500); }
    const tg = a.locator('[data-testid="space-toggle"]').first();
    await tg.waitFor({ state: "visible", timeout: 15000 });
    if ((await tg.getAttribute("aria-expanded")) !== "true") { await tg.click({ timeout: 5000 }); await sleep(500); }
    const size = a.locator('[data-testid="pack-size"]').first();
    await size.waitFor({ state: "visible", timeout: 10000 });
    await size.selectOption("100");
    await a.locator('[data-testid="pack-start"]').first().click({ timeout: 5000 });
    const prog = a.locator('[data-testid="pack-progress"]').first();
    await prog.waitFor({ state: "visible", timeout: 15000 });
    let packSt = null;
    for (let i = 0; i < 70; i++) { packSt = await prog.getAttribute("data-state").catch(() => null); if (packSt && packSt !== "planning") break; await sleep(300); }
    log(`[${k}] A PACK`, packSt, "total", await prog.getAttribute("data-total").catch(() => "?"));
    if (packSt !== "running") return;

    const b = await ctx.newPage();
    b.on("pageerror", (e) => log("B", "PAGEERROR", String(e && e.stack || e).slice(0, 300)));
    await b.goto(URL + "/release?id=" + encodeURIComponent(FIX.localAlbumId), { waitUntil: "load", timeout: 45000 });
    const keep = b.locator('[data-testid="keep-offline"]').first();
    await keep.waitFor({ state: "visible", timeout: 20000 });
    const attrs = async () => b.evaluate(() => { const el = document.querySelector('[data-testid="keep-offline"]'); if (!el) return "no-btn"; const o = {}; for (const at of el.attributes) if (at.name.startsWith("data-")) o[at.name] = at.value; o.text = el.innerText; return JSON.stringify(o); });
    log(`[${k}] B SWCTL`, await b.evaluate(() => !!navigator.serviceWorker.controller), await attrs());
    await keep.click({ timeout: 5000 });
    let keepRun = null;
    for (let i = 0; i < 50; i++) { const s = await keep.getAttribute("data-state").catch(() => null); if (s === "running" || s === "ready") { keepRun = s; break; } await sleep(300); }
    log(`[${k}] B keep`, keepRun, await attrs());
    // Harness timing: cancel at once.
    const stillRunning = await prog.getAttribute("data-state").catch(() => null);
    log(`[${k}] A PACK before cancel`, stillRunning, "ready", await prog.getAttribute("data-ready").catch(() => "?"));
    await a.bringToFront().catch(() => {});
    const tC = Date.now();
    await a.locator('[data-testid="pack-cancel"]').first().click({ timeout: 5000 });
    log(`[${k}] A CANCEL clicked`);
    for (let i = 0; i < 30; i++) { const s = await prog.getAttribute("data-state").catch(() => null); if (s === "cancelled" || s === "done") { log(`[${k}] A PACK`, s, "after", Date.now() - tC, "ms"); break; } await sleep(200); }
    await b.bringToFront().catch(() => {});
    let last = ""; let idleSince = 0; let verdict = "timeout";
    for (let i = 0; i < 240; i++) {
      await drain(a, "A", SA); await drain(b, "B", SB);
      const at = await attrs();
      if (at !== last) { log(`[${k}] B keep`, at); last = at; }
      const st = JSON.parse(at)["data-state"];
      if (st === "ready") { verdict = "READY"; break; }
      if (st === "idle") { if (!idleSince) idleSince = Date.now(); else if (Date.now() - idleSince > 4000) { verdict = "STOPPED"; break; } } else idleSince = 0;
      await sleep(500);
    }
    await sleep(1000);
    await drain(a, "A", SA); await drain(b, "B", SB);
    log(`[${k}] B TOASTS`, JSON.stringify(await b.evaluate(() => window.__toasts).catch(() => null)));
    log(`[${k}] A TOASTS`, JSON.stringify(await a.evaluate(() => window.__toasts).catch(() => null)));
    log(`[${k}] B open (unanswered) requests`, JSON.stringify(SB.open));
    log(`[${k}] B acks`, JSON.stringify(SB.acks));
    log(`[${k}] A acks`, JSON.stringify(SA.acks), "aborts", [...SA.aborts].join(","));
    const inter = [...SB.sent].filter((id) => SA.sent.has(id));
    log(`[${k}] intersection`, inter.length, inter.join(","));
    log(`[${k}] B LS`, await b.evaluate(() => { try { const l = JSON.parse(localStorage.getItem("ytm-offline-tracks") || "[]"); return JSON.stringify(l.map((t) => ({ id: t.videoId, c: t._cached, p: t._pinned }))).slice(0, 600); } catch (e) { return String(e); } }));
    const sw = await b.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready; const ctl = navigator.serviceWorker.controller || reg.active; if (!ctl) return null;
      // c51b: the SW answers on event.source (message event on navigator.serviceWorker), not on the port.
      return await new Promise((resolve) => {
        const done = (d) => { navigator.serviceWorker.removeEventListener("message", on); resolve(d); };
        const on = (ev) => { if (ev.data && ev.data.type === "audio-list") done(ev.data); };
        navigator.serviceWorker.addEventListener("message", on);
        const ch = new MessageChannel(); ch.port1.onmessage = (e) => done(e.data);
        ctl.postMessage({ type: "list-audio" }, [ch.port2]); setTimeout(() => done(null), 5000);
      });
    }).catch(() => null);
    log(`[${k}] SW LIST`, sw ? JSON.stringify((sw.entries || []).map((e) => ({ id: e.videoId, p: !!e.pinned }))).slice(0, 800) : "none");
    log(`[${k}] VERDICT`, verdict);
    await b.screenshot({ path: `/e2e/out/dx-pack-cancel2-c43d-B${k}.png` }).catch(() => {});
  } finally { await ctx.close(); }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (let k = 1; k <= ITER; k++) { log("=== iteration", k); await one(browser, k); }
  await browser.close();
})().catch((e) => { log("FATAL", String(e && e.stack || e)); process.exit(1); });
