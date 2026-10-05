const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const [n, u] of [["favorites", "/favorites"], ["settings", "/settings"], ["lyrics", "/lyrics"], ["home", "/home"]]) {
    await page.goto("https://music.ekaii.fr" + u, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    if (n === "settings") await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.screenshot({ path: `/e2e/out/c7-${n}.png`, fullPage: n === "settings" });
  }
  await browser.close();
})();
