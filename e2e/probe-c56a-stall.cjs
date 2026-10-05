// c56a probe 3: probe-1 conditions (login, cached album, a queue) + instrumented nav /home -> weekend link.
// Does the outgoing page's outro stall (both .app-transition-wrapper present after 4 s)? Is rAF / Svelte's loop alive?
const fs = require("fs");
const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const OUT = "/e2e/out/c56a";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const FIX = JSON.parse(fs.readFileSync("/e2e/fixtures.json", "utf8"));
const TAP = `(() => {
  window.__errs = []; window.__rafN = 0; window.__rafErr = []; window.__toasts = [];
  window.addEventListener("unhandledrejection", (e) => { const r = e.reason; window.__errs.push("UNHANDLED " + String((r && r.stack) || r).slice(0, 500)); });
  window.addEventListener("error", (e) => { window.__errs.push("ERROR " + String((e.error && e.error.stack) || e.message).slice(0, 500)); });
  const ce = console.error; console.error = function (...a) { try { window.__errs.push("CONSOLE " + a.map((x) => (x && x.stack) || (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ").slice(0, 500)); } catch (e) {} return ce.apply(this, a); };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { window.__rafN++; try { return cb(t); } catch (e) { window.__rafErr.push(String((e && e.stack) || e).slice(0, 500)); throw e; } });
  const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__media = this; return o.apply(this, arguments); };
})();`;
const dump = (p) => p.evaluate(() => {
  const sc = (el) => el ? { st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight } : null;
  const wr = Array.from(document.querySelectorAll(".app-transition-wrapper")).map((el) => { const r = el.getBoundingClientRect(); return { style: el.style.cssText.slice(0, 120), op: getComputedStyle(el).opacity, top: Math.round(r.top), h: Math.round(r.height), txt: (el.innerText || "").replace(/\s+/g, " ").slice(0, 40), anims: el.getAnimations ? el.getAnimations().map((a) => a.playState + ":" + a.currentTime).join(",") : "" } });
  const el = window.__media;
  return { url: location.pathname + location.search, wrappers: wr, wrapper: sc(document.getElementById("wrapper")), rafN: window.__rafN, rafErr: window.__rafErr, errs: window.__errs.slice(-6), media: el ? { t: el.currentTime, paused: el.paused } : null, hidden: document.hidden, vis: document.visibilityState };
});
const log = (tag, o) => console.log(tag, JSON.stringify(o));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA, extraHTTPHeaders: { "X-Ytm-Harness": "1" } });
  await ctx.addInitScript(TAP);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", String((e && e.stack) || e).slice(0, 900)));
  const waitCtl = async () => { for (let i = 0; i < 30; i++) { if (await page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)) return true; await sleep(500); } return false; };

  await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("GOTO home", String(e).slice(0, 100)));
  await sleep(1500);
  console.log("LOGIN", await page.evaluate(async () => { const x = await fetch("/api/v1/me/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "c56a-paul" }) }); try { sessionStorage.removeItem("ytm-whoami"); } catch (e) {} return x.status; }));
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(1500);
  if (!(await waitCtl())) { await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); await sleep(1500); }
  await page.goto(URL + "/release?id=" + encodeURIComponent(FIX.localAlbumId), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  const keep = page.locator('[data-testid="keep-offline"]').first();
  await keep.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  if ((await keep.getAttribute("data-state").catch(() => null)) !== "ready") {
    await keep.click({ timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 90; i++) { if ((await keep.getAttribute("data-state").catch(() => null)) === "ready") break; await sleep(1000); }
  }
  console.log("KEEP", await keep.getAttribute("data-state").catch(() => null));
  // a playing queue (a local album track: plays from the cache, no YouTube)
  await page.locator('[data-testid="keep-offline"]').first().waitFor({ timeout: 5000 }).catch(() => {});
  const row = page.locator("main a, main button").filter({ hasText: /One More Time/ }).first();
  await row.click({ timeout: 5000 }).catch((e) => console.log("ROW click", String(e).slice(0, 80)));
  for (let i = 0; i < 20; i++) { const m = await page.evaluate(() => { const el = window.__media; return el ? el.currentTime : -1; }); if (m > 1) break; await sleep(500); }
  log("QUEUE", await dump(page));

  for (const [label, to] of [["weekend-link", "/library/downloads-offline?pack=dur:7200"], ["no-pack", "/library/downloads-offline"], ["weekend-link-again", "/library/downloads-offline?pack=dur:7200"]]) {
    await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(3500);
    log("HOME " + label, await dump(page));
    await page.evaluate((href) => { const a = document.createElement("a"); a.href = href; a.textContent = "probe"; document.body.appendChild(a); a.click(); a.remove(); }, to);
    let t = 0;
    for (const at of [300, 1500, 4000, 8000]) { await sleep(at - t); t = at; log(`AFTER+${at} ` + label, await dump(page)); }
    await page.screenshot({ path: `${OUT}/stall-${label}.png` }).catch(() => {});
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String((e && e.stack) || e).slice(0, 600)); process.exit(1); });
