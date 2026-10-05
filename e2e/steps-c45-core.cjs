// steps-c45-core.cjs: cycle 45 harness addition for harness-core.cjs (lane c45a, B7-13 "Installer chez toi").
// Spliced into harness-core.cjs after the c44 steps with:
//   await require("./steps-c45-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
// Loading this module has no side effect (no browser, no network): everything happens in run().
//
// Gating: C45_SKIP (exported Set) lists step names to skip; env C45_SKIP="a,b" adds to it and
// C45_STEPS_ENABLED=0 skips them all. Steps:
//   bienvenue_page   three phone contexts (390x844, 2x). (1) Desktop UA with navigator.share stubbed:
//                    /bienvenue shows h1 "Installer chez toi", BOTH platforms' three steps
//                    ([data-testid=steps-ios] / [data-testid=steps-android], 3 li each, >= 44 px tall),
//                    the QR svg ([data-testid=bienvenue-qr]) with > 100 rect.module and data-size >= 21,
//                    and "Envoyer à un ami" calls navigator.share with the site base URL (origin + "/").
//                    (2) iPhone UA: only the iPhone steps, the "Et sur Android ?" button (>= 44 px) reveals
//                    the Android ones. (3) No navigator.share, clipboard stubbed: the button copies the base
//                    URL and shows the "Lien copié" toast in [data-testid=alert-container].
const C45_SKIP = new Set(); // chains 48-49: bienvenue_page hung (URL shadowing, fixed by c46b); re-enabled by c47a (B8-16) after a run alone 02/10 03:16 (PASS 2 s)
const STEP_NAMES = ["bienvenue_page"];
const MIN_TAP = 44;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const fmtBox = (b) => (b ? `${b.width.toFixed(0)}x${b.height.toFixed(0)}` : "no box");

// Web Share stub: records the data instead of opening a sheet (headless Linux has no navigator.share).
function shareStub() {
  window.__ytmShare = null;
  Object.defineProperty(navigator, "share", { configurable: true, value: async (d) => { window.__ytmShare = d; } });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
}
// No Web Share at all, a clipboard that records what was written: the copy fallback.
function clipboardStub() {
  window.__ytmCopied = null;
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__ytmCopied = String(t); } } });
}

async function checkSteps(p, testid, parts) {
  const sec = p.locator(`[data-testid="${testid}"]`);
  await sec.waitFor({ state: "visible", timeout: 15000 });
  const items = sec.locator("ol.steps > li");
  const n = await items.count();
  if (n !== 3) throw new Error(`${testid}: ${n} steps (expected 3)`);
  for (let i = 0; i < n; i++) {
    const box = await items.nth(i).boundingBox();
    if (!box || box.height < MIN_TAP) throw new Error(`${testid} step ${i + 1} ${fmtBox(box)} (expected height >= ${MIN_TAP})`);
  }
  const text = ((await sec.innerText().catch(() => "")) || "").replace(/\s+/g, " ");
  const want = testid === "steps-ios" ? ["Safari", "Partager", "écran d'accueil"] : ["Chrome", "menu", "Installer l'application"];
  for (const w of want) if (!text.includes(w)) throw new Error(`${testid}: "${w}" missing in "${text.slice(0, 160)}"`);
  parts.push(`${testid} 3 steps`);
}

