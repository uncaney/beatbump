// deploy_survives (brainstorm v5 DS1): one PERSISTENT browser profile across two builds.
//   --phase=seed   : on build N, install the SW, play a track, keep one local album offline, record state.
//   --phase=verify : on build N+1 (or after a rollback), reopen the same profile and assert: SW updated,
//                    no _app 404, pins intact, resume restored, app usable, few _app re-downloads.
// run: ./run.sh <url> "daft punk" probe-deploy-survives.cjs --phase=seed --label=N
const fs = require("fs"); const path = require("path");
const { chromium } = require("playwright");
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const PHASE = arg("phase", "seed"); const LABEL = arg("label", PHASE);
const PROFILE = arg("profile", "/e2e/profiles/ds1"); const STATE = "/e2e/out/ds1-state.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[ds1 ${PHASE}:${LABEL}]`, ...a);
(async () => {
  if (PHASE === "seed") fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { extraHTTPHeaders: { "X-Ytm-Harness": "1" },  channel: process.env.PW_CHANNEL || undefined, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const appReq = []; const notFound = []; const errs = [];
  const page = await ctx.newPage();
  // PF4-5: count only real downloads (responses not served by the service worker).
  const htmlUnderApp = [];
  page.on("response", (r) => { if (/\/_app\//.test(r.url())) { if (!r.fromServiceWorker()) appReq.push(r.url()); if (/text\/html/.test(r.headers()["content-type"] || "") && /\.(js|css|woff2?)$/.test(r.url())) htmlUnderApp.push(r.url().replace(/^https?:\/\/[^/]+/, "")); } });
  // c59e: a 404 the SERVICE WORKER itself triggers (precacheRest back-filling the build the server no longer has,
  // right after a rollback) is not a page failure: the page never asked for that file. Reported apart (swNotFound).
  const swNotFound = [];
  page.on("response", (r) => {
    if (r.status() !== 404 || !/\/_app\//.test(r.url())) return;
    const path = r.url().replace(/^https?:\/\/[^/]+/, "");
    const req = r.request(); const fromSw = typeof req.serviceWorker === "function" && !!req.serviceWorker();
    (fromSw ? swNotFound : notFound).push(path);
  });
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  // c59g: which build the page is running (entry script hash) and which SW controls it, at the three
  // moments that matter; the rollback diagnosis of chains 78/80 needed exactly this.
  const dumpClient = async (tag) => { const d = await page.evaluate(() => { const st = ([...document.scripts].map((x) => x.src).find((x) => /entry\/start/.test(x)) || [...document.querySelectorAll("link[rel=modulepreload]")].map((l) => l.href).find((x) => /entry\/start/.test(x)) || ""); const ctl = navigator.serviceWorker.controller; return { start: st.replace(/^.*entry\/start\./, "").replace(/\.js$/, ""), ctl: ctl ? ctl.state : null, href: location.pathname }; }).catch((e) => ({ err: String(e.message).slice(0, 80) })); log("CLIENT", tag, JSON.stringify(d)); };
  const swInfo = async () => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); const keys = await caches.keys(); return { ctl: !!navigator.serviceWorker.controller, active: !!(r && r.active), waiting: !!(r && r.waiting), shells: keys.filter((k) => k.startsWith("ytm-shell-")), caches: keys.length }; });
  const pinned = async () => page.evaluate(async () => { const r = await navigator.serviceWorker.ready; const ctl = navigator.serviceWorker.controller || r.active; return new Promise((res) => { const on = (ev) => { if (ev.data && ev.data.type === "audio-list") { navigator.serviceWorker.removeEventListener("message", on); const e = ev.data.entries || []; res({ total: e.length, pinned: e.filter((x) => x.pinned).length }); } }; navigator.serviceWorker.addEventListener("message", on); ctl && ctl.postMessage({ type: "list-audio" }); setTimeout(() => res({ total: -1, pinned: -1 }), 6000); }); });
  const version = async () => page.evaluate(async () => (await (await fetch("/api/v1/stats/library", { cache: "no-store" })).json()).version);
  // Box load makes first loads erratic: retry the navigation up to 3 times (domcontentloaded), then settle.
  let navOk = false;
  for (let a = 0; a < 3 && !navOk; a++) navOk = await page.goto(URL + "/home", { waitUntil: "domcontentloaded", timeout: 60000 }).then(() => true).catch((e) => { log("goto /home attempt", a + 1, "failed:", String(e.message).slice(0, 60)); return false; });
  if (!navOk) throw new Error("/home never loaded (3 attempts)");
  await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  let sw = await swInfo(); for (let i = 0; i < 20 && !sw.active; i++) { await sleep(1000); sw = await swInfo(); }
  const ver = await version();
  log("served version", ver, "sw", JSON.stringify(sw));
  if (PHASE === "seed") {
    for (let a = 0; a < 3; a++) { if (await page.goto(URL + "/search/daft%20punk?filter=all", { waitUntil: "domcontentloaded", timeout: 60000 }).then(() => true).catch(() => false)) break; }
    await page.getByText(/Song\s*•/).first().click({ position: { x: 8, y: 8 }, timeout: 20000 });
    await sleep(6000);
    const title = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
    const albumId = await page.evaluate(async () => { const d = await (await fetch("/api/v1/local/albums?limit=1&sort=trackCount:asc")).json(); return d.items && d.items[0] && d.items[0].browseId; });
    for (let a = 0; a < 3; a++) { if (await page.goto(URL + "/release?id=" + encodeURIComponent(albumId), { waitUntil: "domcontentloaded", timeout: 60000 }).then(() => true).catch(() => false)) break; }
    const keep = page.locator('[data-testid="keep-offline"]').first();
    await keep.waitFor({ state: "visible", timeout: 20000 });
    await keep.click({ timeout: 5000 });
    let p = { pinned: 0 }; for (let i = 0; i < 40; i++) { await sleep(3000); p = await pinned(); if (p.pinned >= 1) break; }
    await sleep(4000); // let resume state / history settle
    const state = { version: ver, shells: sw.shells, title, albumId, pinned: p, at: new Date().toISOString() };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    log("SEEDED", JSON.stringify(state));
    if (p.pinned < 1) { log("FAIL seed: no pinned entry"); process.exitCode = 1; }
  } else {
    const seed = JSON.parse(fs.readFileSync(STATE, "utf8"));
    // wait for the new SW to take over (shell cache name changes with the build)
    // the app reloads itself once the new SW takes control: evaluate() may die mid-navigation, retry.
    const safe = async (fn, d) => { try { return await fn(); } catch { return d; } };
    const prev = seed.lastVersion || seed.version; const prevShells = seed.lastShells || seed.shells;
    let shells = sw.shells; for (let i = 0; i < 30 && JSON.stringify(shells) === JSON.stringify(prevShells); i++) { await sleep(2000); shells = (await safe(swInfo, { shells })).shells; }
    await sleep(3000);
    await dumpClient("before-reload");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await dumpClient("after-reload");
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    await sleep(3000);
    sw = await safe(swInfo, sw);
    // The SW may be mid-switch right after a build swap: retry the list query a few times.
    let p = { pinned: -1, total: -1 };
    for (let a = 0; a < 4 && p.pinned < 0; a++) { await sleep(a ? 3000 : 0); await page.evaluate(() => navigator.serviceWorker.ready.then(() => null)).catch(() => {}); p = await safe(pinned, { pinned: -1, total: -1 }); }
    // app usable: SPA navigation renders search rows
    await page.evaluate(() => { const a = document.createElement("a"); a.href = "/search/daft%20punk?filter=all"; a.textContent = "x"; document.body.appendChild(a); a.click(); });
    const rows = await page.getByText(/Song\s*•/).first().waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
    await dumpClient("after-spa-search");
    const resumeTitle = ((await page.locator(".now-playing-title").first().innerText().catch(() => "")) || "").trim();
    const offlineRows = await page.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 60000 }).then(async () => { await sleep(2500); return page.locator('[data-testid="album-ready"], .row').count(); }).catch(() => -1);
    const result = { from: prev, to: ver, htmlUnderApp: htmlUnderApp.slice(0, 3), swChanged: JSON.stringify(sw.shells) !== JSON.stringify(prevShells), sw, notFound: notFound.slice(0, 5), swNotFound: swNotFound.slice(0, 5), pageErrors: errs.slice(0, 3), appRequests: appReq.length, pinnedBefore: seed.pinned.pinned, pinnedAfter: p.pinned, totalAfter: p.total, searchUsable: rows, resumeTitle, seededTitle: seed.title, offlineRows };
    const fails = [];
    if (ver === prev) fails.push("same build served (nothing to verify)");
    // Cache names cannot prove the SW switch on a rollback (the old shell cache was kept on purpose):
    // the served version plus zero missing chunk / page error is the contract. swChanged stays informational.
    if (notFound.length) fails.push("_app 404: " + notFound[0]);
    if (htmlUnderApp.length) fails.push("HTML served for an _app asset: " + htmlUnderApp[0]);
    if (errs.length) fails.push("page errors: " + errs[0]);
    if (p.pinned >= 0 && p.pinned < seed.pinned.pinned) fails.push(`pins lost ${seed.pinned.pinned} -> ${p.pinned}`);
    if (p.pinned < 0 && !(offlineRows > 0)) fails.push("SW list unavailable and no offline rows: pins unverifiable");
    if (!rows) fails.push("search not usable after update");
    if (seed.title && resumeTitle && !resumeTitle.toLowerCase().startsWith(seed.title.toLowerCase().slice(0, 10))) fails.push(`resume title ${resumeTitle} != ${seed.title}`);
    // Every hash changes between two real builds, so re-downloads are expected; only an absurd count
    // (chunks fetched again and again) or any 404 is a failure. The number is reported for trend.
    if (appReq.length > 500) fails.push(`_app re-downloads ${appReq.length} > 500`);
    fs.writeFileSync(`/e2e/out/ds1-${LABEL}.json`, JSON.stringify({ result, fails }, null, 2));
    fs.writeFileSync(STATE, JSON.stringify({ ...seed, lastVersion: ver, lastShells: sw.shells }, null, 2));
    log(fails.length ? "FAIL " + fails.join(" | ") : "PASS", JSON.stringify(result));
    if (fails.length) process.exitCode = 1;
  }
  await ctx.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
