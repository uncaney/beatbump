// c52d: one-step probe of the Espace card (/library/downloads-offline) pack start. Expands the card,
// selects 100 Mo, taps pack-start, then reports: page errors, window.__ytmPackPlan.state (JS state),
// the pack-start text (DOM), whether [pack-progress] exists, and whether the card still reacts to its
// toggle (aria-expanded flips) = Svelte scheduler alive or wedged.
// run.sh <url> <query> probe-c52d-pack.cjs
const C52D_SKIP = new Set();
const STEP_NAMES = ["pack_start_probe"];
async function run(deps) {
  const { page, URL, step, sleep } = deps;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e).slice(0, 160)));
  await step(page, "pack_start_probe", async () => {
    await page.goto(URL + "/library/downloads-offline", { waitUntil: "load", timeout: 45000 });
    const tg = page.locator('[data-testid="space-toggle"]').first();
    await tg.waitFor({ state: "visible", timeout: 15000 });
    if ((await tg.getAttribute("aria-expanded")) !== "true") { await tg.click({ timeout: 5000 }); await sleep(500); }
    const size = page.locator('[data-testid="pack-size"]').first();
    await size.waitFor({ state: "visible", timeout: 10000 });
    await size.selectOption("100");
    const start = page.locator('[data-testid="pack-start"]').first();
    await start.waitFor({ state: "visible", timeout: 10000 });
    const errBefore = errors.length;
    await start.click({ timeout: 5000 });
    await sleep(8000);
    const snap = async () => page.evaluate(() => ({
      js: window.__ytmPackPlan ? { state: window.__ytmPackPlan.state, count: window.__ytmPackPlan.count, progress: window.__ytmPackPlan.progress } : null,
      startText: (document.querySelector('[data-testid="pack-start"]') || {}).textContent?.trim() || null,
      startDisabled: !!(document.querySelector('[data-testid="pack-start"]') || {}).disabled,
      sizeDisabled: !!(document.querySelector('[data-testid="pack-size"]') || {}).disabled,
      progress: document.querySelector('[data-testid="pack-progress"]') ? document.querySelector('[data-testid="pack-progress"]').getAttribute("data-state") : null,
      expanded: (document.querySelector('[data-testid="space-toggle"]') || {}).getAttribute?.("aria-expanded"),
    }));
    const s1 = await snap();
    // Does the component still react? Toggle the card and read aria-expanded.
    await page.evaluate(() => document.querySelector('[data-testid="space-toggle"]').click());
    await sleep(800);
    const s2 = await snap();
    return `pageerrors=${JSON.stringify(errors.slice(errBefore))}; after click: ${JSON.stringify(s1)}; after toggle click: expanded ${s1.expanded} -> ${s2.expanded}, startText=${JSON.stringify(s2.startText)}`;
  });
}
module.exports = { run, C52D_SKIP, STEP_NAMES };