async function run(deps) {
  // c52c (B9-13): every context carries X-Ytm-Harness: 1 (prod stats ignore harness plays). Compat: an old
  // harness-core already in memory does not pass deps.newHarnessContext, the fallback inlines the header.
  const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...(o || {}), extraHTTPHeaders: { ...((o && o.extraHTTPHeaders) || {}), "X-Ytm-Harness": "1" } }));
  const { page, browser, URL } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollUntil = deps.pollUntil || (async (fn, timeoutMs, everyMs = 1000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < timeoutMs) { last = await fn(); if (last) return last; await sleep(everyMs); } return last; });
  const enabled = process.env.C45_STEPS_ENABLED !== "0";
  const skip = new Set([...C45_SKIP, ...String(process.env.C45_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const c45step = (name, fn, opts) => (enabled && !skip.has(name) ? deps.step(page, name, fn, opts) : Promise.resolve());
  // c46b: `URL` here is the base-URL STRING destructured from deps, which shadows the global constructor:
  // `new URL(URL)` threw "URL is not a constructor" before the step gate, harness-core logged UNHANDLED and
  // idled with the browser open until the chain timeout (chains 47-50, "hang after arrived_month_row").
  const base = new globalThis.URL(URL).origin + "/";
  const phone = (extra = {}) => newCtx(browser, { ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ...extra });

  await c45step("bienvenue_page", async () => {
    const parts = [];

    // 1. Desktop UA (both platforms), QR, share sheet called with the base URL.
    let ctx1 = await phone();
    try {
      const p = await ctx1.newPage();
      await p.addInitScript(shareStub);
      const res = await p.goto(URL + "/bienvenue", { waitUntil: "load", timeout: 45000 });
      if (!res || res.status() !== 200) throw new Error(`/bienvenue HTTP ${res ? res.status() : "no response"}`);
      const h1 = p.locator("main h1").first();
      await h1.waitFor({ state: "visible", timeout: 20000 });
      const title = ((await h1.innerText()) || "").trim();
      if (!/Installer chez toi/.test(title)) throw new Error(`h1 "${title}" (expected "Installer chez toi")`);
      const platform = await p.locator('[data-testid="bienvenue-page"]').getAttribute("data-platform");
      if (platform !== "desktop") throw new Error(`desktop UA detected as "${platform}"`);
      await checkSteps(p, "steps-ios", parts);
      await checkSteps(p, "steps-android", parts);

      const qr = p.locator('svg[data-testid="bienvenue-qr"]');
      await qr.waitFor({ state: "visible", timeout: 15000 });
      const size = parseInt((await qr.getAttribute("data-size")) || "0", 10);
      const rects = await qr.locator("rect.module").count();
      if (!(size >= 21)) throw new Error(`QR data-size ${size} (expected >= 21)`);
      if (!(rects > 100)) throw new Error(`QR has ${rects} dark modules (expected > 100)`);
      const qb = await qr.boundingBox();
      if (!qb || qb.width < 120 || qb.height < 120) throw new Error(`QR box ${fmtBox(qb)} (expected >= 120 px)`);
      const label = (await qr.getAttribute("aria-label")) || "";
      if (!label.includes(base)) throw new Error(`QR aria-label "${label}" does not carry the base URL ${base}`);
      parts.push(`QR ${size}x${size}, ${rects} modules, ${fmtBox(qb)}`);

      const btn = p.locator('[data-testid="bienvenue-share"]');
      await btn.waitFor({ state: "visible", timeout: 10000 });
      const bb = await btn.boundingBox();
      if (!bb || bb.height < MIN_TAP) throw new Error(`"Envoyer à un ami" ${fmtBox(bb)} (expected height >= ${MIN_TAP})`);
      const btnText = ((await btn.innerText()) || "").replace(/\s+/g, " ").trim();
      if (!/Envoyer à un ami/.test(btnText)) throw new Error(`share button text "${btnText}"`);
      await btn.click({ timeout: 8000 });
      const shared = await pollUntil(() => p.evaluate(() => window.__ytmShare), 10000, 250);
      if (!shared || typeof shared.url !== "string") throw new Error("navigator.share not called after the click");
      if (shared.url !== base) throw new Error(`navigator.share url "${shared.url}" (expected the base URL ${base})`);
      parts.push(`share url ${shared.url}`);

      for (const tid of ["about-bienvenue", "account-bienvenue"]) {
        const path = tid === "about-bienvenue" ? "/about" : "/library/account";
        await p.goto(URL + path, { waitUntil: "load", timeout: 45000 });
        const a = p.locator(`[data-testid="${tid}"]`);
        await a.waitFor({ state: "visible", timeout: 20000 });
        const href = await a.getAttribute("href");
        const ab = await a.boundingBox();
        if (href !== "/bienvenue") throw new Error(`${tid} href "${href}"`);
        if (!ab || ab.height < MIN_TAP) throw new Error(`${tid} ${fmtBox(ab)} (expected height >= ${MIN_TAP})`);
      }
      parts.push("links from /about and Compte");
    } finally { await ctx1.close(); }

    // 2. iPhone UA: only the iPhone steps, "Et sur Android ?" reveals the other list.
    const ctx2 = await phone({ userAgent: IPHONE_UA });
    try {
      const p = await ctx2.newPage();
      await p.addInitScript(shareStub);
      await p.goto(URL + "/bienvenue", { waitUntil: "load", timeout: 45000 });
      const main = p.locator('[data-testid="bienvenue-page"]');
      await main.waitFor({ state: "visible", timeout: 20000 });
      const platform = await pollUntil(async () => { const v = await main.getAttribute("data-platform"); return v === "ios" ? v : null; }, 10000, 250);
      if (platform !== "ios") throw new Error(`iPhone UA detected as "${await main.getAttribute("data-platform")}"`);
      if (await p.locator('[data-testid="steps-android"]').count()) throw new Error("Android steps shown on an iPhone before 'Et sur Android ?'");
      await checkSteps(p, "steps-ios", parts);
      const other = p.locator('[data-testid="bienvenue-other"]');
      await other.waitFor({ state: "visible", timeout: 10000 });
      const ob = await other.boundingBox();
      if (!ob || ob.height < MIN_TAP) throw new Error(`"Et sur Android ?" ${fmtBox(ob)} (expected height >= ${MIN_TAP})`);
      await other.click({ timeout: 8000 });
      await checkSteps(p, "steps-android", parts);
      parts.push("iPhone UA: ios only, then both");
    } finally { await ctx2.close(); }

    // 3. No Web Share: the link is copied and the toast says so.
    const ctx3 = await phone();
    try {
      const p = await ctx3.newPage();
      await p.addInitScript(clipboardStub);
      await p.goto(URL + "/bienvenue", { waitUntil: "load", timeout: 45000 });
      const btn = p.locator('[data-testid="bienvenue-share"]');
      await btn.waitFor({ state: "visible", timeout: 20000 });
      await btn.click({ timeout: 8000 });
      const copied = await pollUntil(() => p.evaluate(() => window.__ytmCopied), 10000, 250);
      if (copied !== base) throw new Error(`clipboard got "${copied}" (expected ${base})`);
      const toast = await pollUntil(async () => {
        const t = ((await p.locator('[data-testid="alert-container"]').innerText().catch(() => "")) || "").replace(/\s+/g, " ");
        return /Lien copié/.test(t) ? t.trim() : null;
      }, 8000, 250);
      if (!toast) throw new Error('no "Lien copié" toast after the clipboard fallback');
      parts.push(`fallback copied ${copied}, toast "${toast.slice(0, 40)}"`);
    } finally { await ctx3.close(); }

    return parts.join("; ");
  }, { budgetMs: 120000 });
}

module.exports = { run, C45_SKIP, STEP_NAMES };
