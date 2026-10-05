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
    const r = row.getBoundingClientRect(); const cs = getComputedStyle(row);
    const chain = []; let el = row; while (el && el !== document.body) { const c = getComputedStyle(el); if (c.visibility !== "visible" || c.display === "none" || c.opacity === "0" || c.pointerEvents === "none" || el.hasAttribute("inert")) chain.push([el.tagName + "." + String(el.className).slice(0, 40), c.visibility, c.display, c.opacity, c.pointerEvents, el.hasAttribute("inert")]); el = el.parentElement; }
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const panel = row.closest("[style*='translate3d'], .queue, .up-next, aside"); const pr = panel && panel.getBoundingClientRect();
    return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], vis: cs.visibility, pe: cs.pointerEvents, blockers: chain, atPoint: at && (at.tagName + "." + String(at.className).slice(0, 50) + (at.getAttribute("data-testid") ? "#" + at.getAttribute("data-testid") : "")), panelRect: pr && [Math.round(pr.x), Math.round(pr.y), Math.round(pr.width), Math.round(pr.height)], panelStyle: panel && (panel.getAttribute("style") || "").slice(0, 120) };
  });
  console.log(JSON.stringify(info));
  await page.screenshot({ path: "/e2e/out/probe-inert-desktop.png" });
  await ctx.close(); await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
