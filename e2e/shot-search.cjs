const { chromium } = require("playwright");
const URL = process.argv[2] || "https://staging-music.ekaii.fr";
(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (const [name, vp] of [["mobile", { width: 390, height: 844, isMobile: true, hasTouch: true }], ["desktop", { width: 1280, height: 900 }]]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    const page = await ctx.newPage();
    await page.goto(URL + "/search/" + encodeURIComponent("daft punk") + "?filter=songs", { waitUntil: "networkidle", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `/e2e/out/search-songs-${name}.png`, fullPage: false });
    const h = await page.locator("h1").allInnerTexts();
    const chips = await page.locator(".chip").allInnerTexts();
    const shelves = await page.locator(".h3, h2, h3").allInnerTexts();
    console.log(name, "h1=", JSON.stringify(h), "chips=", JSON.stringify(chips), "shelves=", JSON.stringify(shelves.slice(0, 6)));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
