// dx-probe-pack-cancel-c43d: reproduce steps-c38-offline pack_cancel_two_tabs with diagnostics.
// Tab A (/library/downloads-offline) starts a 100 Mo pack; tab B keeps the fixture album; A cancels.
// Both tabs log every SW message they SEND (cache-audio / abort-audio / pin-audio) and RECEIVE
// (audio-cached with reason, audio-aborted, audio-pinned); B logs the keep button every 500 ms.
const { chromium } = require("playwright");
const FIX = require("/e2e/fixtures.json");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
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
      if (m && typeof m.type === "string" && /audio|pin|abort|cache/.test(m.type)) push("send", m);
      return orig.call(this, m, ...rest);
    };
  } catch (e) {}
  try {
    navigator.serviceWorker.addEventListener("message", (ev) => {
      const d = ev.data;
      if (d && typeof d.type === "string" && /^audio-(cached|aborted|pinned|uncached)$/.test(d.type)) push("recv", d);
    });
  } catch (e) {}
})();`;

async function drain(page, tag, state) {
  const items = await page.evaluate((from) => (window.__swlog || []).slice(from), state.n).catch(() => []);
  state.n += items.length;
  for (const it of items) {
    const d = it.d || {};
    const short = { type: d.type, videoId: d.videoId, ok: d.ok, reason: d.reason, pinned: d.pinned, bytes: d.bytes, url: typeof d.url === "string" ? d.url.slice(0, 70) : undefined };
    log(tag, it.dir.toUpperCase(), JSON.stringify(short));
    if (it.dir === "send" && d.type === "cache-audio" && d.videoId) state.sent.add(d.videoId);
    if (it.dir === "send" && d.type === "pin-audio" && d.videoId) state.pinReq.add(d.videoId);
    if (it.dir === "send" && d.type === "abort-audio" && d.videoId) state.aborts.add(d.videoId);
    if (it.dir === "recv" && d.type === "audio-cached") state.acks.push({ videoId: d.videoId, ok: d.ok, reason: d.reason });
  }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(TAP);
  const SA = { n: 0, sent: new Set(), pinReq: new Set(), aborts: new Set(), acks: [] };
  const SB = { n: 0, sent: new Set(), pinReq: new Set(), aborts: new Set(), acks: [] };
  const a = await ctx.newPage();
  for (const [p, tag] of [[a, "A"]]) {
    p.on("pageerror", (e) => log(tag, "PAGEERROR", String(e && e.stack || e).slice(0, 300)));
    p.on("console", (m) => { if (["error"].includes(m.type())) log(tag, "CONSOLE", m.text().slice(0, 200)); });
  }
  await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
  for (let i = 0; i < 30 && !(await a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)); i++) await sleep(500);
  if (!(await a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false))) { await a.reload({ waitUntil: "load" }); await sleep(1500); }
  log("A SWCTL", await a.evaluate(() => !!navigator.serviceWorker.controller));
  const albumId = FIX.localAlbumId;

  // Album track ids (B's set) via the release page later; also from the API if available.
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
  log("A PACK state", packSt, "total", await prog.getAttribute("data-total").catch(() => "?"));
  // The pack plan is exposed on window (exposePack): try to read it.
  const plan = await a.evaluate(() => { const w = window; const cands = ["__ytmPack", "__pack", "__ytm_pack", "__offlinePack"]; for (const k of cands) if (w[k]) return { key: k, v: JSON.stringify(w[k]).slice(0, 1500) }; return Object.keys(w).filter((k) => /pack/i.test(k)).join(","); }).catch((e) => String(e));
  log("A PACK exposed", JSON.stringify(plan));
  await drain(a, "A", SA);

  const b = await ctx.newPage();
  b.on("pageerror", (e) => log("B", "PAGEERROR", String(e && e.stack || e).slice(0, 300)));
  b.on("console", (m) => { if (["error"].includes(m.type())) log("B", "CONSOLE", m.text().slice(0, 200)); });
  await b.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "load", timeout: 45000 });
  const keep = b.locator('[data-testid="keep-offline"]').first();
  await keep.waitFor({ state: "visible", timeout: 20000 });
  const attrs = async () => b.evaluate(() => { const el = document.querySelector('[data-testid="keep-offline"]'); if (!el) return "no-btn"; const o = {}; for (const at of el.attributes) if (at.name.startsWith("data-")) o[at.name] = at.value; o.text = el.innerText; return JSON.stringify(o); });
  log("B SWCTL", await b.evaluate(() => !!navigator.serviceWorker.controller), "keep", await attrs());
  await keep.click({ timeout: 5000 });
  let keepRun = null;
  for (let i = 0; i < 50; i++) { const s = await keep.getAttribute("data-state").catch(() => null); if (s === "running" || s === "ready") { keepRun = s; break; } await sleep(300); }
  log("B keep started", keepRun, await attrs());
  await drain(a, "A", SA); await drain(b, "B", SB);

  // Let the two run together for ~2.5 s, then A cancels.
  await sleep(2500);
  await drain(a, "A", SA); await drain(b, "B", SB);
  log("A PACK state before cancel", await prog.getAttribute("data-state").catch(() => null), "ready", await prog.getAttribute("data-ready").catch(() => "?"));
  log("B keep before cancel", await attrs());
  await a.bringToFront().catch(() => {});
  const tCancel = Date.now();
  await a.locator('[data-testid="pack-cancel"]').first().click({ timeout: 5000 });
  log("A CANCEL clicked");
  for (let i = 0; i < 30; i++) { const s = await prog.getAttribute("data-state").catch(() => null); if (s === "cancelled" || s === "done") { log("A PACK", s, "after", Date.now() - tCancel, "ms"); break; } await sleep(200); }
  await b.bringToFront().catch(() => {});
  // Watch B for up to 60 s.
  let lastAttrs = "";
  for (let i = 0; i < 120; i++) {
    await drain(a, "A", SA); await drain(b, "B", SB);
    const at = await attrs();
    if (at !== lastAttrs) { log("B keep", at); lastAttrs = at; }
    const st = JSON.parse(at)["data-state"];
    if (st === "ready") break;
    if (st === "idle" && i > 8) break;
    await sleep(500);
  }
  await sleep(1500);
  await drain(a, "A", SA); await drain(b, "B", SB);
  const inter = [...SB.sent].filter((id) => SA.sent.has(id));
  const interPin = [...SB.pinReq].filter((id) => SA.sent.has(id));
  log("SUMMARY A cache-audio sent", SA.sent.size, [...SA.sent].join(","));
  log("SUMMARY A abort-audio sent", SA.aborts.size, [...SA.aborts].join(","));
  log("SUMMARY B cache-audio sent", SB.sent.size, [...SB.sent].join(","));
  log("SUMMARY B pin-audio sent", [...SB.pinReq].join(","));
  log("SUMMARY intersection A.cache & B.cache", inter.length, inter.join(","), "| A.cache & B.pin", interPin.length, interPin.join(","));
  log("SUMMARY A acks", JSON.stringify(SA.acks));
  log("SUMMARY B acks", JSON.stringify(SB.acks));
  log("B LS", await b.evaluate(() => { try { const l = JSON.parse(localStorage.getItem("ytm-offline-tracks") || "[]"); return JSON.stringify(l.map((t) => ({ id: t.videoId, c: t._cached, p: t._pinned, ev: t._evicted }))).slice(0, 800); } catch (e) { return String(e); } }));
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
  log("SW LIST", sw ? JSON.stringify((sw.entries || []).map((e) => ({ id: e.videoId, p: !!e.pinned, b: e.bytes }))).slice(0, 1200) : "none");
  await b.screenshot({ path: "/e2e/out/dx-pack-cancel-c43d-B.png" }).catch(() => {});
  await browser.close();
})().catch((e) => { log("FATAL", String(e && e.stack || e)); process.exit(1); });
