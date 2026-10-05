// dx-probe-shared-abort-c43d: does abort-audio from tab A withdraw only A's waiter in the REAL SW?
// B keeps the fixture album; once B has 2 cache-audio in flight, A joins the same two downloads
// (cache-audio with the same videoId / url, as a second owner) then sends abort-audio for both.
// Expected (L8-16): A gets audio-cached reason "cancelled", B gets ok and ends 4/4 ready.
const { chromium } = require("playwright");
const FIX = require("/e2e/fixtures.json");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(String(Date.now() - T0).padStart(6, " "), ...a);
const TAP = `(() => {
  window.__swlog = []; window.__toasts = [];
  const push = (dir, d) => { try { window.__swlog.push({ t: Date.now(), dir, type: d.type, videoId: d.videoId, ok: d.ok, reason: d.reason, url: typeof d.url === "string" ? d.url : undefined }); } catch (e) {} };
  try { const orig = ServiceWorker.prototype.postMessage; ServiceWorker.prototype.postMessage = function (m, ...rest) { if (m && /^(cache-audio|abort-audio|pin-audio)$/.test(m.type)) push("send", m); return orig.call(this, m, ...rest); }; } catch (e) {}
  try { navigator.serviceWorker.addEventListener("message", (ev) => { const d = ev.data; if (d && /^audio-(cached|aborted|pinned)$/.test(d.type)) push("recv", d); }); } catch (e) {}
  const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType === 1) { const t = (n.innerText || "").trim(); if (t && t.length < 160 && /prêt|Annul|impossible|refus|Quota/i.test(t)) window.__toasts.push(t); } } });
  document.addEventListener("DOMContentLoaded", () => { try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {} });
})();`;
const drain = async (p, tag, st) => { const items = await p.evaluate((from) => (window.__swlog || []).slice(from), st.n).catch(() => []); st.n += items.length; for (const e of items) { if (e.type === "pin-audio" || (e.type === "audio-pinned" && e.reason === "not_cached")) continue; log(tag, e.dir, e.type, e.videoId || "", e.ok === undefined ? "" : e.ok ? "ok" : "KO:" + e.reason); } return items; };
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(TAP);
  const a = await ctx.newPage();
  await a.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 60000 });
  for (let i = 0; i < 30 && !(await a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)); i++) await sleep(500);
  if (!(await a.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false))) { await a.reload({ waitUntil: "load" }); await sleep(1500); }
  log("A SWCTL", await a.evaluate(() => !!navigator.serviceWorker.controller));
  const b = await ctx.newPage();
  await b.goto(URL + "/release?id=" + encodeURIComponent(FIX.localAlbumId), { waitUntil: "load", timeout: 60000 });
  log("B SWCTL", await b.evaluate(() => !!navigator.serviceWorker.controller));
  const keep = b.locator('[data-testid="keep-offline"]').first();
  await keep.waitFor({ state: "visible", timeout: 20000 });
  const attrs = async () => b.evaluate(() => { const el = document.querySelector('[data-testid="keep-offline"]'); if (!el) return "no-btn"; const o = {}; for (const at of el.attributes) if (at.name.startsWith("data-")) o[at.name] = at.value; o.text = el.innerText; return JSON.stringify(o); });
  const SA = { n: 0 }, SB = { n: 0 };
  await keep.click({ timeout: 5000 });
  // Wait for B's first two cache-audio sends.
  let sent = [];
  for (let i = 0; i < 100 && sent.length < 2; i++) { const items = await drain(b, "B", SB); for (const e of items) if (e.dir === "send" && e.type === "cache-audio") sent.push({ videoId: e.videoId, url: e.url }); await sleep(100); }
  log("B in flight:", JSON.stringify(sent));
  if (sent.length < 2) { log("FATAL no in-flight downloads on B"); await browser.close(); process.exit(1); }
  // A joins the same two downloads as a second owner, then aborts them.
  await a.evaluate((list) => { const c = navigator.serviceWorker.controller; for (const s of list) c.postMessage({ type: "cache-audio", url: s.url, videoId: s.videoId, pinned: true }); }, sent);
  log("A joined", sent.map((s) => s.videoId).join(","));
  await sleep(400);
  await a.evaluate((list) => { const c = navigator.serviceWorker.controller; for (const s of list) c.postMessage({ type: "abort-audio", videoId: s.videoId, url: "" }); }, sent);
  log("A sent abort-audio for", sent.map((s) => s.videoId).join(","));
  let last = ""; let verdict = "timeout";
  for (let i = 0; i < 120; i++) {
    await drain(a, "A", SA); await drain(b, "B", SB);
    const at = await attrs();
    if (at !== last) { log("B BTN", at); last = at; }
    const st = JSON.parse(at)["data-state"];
    if (st === "ready") { verdict = "B READY"; break; }
    if (st === "idle" && i > 8) { verdict = "B STOPPED"; break; }
    await sleep(500);
  }
  await sleep(1000);
  await drain(a, "A", SA); await drain(b, "B", SB);
  log("B TOASTS", JSON.stringify(await b.evaluate(() => window.__toasts).catch(() => null)));
  log("VERDICT", verdict);
  await browser.close();
})().catch((e) => { log("FATAL", String(e && e.stack || e)); process.exit(1); });
