const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844, isMobile: true, hasTouch: true }]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    const page = await ctx.newPage();
    await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
    await page.addStyleTag({ content: ".drawer-body{display:flex !important;flex-direction:column;height:inherit;min-height:0;background:inherit;}" });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 15000 });
    await sleep(4000);
    await page.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 });
    await sleep(2500);
    if (vp.isMobile) { const h = page.locator(".sheet-head").first(); if (await h.count()) { await h.click({ timeout: 3000 }).catch(() => {}); await sleep(1500); } }
    const info = await page.evaluate(() => { const s = document.querySelector(".queue-scroller"); const r = s && s.getBoundingClientRect(); const row = document.querySelectorAll("[data-testid='queue-row']")[1]; const rr = row && row.getBoundingClientRect(); const at = rr && document.elementFromPoint(rr.x + rr.width / 2, rr.y + rr.height / 2); return { scrollerH: r && Math.round(r.height), rowY: rr && Math.round(rr.y), atPoint: at && (at.closest("[data-testid='queue-row']") ? "row" : at.tagName + "." + String(at.className).slice(0, 30)), inert: document.querySelector("[data-testid='queue-drawer-body']").getAttribute("data-inert") }; });
    const hov = await page.locator("[data-testid='queue-row']").nth(1).hover({ timeout: 3000 }).then(() => "hover ok").catch((e) => "hover failed");
    console.log(vp.width, JSON.stringify(info), hov);
    await page.screenshot({ path: `/e2e/out/probe-inert4-${vp.width}.png` });
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
