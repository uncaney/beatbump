// Probe: lyrics journey from the player (audit-ux-v2 item 4): play a track, open fullscreen,
// click the lyrics control, expect a /lyrics route or visible lyrics text (not "Play a track").
const { chromium } = require("playwright");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const URL = args.url || "https://staging-music.ekaii.fr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  for (const vp of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true }]) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
    await page.goto(URL + "/search/" + encodeURIComponent("daft punk") + "?filter=all", { waitUntil: "networkidle", timeout: 60000 });
    await page.getByText(/Song\s*•/).first().click(); await sleep(5000);
    const before = page.url();
    // lyrics controls: fullscreen "Lyrics"/"Paroles" button, or player bar button
    const candidates = ['button[aria-label="Lyrics"]', 'button[aria-label="Paroles"]', 'button:has-text("Lyrics")', 'button:has-text("Paroles")', '[aria-label*="lyric" i]', '[aria-label*="parole" i]', 'a[href*="lyrics"]'];
    let found = null;
    for (const c of candidates) { const l = page.locator(c).last(); if (await l.count() && await l.isVisible().catch(() => false)) { found = c; await l.click({ timeout: 4000 }).catch(() => {}); break; } }
    if (!found) {
      // open fullscreen (click the mini-bar title / cover) then retry
      await page.locator(".now-playing-title, .player-title, footer img").first().click({ timeout: 4000 }).catch(() => {}); await sleep(1500);
      for (const c of candidates) { const l = page.locator(c).last(); if (await l.count() && await l.isVisible().catch(() => false)) { found = c + " (fullscreen)"; await l.click({ timeout: 4000 }).catch(() => {}); break; } }
    }
    await sleep(3000);
    const after = page.url();
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    const hasLyricsText = /lyrics|paroles/i.test(body) && !/play a track/i.test(body) && body.length > 400;
    console.log(`${vp.name}: control=${found} url ${before.slice(URL.length)} -> ${after.slice(URL.length)} lyricsText=${hasLyricsText} playATrack=${/play a track/i.test(body)} errors=${errs.length} ${errs[0] || ""}`);
    await page.screenshot({ path: `/e2e/out/lyrics-${vp.name}.png` }).catch(() => {});
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
