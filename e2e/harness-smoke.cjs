// ytm-e2e-smoke (cycle 43, lane c43c, B7-15): smoke navigateur de music.ekaii.fr / staging, < 90 s.
// Appele par agents/ops/smoke.sh (SMOKE_BROWSER=1) via e2e/run.sh, donc par agents/promote.sh apres le
// smoke HTTP. Memes conventions, fixtures et helpers que harness-core.cjs (arg(), FIX, step/shot/report,
// servedVersion, pollUntil, media), 4 etapes + le budget :
//   smoke_home_first_personal_row  /home repond, la premiere rangee personnelle ([data-row]) est peinte
//   smoke_local_track_plays        /listen?id=<fixtures.localLid> : "Start Listening", source /localf,
//                                  currentTime avance (aucune acquisition : lid LOCAL)
//   smoke_service_worker           navigator.serviceWorker : enregistrement actif (scope, controller)
//   smoke_version                  version servie (stats/library via 127.0.0.1 + SNI, sinon la page) non vide,
//                                  et egale a la version attendue si elle est donnee
//   smoke_under_budget             tout en moins de 90 s
// Version attendue : --expect=<sha> ou env YTM_SMOKE_EXPECT (run.sh ne transmet pas d argument : smoke.sh pose
// l env, run.sh le passe au conteneur). report.json comme harness-core ; toutes les etapes sont prefixees
// smoke_ : weekly.sh, qui reconnait les rapports coeur / hors-ligne a deux noms d etapes precis, ignore
// celui-ci. Sortie : exit 1 si un echec.
// Usage direct : ./run.sh https://staging-music.ekaii.fr "daft punk" harness-smoke.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
process.on("unhandledRejection", (e) => console.log("UNHANDLED", String((e && e.message) || e)));

const FIX = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8")) || {}; } catch (e) { console.log("fixtures.json not loaded (" + String(e.message || e).slice(0, 60) + ")"); return {}; } })();
const arg = (k, d = "") =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split("=").slice(1).join("=");
const URL = arg("url", "https://staging-music.ekaii.fr").replace(/\/$/, "");
const OUT = arg("out", "/out");
const QUERY = arg("query", FIX.query || "daft punk");
const RESOLVER = arg("resolver", "");
const EXPECT = (arg("expect", process.env.YTM_SMOKE_EXPECT || "") || "").trim();
const LID = FIX.localLid || "6300e80e2e2";
const TOTAL_BUDGET_MS = 90000;
const STEP_BUDGET_MS = { smoke_home_first_personal_row: 30000, smoke_local_track_plays: 45000, smoke_service_worker: 20000, smoke_version: 15000 };

