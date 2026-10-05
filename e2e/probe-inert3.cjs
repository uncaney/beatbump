const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
  await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 15000 });
  await sleep(4000);
  await page.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 });
  await sleep(2500);
  const info = await page.evaluate(() => {
    const row = document.querySelectorAll("[data-testid='queue-row']")[1];
    const out = []; let el = row;
    while (el && el !== document.body) { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); out.push([el.tagName + "." + String(el.className).replace(/svelte-\w+/g, "").trim().slice(0, 36) + (el.dataset.testid ? "#" + el.dataset.testid : ""), c.display, c.overflow, c.visibility, c.opacity, c.transform === "none" ? "" : c.transform.slice(0, 30), [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(","), c.contentVisibility || ""]); el = el.parentElement; }
    return out;
  });
  for (const l of info) console.log(JSON.stringify(l));
  await ctx.close(); await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
