// Probe: (1) player.json error contract → toast + guarded auto-skip; (2) clicking the current
// paused track in search results resumes playback (was a silent no-op).
// Context without service worker so page.route() sees every player.json call.
const { chromium } = require("playwright");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const URL = args.url || "https://staging-music.ekaii.fr";
const QUERY = args.query || "daft punk";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__media = { plays: 0, el: null };
    const p = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__media.plays++; window.__media.el = this; return p.apply(this, arguments); };
  });
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 160)); });
  page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
  const state = () => page.evaluate(() => { const el = window.__media.el; return { plays: window.__media.plays, src: (el && (el.currentSrc || el.src) || "").slice(0, 70), t: el ? +el.currentTime.toFixed(1) : -1, paused: el ? el.paused : true, title: ((document.querySelector(".now-playing-title, .player-title") || {}).textContent || "").trim() }; });
  const toastsSeen = new Set();
  setInterval(() => { page.locator(".alert").allInnerTexts().then((t) => t.forEach((x) => toastsSeen.add(x))).catch(() => {}); }, 400);

  // Route installed BEFORE the first click: 1st player.json (clicked track) passes, 2nd and 3rd
  // (prefetch of track 2, then the real fetch of track 2 on "next") answer 404 unplayable.
  let n = 0, failedReal = false; const log = [];
  await page.route(/\/api\/v1\/player\.json/, async (route) => {
    n++;
    const u = new (require("url").URL)(route.request().url());
    log.push(`#${n} ${u.searchParams.get("videoId")} prefetch=${!!route.request().headers()["x-ytm-prefetch"]}`);
    const isPrefetch = !!route.request().headers()["x-ytm-prefetch"] || u.searchParams.get("prefetch") === "1";
    // 404 every prefetch (so "next" cannot use a warmed source) and the first real fetch after the 1st track.
    if (n > 1 && (isPrefetch || !failedReal)) {
      if (!isPrefetch) failedReal = true;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "unplayable", status: "UNPLAYABLE", reason: "Video unavailable", videoId: u.searchParams.get("videoId") }) });
    }
    return route.continue();
  });

  await page.goto(URL + "/search/" + encodeURIComponent(QUERY) + "?filter=all", { waitUntil: "networkidle", timeout: 60000 });
  const firstRow = page.getByText(/Song\s*•/).first();
  await firstRow.click();
  await sleep(7000);
  const before = await state();
  console.log("PLAY1", JSON.stringify(before), "calls:", log.join(", "));

  await page.locator('[aria-label="Morceau suivant"], .player-btn:has(use[href*="skip-forward"])').first().click();
  await sleep(9000);
  const after = await state();
  console.log("AFTER_NEXT", JSON.stringify(after), "calls:", log.join(", "));
  console.log("TOASTS", JSON.stringify([...toastsSeen]));
  const toastOk = [...toastsSeen].some((t) => /indisponible/i.test(t));
  const skipped = after.src && after.src !== before.src && !after.paused && after.t > 0;
  console.log(toastOk && skipped ? "PASS auto_skip_on_unplayable" : `FAIL auto_skip_on_unplayable toast=${toastOk} skipped=${skipped}`);
  await page.unroute(/\/api\/v1\/player\.json/);

  // --- 2. pause, SPA-navigate to the results, click the CURRENT track's row → must resume
  await page.evaluate(() => window.__media.el && window.__media.el.pause());
  await sleep(800);
  const paused = await state();
  console.log("PAUSED", JSON.stringify(paused));
  const cur = paused.title;
  // SPA navigation (SvelteKit intercepts same-origin anchors) so the in-memory session survives.
  await page.evaluate((href) => { const a = document.createElement("a"); a.id = "__probe_nav"; a.href = href; a.textContent = "nav"; a.style.cssText = "position:fixed;top:0;left:0;z-index:99999"; document.body.appendChild(a); }, "/search/" + encodeURIComponent(cur || QUERY) + "?filter=all");
  await page.click("#__probe_nav");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await sleep(1500);
  await page.getByText(/Song\s*•/).first().waitFor({ state: "visible", timeout: 15000 });
  const rows = page.getByText(/Song\s*•/);
  const cnt = await rows.count();
  let clicked = "";
  for (let i = 0; i < cnt; i++) {
    const txt = (await rows.nth(i).locator("xpath=..").innerText().catch(() => "")).split("\n")[0].trim();
    const a = txt.toLowerCase(), b = cur.toLowerCase();
    if (cur && (a === b || a.startsWith(b.slice(0, 18)) || b.startsWith(a.slice(0, 18)))) { await rows.nth(i).click(); clicked = txt; break; }
    if (i < 6) console.log("  row", i, JSON.stringify(txt));
  }
  await sleep(6000);
  const s2 = await state();
  console.log("AFTER_CLICK", JSON.stringify({ clicked, cur }), JSON.stringify(s2));
  console.log(clicked && !s2.paused && s2.t > 0 && s2.title.toLowerCase().startsWith(cur.toLowerCase().slice(0, 18)) ? "PASS current_track_click_plays" : "FAIL current_track_click_plays");
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