fs.mkdirSync(OUT, { recursive: true });
let shotN = 0;
const steps = [];
const STARTED = Date.now();
const UPSTREAM_RE = /Invalid response was returned from `next`|ERR_INTERNET_DISCONNECTED|ERR_CERT_VERIFIER_CHANGED|net::ERR_/;
async function shot(page, label) {
  const f = `${String(++shotN).padStart(2, "0")}-${label.replace(/\W+/g, "_")}.png`;
  await page.screenshot({ path: path.join(OUT, f) }).catch(() => {});
  return f;
}
async function step(page, name, fn) {
  const budget = STEP_BUDGET_MS[name] || 30000;
  const t0 = Date.now();
  try {
    const detail = (await fn()) || "";
    const durationMs = Date.now() - t0;
    const rec = { name, ok: true, detail: String(detail), shot: await shot(page, name), durationMs };
    if (durationMs > budget) rec.slow = true;
    steps.push(rec);
    console.log("PASS", name, detail, `[${(durationMs / 1000).toFixed(1)}s${rec.slow ? " SLOW" : ""}]`);
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e).split("\n")[0];
    const durationMs = Date.now() - t0;
    const upstream = UPSTREAM_RE.test(msg);
    const rec = { name, ok: false, detail: msg, shot: await shot(page, "FAIL_" + name), durationMs };
    if (durationMs > budget) rec.slow = true;
    if (upstream) rec.upstream = true;
    steps.push(rec);
    console.log(upstream ? "UPSTREAM" : "FAIL", name, "-", msg, `[${(durationMs / 1000).toFixed(1)}s]`);
    return false;
  }
}
// Served version without the browser: Traefik on 127.0.0.1 with SNI + Host (box hairpin is broken).
function servedVersion() {
  return new Promise((resolve) => {
    if (!/^https:/.test(URL)) return resolve(null);
    const host = URL.replace(/^https?:\/\//, "");
    const req = require("https").request({ host: "127.0.0.1", port: 443, path: "/api/v1/stats/library", method: "GET", servername: host, rejectUnauthorized: false, headers: { Host: host } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { try { resolve(JSON.parse(b).version || null); } catch { resolve(null); } }); });
    req.on("error", () => resolve(null)); req.setTimeout(10000, () => { req.destroy(); resolve(null); }); req.end();
  });
}
function writeReport(version) {
  const finished = Date.now();
  const failed = steps.filter((s) => !s.ok && !s.upstream).length;
  const upstream = steps.filter((s) => !s.ok && s.upstream).length;
  const report = { url: URL, query: QUERY, version, expected: EXPECT || null, startedAt: new Date(STARTED).toISOString(), finishedAt: new Date(finished).toISOString(), durationMs: finished - STARTED, budgetMs: TOTAL_BUDGET_MS, overBudget: finished - STARTED > TOTAL_BUDGET_MS, passed: steps.filter((s) => s.ok).length, failed, upstream, steps };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${report.passed} passed / ${report.failed} failed / ${report.upstream} upstream -> ${OUT}/report.json`);
  console.log(`Report budget: ${(report.durationMs / 1000).toFixed(0)} s / ${TOTAL_BUDGET_MS / 1000} s${report.overBudget ? " OVER BUDGET" : ""}, version=${version}, expected=${EXPECT || "-"}`);
  return report;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); }
  return last;
}
async function media(page) {
  return page.evaluate(() => {
    const el = window.__ytmMedia || document.querySelector("audio,video");
    return el ? { src: el.currentSrc || el.src || "", t: el.currentTime, paused: el.paused } : null;
  });
}

// Hard stop: the smoke must never hang a promotion (smoke.sh also wraps run.sh in timeout 240).
setTimeout(() => { console.log("FATAL smoke over 120 s: aborting"); try { writeReport(null); } catch {} process.exit(1); }, 120000);

(async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    headless: true, chromiumSandbox: false,
    args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage",
      ...(RESOLVER ? ["--host-resolver-rules=" + RESOLVER] : [])],
  });
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Ytm-Harness": "1" },  ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__ytmMedia = this; return orig.apply(this, arguments); };
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));
  // Like harness-core: after "load", up to 4 s of network quiet (shell and client route coexist a moment).
  const goto = async (u) => { const r = await page.goto(u, { waitUntil: "load", timeout: 30000 }); await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); return r; };
  let version = await servedVersion();

  await step(page, "smoke_home_first_personal_row", async () => {
    const r = await goto(URL + "/home");
    if (!r || r.status() >= 400) throw new Error("home status " + (r && r.status()));
    const row = page.locator("[data-row]").first();
    await row.waitFor({ state: "visible", timeout: 15000 });
    const key = await row.getAttribute("data-row");
    const cards = await pollUntil(async () => { const n = await row.locator("article.item, .item, a[href]").count(); return n > 0 ? n : null; }, 10000, 500);
    if (!cards) throw new Error(`first personal row ${key} painted without any card`);
    return `status ${r.status()}, first row=${key} cards=${cards}, rows=${await page.locator("[data-row]").count()}`;
  });

  await step(page, "smoke_local_track_plays", async () => {
    // Fixture lid: already in the library, served by /localf (no acquisition, like smoke.sh #8).
    await goto(URL + "/listen?id=" + LID).catch(() => {});
    const btn = page.getByRole("button", { name: /start listening|écouter|ecouter|lire/i }).first();
    await btn.click({ timeout: 15000 });
    const m0 = await pollUntil(async () => { const m = await media(page); return m && m.src ? m : null; }, 25000, 500);
    if (!m0) throw new Error("no media src for local lid " + LID);
    if (!/\/localf/.test(m0.src)) throw new Error("expected a /localf source for lid " + LID + ", got " + m0.src.slice(0, 80));
    const s0 = await pollUntil(async () => { const m = await media(page); return m && m.t > 0 ? m : null; }, 20000, 500);
    if (!s0) throw new Error("currentTime stays at 0 for lid " + LID);
    await sleep(2000);
    const s1 = await media(page);
    if (!s1 || !(s1.t > s0.t)) throw new Error("currentTime not advancing " + JSON.stringify(s0) + " -> " + JSON.stringify(s1));
    return `lid=${LID} src=${m0.src.slice(URL.length, URL.length + 28)} t ${s0.t.toFixed(1)}->${s1.t.toFixed(1)}`;
  });

  await step(page, "smoke_service_worker", async () => {
    const sw = await pollUntil(async () => page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return { none: true };
      const r = await navigator.serviceWorker.getRegistration();
      if (!r || !(r.active || r.waiting || r.installing)) return null;
      const w = r.active || r.waiting || r.installing;
      return { scope: r.scope, state: w.state, script: (w.scriptURL || "").replace(/^https?:\/\/[^/]+/, ""), controller: !!navigator.serviceWorker.controller };
    }).catch(() => null), 15000, 500);
    if (!sw) throw new Error("no service worker registration after 15 s");
    if (sw.none) throw new Error("navigator.serviceWorker unavailable (insecure context ?)");
    if (!/service-worker\.js$/.test(sw.script)) throw new Error("unexpected SW script " + sw.script);
    return `scope=${sw.scope.replace(URL, "") || "/"} state=${sw.state} controller=${sw.controller}`;
  });

  await step(page, "smoke_version", async () => {
    if (!version) version = await page.evaluate(async () => { try { return (await (await fetch("/api/v1/stats/library", { cache: "no-store" })).json()).version || null; } catch { return null; } }).catch(() => null);
    if (!version) throw new Error("served version unreadable (stats/library)");
    if (EXPECT && version !== EXPECT) throw new Error(`served version ${version} != expected ${EXPECT}`);
    return EXPECT ? `served=${version} = expected` : `served=${version} (no expected sha given)`;
  });

  await step(page, "smoke_under_budget", async () => {
    const ms = Date.now() - STARTED;
    if (ms > TOTAL_BUDGET_MS) throw new Error(`${(ms / 1000).toFixed(0)} s > ${TOTAL_BUDGET_MS / 1000} s`);
    return `${(ms / 1000).toFixed(0)} s / ${TOTAL_BUDGET_MS / 1000} s, page errors=${pageErrors.length}`;
  });

  fs.writeFileSync(path.join(OUT, "pageerrors.log"), pageErrors.join("\n"));
  await ctx.close(); await browser.close();
  const report = writeReport(version);
  process.exit(report.failed ? 1 : 0);
})().catch((e) => { console.log("FATAL", String((e && e.message) || e)); try { writeReport(null); } catch {} process.exit(1); });
