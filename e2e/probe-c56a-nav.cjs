// c56a probe 2: why is the page black after a client-side nav /home -> /library/downloads-offline?pack=dur:7200 ?
// Dumps the keyed transition wrappers, scroll containers and rAF liveness over time, for several nav variants.
const fs = require("fs");
const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const OUT = "/e2e/out/c56a";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const TAP = `(() => {
  window.__errs = []; window.__rafN = 0; window.__rafErr = [];
  window.addEventListener("unhandledrejection", (e) => { const r = e.reason; window.__errs.push("UNHANDLED " + String((r && r.stack) || r).slice(0, 400)); });
  window.addEventListener("error", (e) => { window.__errs.push("ERROR " + String((e.error && e.error.stack) || e.message).slice(0, 400)); });
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { window.__rafN++; try { return cb(t); } catch (e) { window.__rafErr.push(String((e && e.stack) || e).slice(0, 400)); throw e; } });
})();`;
const dump = (p) => p.evaluate(() => {
  const sc = (el) => el ? { st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight, ov: getComputedStyle(el).overflowY } : null;
  const wr = Array.from(document.querySelectorAll(".app-transition-wrapper")).map((el) => { const r = el.getBoundingClientRect(); return { style: el.style.cssText.slice(0, 160), op: getComputedStyle(el).opacity, top: Math.round(r.top), h: Math.round(r.height), txt: (el.innerText || "").replace(/\s+/g, " ").slice(0, 50), anims: el.getAnimations ? el.getAnimations().length : -1 }; });
  return { url: location.pathname + location.search, wrappers: wr, html: sc(document.documentElement), body: sc(document.body), wrapper: sc(document.getElementById("wrapper")), content: sc(document.querySelector(".app-content-p")), rafN: window.__rafN, rafErr: window.__rafErr, errs: window.__errs.slice(-5) };
});
const rafAlive = (p) => p.evaluate(() => new Promise((r) => { const t = setTimeout(() => r("raf-dead"), 1500); requestAnimationFrame(() => { clearTimeout(t); r("raf-ok"); }); }));
const log = (tag, o) => console.log(tag, JSON.stringify(o));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const variants = [
    ["home->offline?pack=dur:7200", "/home", "/library/downloads-offline?pack=dur:7200"],
    ["home->offline?pack=1", "/home", "/library/downloads-offline?pack=1"],
    ["home->offline (no pack)", "/home", "/library/downloads-offline"],
    ["home->stats", "/home", "/library/stats"],
    ["stats->offline?pack=dur:7200", "/library/stats", "/library/downloads-offline?pack=dur:7200"],
    ["offline->offline?pack=dur:7200 (same route, param only)", "/library/downloads-offline", "/library/downloads-offline?pack=dur:7200"],
  ];
  for (const [label, from, to] of variants) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA, extraHTTPHeaders: { "X-Ytm-Harness": "1" } });
    await ctx.addInitScript(TAP);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("PAGEERROR", label, String((e && e.stack) || e).slice(0, 500)));
    await page.goto(URL + from, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("GOTO", label, String(e).slice(0, 100)));
    await sleep(3000);
    log("BEFORE " + label, await dump(page));
    await page.evaluate((href) => { const a = document.createElement("a"); a.href = href; a.textContent = "probe"; document.body.appendChild(a); a.click(); a.remove(); }, to);
    for (const ms of [300, 1500, 5000]) {
      await sleep(ms === 300 ? 300 : ms - (ms === 1500 ? 300 : 1500));
      log(`AFTER+${ms} ` + label, await dump(page));
    }
    console.log("RAF", label, await rafAlive(page));
    await page.screenshot({ path: `${OUT}/nav-${label.replace(/[^a-z0-9]+/gi, "_")}.png` }).catch(() => {});
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String((e && e.stack) || e).slice(0, 600)); process.exit(1); });
