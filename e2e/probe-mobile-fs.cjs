const { chromium } = require("playwright");
const URL = process.argv[2] || "https://staging-music.ekaii.fr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(URL + "/search/" + encodeURIComponent("daft punk") + "?filter=all", { waitUntil: "networkidle", timeout: 60000 });
  const sub = page.getByText(/Song\s*•/).first();
  await sub.locator("xpath=preceding-sibling::*[1]").click({ timeout: 8000 }); await sleep(4000);
  const info = await page.evaluate(() => {
    const t = document.querySelector(".now-playing-title");
    const r = t && t.getBoundingClientRect();
    return { titleText: t ? t.textContent.trim() : null, innerText: t ? t.innerText : null, box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null, display: t ? getComputedStyle(t).display : null, footerImg: !!document.querySelector("footer img") };
  });
  console.log("TITLE", JSON.stringify(info));
  await page.locator("footer img").first().click({ timeout: 5000 }).catch((e) => console.log("img click err", e.message.slice(0, 60)));
  await sleep(1500);
  const fs = await page.evaluate(() => { const b = document.querySelector(".backdrop"); const cs = b && getComputedStyle(b); const l = document.querySelector('[data-testid="fullscreen-lyrics"]'); const lr = l && l.getBoundingClientRect(); return { backdropVisible: !!b && cs.visibility !== "hidden" && Number(cs.opacity) > 0.5, lyricsBtn: !!l, lyricsBox: lr ? [Math.round(lr.x), Math.round(lr.y), Math.round(lr.width), Math.round(lr.height)] : null, lyricsVisible: !!l && l.offsetParent !== null }; });
  console.log("FULLSCREEN", JSON.stringify(fs));
  await page.screenshot({ path: "/e2e/out/probe-mobile-fs.png" });
  if (fs.lyricsVisible) { await page.locator('[data-testid="fullscreen-lyrics"]').click({ timeout: 5000 }); await sleep(2500); console.log("AFTER_LYRICS", page.url(), (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80)); }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
