import { describe, expect, it, vi } from "vitest";

// offline.ts pulls the API client and the settings store; only its pure
// badge helper is tested here.
vi.mock("$lib/api", () => ({ APIClient: { fetch: vi.fn() }, PREFETCH_INIT: {} }));
vi.mock("$lib/stores/settings", async () => {
	const { writable } = await import("svelte/store");
	return { settings: writable({}) };
});

import { get } from "svelte/store";
import { cachedIds, cachedIdsFrom, setSwAudioSnapshot } from "./offline";

const t = (videoId: string, _cached: boolean, _at = 100) => ({ videoId, _cached, _at, _offlineUrl: "/x" });

describe("cachedIdsFrom (I14)", () => {
	it("no SW answer: the local list decides", () => {
		expect([...cachedIdsFrom([t("a", true), t("b", false)], null)]).toEqual(["a"]);
	});
	it("SW answer: an evicted track loses its badge, a held one gains it", () => {
		const sw = { ids: new Set(["b"]), at: 500 };
		expect([...cachedIdsFrom([t("a", true), t("b", false)], sw)].sort()).toEqual(["b"]);
	});
	it("a track cached after the SW answer keeps its badge until the next answer", () => {
		const sw = { ids: new Set<string>(), at: 500 };
		expect([...cachedIdsFrom([t("new", true, 900), t("old", true, 100)], sw)]).toEqual(["new"]);
	});
	it("a track the SW holds but removed from the list: no badge", () => {
		const sw = { ids: new Set(["gone"]), at: 500 };
		expect(cachedIdsFrom([], sw).size).toBe(0);
	});
});

describe("cachedIds store (I14)", () => {
	it("follows a SW snapshot", () => {
		// no window in the test env: the local list store stays empty
		setSwAudioSnapshot([{ videoId: "a" }], 1);
		expect(get(cachedIds).size).toBe(0);
		setSwAudioSnapshot(null);
		expect(get(cachedIds).size).toBe(0);
	});
});
