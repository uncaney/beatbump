// Probe: can Chromium play /aud/<id> (iv-vp m4a) at all? (1) bare <audio> on a blank page of the
// same origin, no service worker; (2) the app's /listen flow with the SW blocked.
const { chromium } = require("playwright");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const URL = args.url || "https://staging-music.ekaii.fr";
const VID = args.vid || "9bZkp7q19f0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--host-resolver-rules=MAP *.ekaii.fr 127.0.0.1"] });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("response", (r) => { if (/\/aud\//.test(r.url())) console.log("RESP", r.status(), r.headers()["content-range"] || "-", r.headers()["content-type"], r.headers()["content-length"] || "-"); });
  await page.goto(URL + "/definitely-blank-page", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  const r1 = await page.evaluate(async (src) => {
    const a = document.createElement("audio"); a.src = src; a.preload = "auto"; document.body.appendChild(a);
    const ev = [];
    for (const e of ["loadedmetadata", "canplay", "playing", "error", "stalled"]) a.addEventListener(e, () => ev.push(e + (e === "error" && a.error ? ":" + a.error.code + ":" + a.error.message : "")));
    try { await a.play(); } catch (e) { ev.push("play-reject:" + e.message); }
    await new Promise((r) => setTimeout(r, 6000));
    return { ev, t: a.currentTime, dur: a.duration, rs: a.readyState, ns: a.networkState, err: a.error ? a.error.code + ":" + a.error.message : null };
  }, "/aud/" + VID);
  console.log("BARE_AUDIO", JSON.stringify(r1));
  console.log(r1.t > 1 && !r1.err ? "PASS bare_audio_plays" : "FAIL bare_audio_plays");

  // Same with the mp4 type hinted via <source>
  const r2 = await page.evaluate(async (src) => {
    const a = document.createElement("audio"); const s = document.createElement("source"); s.src = src + "?x=1"; s.type = 'audio/mp4; codecs="mp4a.40.2"'; a.appendChild(s); document.body.appendChild(a);
    try { await a.play(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 5000));
    return { t: a.currentTime, err: a.error ? a.error.code + ":" + a.error.message : null, canPlayType: a.canPlayType('audio/mp4; codecs="mp4a.40.2"') };
  }, "/aud/" + VID);
  console.log("BARE_AUDIO_TYPED", JSON.stringify(r2));
  await browser.close();
})().catch((e) => { console.log("FATAL", String(e)); process.exit(1); });
