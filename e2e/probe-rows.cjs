const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const media = (p) => p.evaluate(() => { const a = document.querySelector("audio,video"); return a ? { src: (a.currentSrc || a.src || "").slice(0, 50), t: Math.round(a.currentTime * 10) / 10, paused: a.paused, n: document.querySelectorAll("audio,video").length } : { n: document.querySelectorAll("audio,video").length }; });
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("c:" + m.text().slice(0, 140)); });
  await page.goto(URL + "/", { waitUntil: "load", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await sleep(3000);
  console.log("HOME media", JSON.stringify(await media(page)));
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await sleep(2000);
  const rows = page.getByText(/Song\s*•/);
  const n = await rows.count();
  for (let i = 0; i < Math.min(n, 3); i++) {
    const info = await rows.nth(i).evaluate((el) => { const row = el.closest("article, li, .innercard, [data-testid]") || el.parentElement; return { sub: (el.innerText || "").replace(/\s+/g, " ").slice(0, 50), local: !!row.querySelector("a[href^='/artist/la-']"), offline: row.getAttribute("data-offline") }; });
    await rows.nth(i).click({ position: { x: 8, y: 8 }, timeout: 8000 });
    await sleep(7000);
    console.log(`ROW${i}`, JSON.stringify(info), "media=" + JSON.stringify(await media(page)), "title=" + JSON.stringify(((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim().slice(0, 30)));
  }
  console.log("ERRS", JSON.stringify(errs.slice(0, 4)));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
