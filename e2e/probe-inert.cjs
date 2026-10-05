const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://staging-music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (const vp of [{ width: 1280, height: 900, isMobile: false }, { width: 390, height: 844, isMobile: true, hasTouch: true }]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: !!vp.hasTouch });
    const page = await ctx.newPage();
    await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 15000 });
    await sleep(4000);
    const read = async (label) => console.log(vp.width, label, JSON.stringify(await page.evaluate(() => { const b = document.querySelector("[data-testid='queue-drawer-body']"); const fs = document.querySelector(".fullscreen-player, [data-state]"); return { body: !!b, inert: b && b.getAttribute("data-inert"), hasInertAttr: b && b.hasAttribute("inert"), ariaHidden: b && b.getAttribute("aria-hidden"), rows: document.querySelectorAll("[data-testid='queue-row']").length, fsState: fs && (fs.getAttribute("data-state") || fs.className.slice(0, 40)), inertCount: document.querySelectorAll("[inert]").length }; })));
    await read("before-open");
    await page.locator("footer .now-playing img, footer img").first().click({ timeout: 5000 }).catch((e) => console.log("footer click failed", e.message.slice(0, 60)));
    await sleep(2000);
    await read("after-open");
    const h = page.locator(".queue-handle, [data-testid='queue-handle'], .sheet-handle, .handle").first();
    if (vp.isMobile && (await h.count())) { await h.click({ timeout: 3000 }).catch(() => {}); await sleep(1500); await read("after-handle"); }
    const row = page.locator("[data-testid='queue-row']").nth(1);
    const hov = await row.hover({ timeout: 3000 }).then(() => "hover ok").catch((e) => "hover failed: " + e.message.slice(0, 50));
    console.log(vp.width, hov);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
