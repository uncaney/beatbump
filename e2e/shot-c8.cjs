const { chromium } = require("playwright");
const URL = "https://music.ekaii.fr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (const [name, vp] of [["mobile", { width: 390, height: 844, isMobile: true, hasTouch: true }], ["desktop", { width: 1280, height: 900 }]]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    const page = await ctx.newPage();
    await page.goto(URL + "/search/" + encodeURIComponent("daft punk") + "?filter=all", { waitUntil: "networkidle", timeout: 60000 });
    await page.getByText(/Song\s*•/).first().click(); await sleep(4000);
    // SPA navigation to home so the session (Reprendre fallback) survives
    await page.evaluate(() => { const a = document.createElement("a"); a.id = "__nav"; a.href = "/home"; a.textContent = "x"; a.style.cssText = "position:fixed;top:0;left:0;z-index:99999"; document.body.appendChild(a); });
    await page.click("#__nav"); await sleep(3500);
    await page.screenshot({ path: `/e2e/out/c8-home-${name}.png` });
    if (name === "desktop") {
      await page.locator("footer .dd-button").last().click({ timeout: 5000 }).catch(() => {});
      await sleep(600);
      await page.getByText(/Minuterie de sommeil/i).first().click({ timeout: 5000 }).catch(() => {});
      await sleep(600);
      await page.screenshot({ path: `/e2e/out/c8-sleep-${name}.png` });
      await page.keyboard.press("Escape");
    }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
