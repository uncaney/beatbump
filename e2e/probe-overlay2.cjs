const { chromium } = require("playwright");
const URL = ((process.argv.find((a) => a.startsWith("--url=")) || "--url=https://music.ekaii.fr").split("=").slice(1).join("=")).replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "load", timeout: 45000 });
  await sleep(3000);
  await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 8000 });
  await sleep(6000);
  await page.goto(URL + "/home", { waitUntil: "load", timeout: 45000 });
  await sleep(5000);
  const info = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.position === "fixed" && r.width > 300 && r.height > 500 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.5; }).map((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 80), html: e.outerHTML.slice(0, 160), z: cs.zIndex, bg: cs.backgroundColor, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], pe: cs.pointerEvents, children: e.children.length }; }));
  console.log("OVERLAYS", JSON.stringify(info));
  const at = await page.evaluate(() => { const e = document.elementFromPoint(195, 400); return e ? e.tagName + "." + String(e.className).slice(0, 60) + " text=" + (e.innerText || "").slice(0, 40) : null; });
  console.log("AT_CENTER", at);
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
