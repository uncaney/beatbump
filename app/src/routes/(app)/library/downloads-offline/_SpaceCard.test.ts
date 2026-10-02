// @vitest-environment jsdom
// c52d (chain 60 regression): "Préparer un pack" froze on "Préparation…" with the
// selector greyed and [data-testid=pack-progress] never shown. Cause: the planning
// <progress> was rendered with `value={undefined}`; Svelte 4 assigns the DOM
// property, HTMLProgressElement rejects a non-finite double (jsdom throws the same
// TypeError as Chrome), the throw happens inside Svelte's flush() and the
// scheduler never resets `update_scheduled`: no component of the app re-renders
// again. This mounts the real card and checks the planning bar, the end states
// and that the card still reacts to its toggle afterwards.
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startKeepJob = vi.fn();
const sources = { favorites: [] as any[], recent: [] as any[], mix: [] as any[] };

vi.mock("$app/navigation", () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock("../../../../lib/offline", async () => {
	const { readable } = await import("svelte/store");
	return {
		cachedIds: readable(new Set<string>()),
		getOfflineTracks: () => [],
		listCachedAudio: async () => ({ entries: [], total: 0, pinnedBytes: 0, quota: 0 }),
		requestPersistentStorage: async () => true,
		scheduleSwAudioRefresh: () => {},
		applySwEviction: () => {},
		storageStatus: async () => ({ persisted: null, usage: 0, quota: 0 }),
		swRequest: async () => null,
		abortCacheAudio: () => {},
		cacheTrackOffline: async () => ({ ok: false }),
		deviceOffline: () => false,
		downloadForOffline: async () => ({ ok: false }),
		isStableAudioUrl: () => false,
		pinOffline: async () => ({ ok: false }),
	};
});
vi.mock("../../../../lib/offlineBatch", async (importOriginal) => {
	const orig = (await importOriginal()) as Record<string, unknown>;
	return { ...orig, startKeepJob: (...a: unknown[]) => startKeepJob(...a), cancelKeepJob: vi.fn() };
});
vi.mock("../../../../lib/me", () => ({
	getFavorites: async () => ({ favorites: sources.favorites, items: sources.favorites }),
	getRecent: async () => ({ items: sources.recent, playedAt: [] }),
	getMix: async () => ({ items: sources.mix, seeds: 0 }),
}));
vi.mock("../../../../lib/stores/list", async () => {
	const { readable } = await import("svelte/store");
	return { currentTrack: readable(null) };
});
vi.mock("../../../../lib/utils", () => ({ notify: vi.fn() }));

async function settle(rounds = 6) {
	for (let i = 0; i < rounds; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
}
async function until<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v as T;
		if (Date.now() - t0 > ms) throw new Error("until: timed out");
		await settle(1);
	}
}
const q = <E extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as E | null;

describe("_SpaceCard pack start (c52d, chain 60)", () => {
	let card: { $destroy(): void } | null = null;
	let target: HTMLElement;
	beforeEach(async () => {
		localStorage.clear();
		startKeepJob.mockReset();
		sources.favorites = [];
		sources.recent = [];
		sources.mix = [];
		target = document.body.appendChild(document.createElement("div"));
		const { default: SpaceCard } = await import("./_SpaceCard.svelte");
		card = new SpaceCard({ target });
		await settle();
		// Folded by default: unfold through the disclosure, as the harness does.
		q<HTMLButtonElement>('[data-testid="space-toggle"]')!.click();
		await settle();
	});
	afterEach(() => {
		card?.$destroy();
		card = null;
		target.remove();
	});

	it("shows an indeterminate planning bar, then the status line, and the card still folds", async () => {
		const start = q<HTMLButtonElement>('[data-testid="pack-start"]')!;
		expect(start.disabled).toBe(false);
		start.click();
		await tick();
		// Planning: the progress panel is in the DOM with a bar that has no value (indeterminate).
		const panel = q('[data-testid="pack-progress"]');
		expect(panel, "pack-progress panel right after the tap").not.toBeNull();
		expect(panel!.getAttribute("data-state")).toBe("planning");
		const bar = panel!.querySelector("progress");
		expect(bar, "the planning <progress>").not.toBeNull();
		expect(bar!.hasAttribute("value")).toBe(false);
		expect(start.textContent!.trim()).toBe("Préparation…");
		// Empty sources: "Rien à préparer" as a plain status line, no bar (U13-18).
		const done = await until(() => (q('[data-testid="pack-progress"]')?.getAttribute("data-state") === "done" ? q('[data-testid="pack-progress"]') : null));
		expect(done.getAttribute("data-bar")).toBe("0");
		expect(done.textContent).toMatch(/Rien à préparer/);
		expect(start.disabled).toBe(false);
		expect(start.textContent!.trim()).not.toBe("Préparation…");
		expect(q<HTMLSelectElement>('[data-testid="pack-size"]')!.disabled).toBe(false);
		// The scheduler is alive: the card folds when asked.
		const toggle = q<HTMLButtonElement>('[data-testid="space-toggle"]')!;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		toggle.click();
		await tick();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});

	it("runs a non-empty plan: the bar gets a value and the job starts", async () => {
		sources.favorites = [
			{ videoId: "vid00000001", title: "Un", artists: [{ name: "A" }] },
			{ videoId: "vid00000002", title: "Deux", artists: [{ name: "A" }] },
		];
		q<HTMLButtonElement>('[data-testid="pack-start"]')!.click();
		await tick();
		expect(q('[data-testid="pack-progress"]')?.getAttribute("data-state")).toBe("planning");
		const running = await until(() => (q('[data-testid="pack-progress"]')?.getAttribute("data-state") === "running" ? q('[data-testid="pack-progress"]') : null));
		expect(running.getAttribute("data-total")).toBe("2");
		const bar = running.querySelector("progress")!;
		expect(bar.hasAttribute("value")).toBe(true);
		expect(bar.value).toBe(0);
		expect(startKeepJob).toHaveBeenCalledTimes(1);
		expect(startKeepJob.mock.calls[0][0]).toBe("pack:offline");
		expect(q('[data-testid="pack-cancel"]')).not.toBeNull();
		expect((window as any).__ytmPackPlan?.state).toBe("running");
	});
});
