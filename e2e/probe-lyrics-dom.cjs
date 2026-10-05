const { chromium } = require("playwright");
const URL = "https://staging-music.ekaii.fr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(URL + "/search/" + encodeURIComponent("daft punk") + "?filter=all", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByText(/Song\s*•/).first().click(); await sleep(4000);
  const dump = () => page.evaluate(() => [...document.querySelectorAll('[aria-label*="parole" i],[aria-label*="lyric" i],a[href*="lyrics"]')].map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { tag: e.tagName, label: e.getAttribute("aria-label"), inFooter: !!e.closest("footer"), inFs: !!e.closest(".fullscreen, .backdrop, [class*='fullscreen']"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: cs.visibility, disp: cs.display, op: cs.opacity }; }));
  console.log("BEFORE_FS", JSON.stringify(await dump()));
  await page.locator(".now-playing-title, .player-title, footer img").first().click({ timeout: 4000 }).catch(() => {}); await sleep(1500);
  console.log("AFTER_FS ", JSON.stringify(await dump()));
  const fs = await page.evaluate(() => [...document.querySelectorAll(".fullscreen, .backdrop, [class*='fullscreen']")].map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { cls: e.className.toString().slice(0, 60), h: Math.round(r.height), vis: cs.visibility, op: cs.opacity, z: cs.zIndex }; }));
  console.log("FS_ELEMENTS", JSON.stringify(fs));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
