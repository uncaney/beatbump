// dx-probe-keep-churn-c43d: fresh context, keep the fixture album on /release while the HOST churns
// containers (veth add/remove = ERR_NETWORK_CHANGED for a --network host Chrome). Logs every SW
// message the page sends / receives (cache-audio acks with reason), failed requests, the button
// states and the final toast. Read-only on the server side.
const { chromium } = require("playwright");
const FIX = require("/e2e/fixtures.json");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(String(Date.now() - T0).padStart(6, " "), new Date().toISOString().slice(11, 23), ...a);
const TAP = `(() => {
  window.__swlog = []; window.__toasts = [];
  const push = (dir, d) => { try { window.__swlog.push({ t: Date.now(), dir, type: d.type, videoId: d.videoId, ok: d.ok, reason: d.reason }); } catch (e) {} };
  try { const orig = ServiceWorker.prototype.postMessage; ServiceWorker.prototype.postMessage = function (m, ...rest) { if (m && /^(cache-audio|abort-audio|pin-audio)$/.test(m.type)) push("send", m); return orig.call(this, m, ...rest); }; } catch (e) {}
  try { navigator.serviceWorker.addEventListener("message", (ev) => { const d = ev.data; if (d && /^audio-(cached|aborted|pinned)$/.test(d.type)) push("recv", d); }); } catch (e) {}
  const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType === 1) { const t = (n.innerText || "").trim(); if (t && t.length < 160 && /prêt|Annul|impossible|refus|Quota/i.test(t)) window.__toasts.push(t); } } });
  document.addEventListener("DOMContentLoaded", () => { try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {} });
})();`;
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(TAP);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("CONSOLE", m.text().slice(0, 160)); });
  page.on("requestfailed", (r) => log("REQFAIL", r.failure() && r.failure().errorText, r.url().slice(0, 100)));
  await page.goto(URL + "/release?id=" + encodeURIComponent(FIX.localAlbumId), { waitUntil: "load", timeout: 60000 });
  for (let i = 0; i < 30 && !(await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)); i++) await sleep(500);
  log("SWCTL", await page.evaluate(() => !!navigator.serviceWorker.controller));
  const keep = page.locator('[data-testid="keep-offline"]').first();
  await keep.waitFor({ state: "visible", timeout: 20000 });
  const attrs = async () => page.evaluate(() => { const b = document.querySelector('[data-testid="keep-offline"]'); if (!b) return "no-btn"; const o = {}; for (const a of b.attributes) if (a.name.startsWith("data-")) o[a.name] = a.value; o.text = b.innerText; return JSON.stringify(o); });
  log("CLICK keep", await attrs());
  await keep.click({ timeout: 5000 });
  let n = 0; let last = "";
  for (let i = 0; i < 160; i++) {
    const items = await page.evaluate((from) => (window.__swlog || []).slice(from), n).catch(() => []);
    n += items.length;
    for (const e of items) log("SW", e.dir, e.type, e.videoId || "", e.ok === undefined ? "" : e.ok ? "ok" : "KO:" + e.reason);
    const at = await attrs();
    if (at !== last) { log("BTN", at); last = at; }
    const st = JSON.parse(at)["data-state"];
    if (st === "ready") break;
    if (st === "idle" && i > 6) break;
    await sleep(500);
  }
  await sleep(1500);
  log("TOASTS", JSON.stringify(await page.evaluate(() => window.__toasts).catch(() => null)));
  log("LS", await page.evaluate(() => { try { return JSON.stringify(JSON.parse(localStorage.getItem("ytm-offline-tracks") || "[]").map((t) => ({ id: t.videoId, c: t._cached, p: t._pinned }))); } catch (e) { return String(e); } }));
  await browser.close();
})().catch((e) => { log("FATAL", String(e && e.stack || e)); process.exit(1); });
