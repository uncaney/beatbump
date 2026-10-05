const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.__ytmMedia = { plays: 0 }; const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__ytmMedia.plays++; window.__ytmMedia.el = this; window.__ytmMedia.src = this.currentSrc || this.src; return o.apply(this, arguments); }; });
  page.on("console", (m) => { if (/seek|start|t=/i.test(m.text())) console.log("console:", m.text().slice(0, 120)); });
  let loaded = false; for (let a = 0; a < 3 && !loaded; a++) { loaded = await page.goto(URL + "/listen?id=fa5IWHDbftI&t=30", { waitUntil: "domcontentloaded", timeout: 60000 }).then(() => true).catch((e) => { console.log("goto attempt", a + 1, "failed:", String(e.message).slice(0, 50)); return false; }); }
  if (!loaded) throw new Error("listen page never loaded");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await sleep(2000);
  const btn = page.locator("[data-start-at]").first();
  console.log("btn count", await btn.count(), "data-start-at", await btn.getAttribute("data-start-at").catch(() => null), "text", (await btn.innerText().catch(() => "")).slice(0, 40));
  const media0 = await page.evaluate(() => Array.from(document.querySelectorAll("audio, video")).map((m) => ({ tag: m.tagName, src: (m.currentSrc || m.src || "").slice(0, 60), rs: m.readyState, t: m.currentTime })));
  console.log("media before", JSON.stringify(media0));
  await btn.click({ timeout: 5000 });
  for (let i = 0; i < 10; i++) { await sleep(2000); const m = await page.evaluate(() => { const h = window.__ytmMedia; const el = h && h.el; return { plays: h && h.plays, el: el ? { rs: el.readyState, t: Math.round(el.currentTime * 10) / 10, paused: el.paused, dur: Math.round(el.duration || 0), src: (el.currentSrc || "").slice(0, 50) } : null }; }); console.log("t+" + (i + 1) * 2 + "s", JSON.stringify(m), page.url().replace(URL, "")); }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
