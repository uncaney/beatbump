import { describe, expect, it } from "vitest";
import { HOME_CACHE_KEY, clearHomeCache, emptyHomeCacheRows, peekHomeCache, readHomeCache, slimCard, writeHomeCache } from "./homeCache";

const card = (id: string, extra: Record<string, any> = {}): Record<string, any> => ({
	videoId: id,
	title: `Title ${id}`,
	thumbnails: [
		{ url: `https://img/${id}-small.jpg`, width: 60, height: 60 },
		{ url: `https://img/${id}.jpg`, width: 240, height: 240 },
	],
	artistInfo: { artist: [{ text: `Artist ${id}`, browseId: `la-${id}` }] },
	loggingContext: { huge: "blob".repeat(50) },
	clickTrackingParams: "xyz",
	...extra,
});

function memoryStorage(initial: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initial));
	return {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		_raw: store,
	};
}

describe("slimCard", () => {
	it("keeps only the first thumbnail and drops tracking blobs", () => {
		const out = slimCard(card("a"));
		expect(out.thumbnails).toHaveLength(1);
		expect(out.thumbnails[0].url).toBe("https://img/a-small.jpg");
		expect(out).not.toHaveProperty("loggingContext");
		expect(out).not.toHaveProperty("clickTrackingParams");
		expect(out.title).toBe("Title a");
		expect(out.videoId).toBe("a");
	});
	it("passes through non-object input unchanged", () => {
		expect(slimCard(null as any)).toBeNull();
		expect(slimCard(undefined as any)).toBeUndefined();
	});
});

describe("writeHomeCache / readHomeCache", () => {
	it("round-trips rows for the same profile", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")], pourToi: [card("f1")], recemmentAcquis: [card("a1")] });
		const rows = readHomeCache(storage, "p1");
		expect(rows?.reprendre.map((c) => c.videoId)).toEqual(["r1"]);
		expect(rows?.pourToi.map((c) => c.videoId)).toEqual(["f1"]);
		expect(rows?.recemmentAcquis.map((c) => c.videoId)).toEqual(["a1"]);
	});
	it("caps each row to 20 slim cards", () => {
		const storage = memoryStorage();
		const many = Array.from({ length: 40 }, (_, i) => card(`t${i}`));
		writeHomeCache(storage, "p1", { reprendre: many });
		const rows = readHomeCache(storage, "p1");
		expect(rows?.reprendre).toHaveLength(20);
	});
	it("returns null for a different profile (never leaks another profile's rows)", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] });
		expect(readHomeCache(storage, "p2")).toBeNull();
		expect(readHomeCache(storage, "")).toBeNull();
	});
	it("ignores a cache older than 7 days", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] });
		const raw = JSON.parse(storage.getItem(HOME_CACHE_KEY)!);
		raw.savedAt = Date.now() - (7 * 24 * 60 * 60 * 1000 + 1000);
		storage.setItem(HOME_CACHE_KEY, JSON.stringify(raw));
		expect(readHomeCache(storage, "p1")).toBeNull();
	});
	it("rejects an unknown envelope version", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] });
		const raw = JSON.parse(storage.getItem(HOME_CACHE_KEY)!);
		raw.v = 2;
		storage.setItem(HOME_CACHE_KEY, JSON.stringify(raw));
		expect(readHomeCache(storage, "p1")).toBeNull();
	});
	it("never throws on corrupted JSON, missing storage or missing rows", () => {
		expect(readHomeCache({ getItem: () => "{not json" }, "p1")).toBeNull();
		expect(readHomeCache(undefined, "p1")).toBeNull();
		expect(readHomeCache({ getItem: () => JSON.stringify({ v: 1, savedAt: Date.now(), profileId: "p1" }) }, "p1")).toBeNull();
	});
	it("writeHomeCache is a no-op without a profile id or a settable storage", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "", { reprendre: [card("r1")] });
		expect(storage.getItem(HOME_CACHE_KEY)).toBeNull();
		// a storage without setItem (e.g. a readonly stub) must not throw
		expect(() => writeHomeCache({ getItem: () => null }, "p1", { reprendre: [card("r1")] })).not.toThrow();
	});
});

describe("peekHomeCache", () => {
	it("reads any valid envelope regardless of profile, for the optimistic first paint", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] });
		const snap = peekHomeCache(storage);
		expect(snap?.profileId).toBe("p1");
		expect(snap?.rows.reprendre.map((c) => c.videoId)).toEqual(["r1"]);
	});
	it("still honors the TTL and version checks", () => {
		expect(peekHomeCache(undefined)).toBeNull();
		expect(peekHomeCache({ getItem: () => "{not json" })).toBeNull();
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] });
		const raw = JSON.parse(storage.getItem(HOME_CACHE_KEY)!);
		raw.savedAt = Date.now() - (7 * 24 * 60 * 60 * 1000 + 1);
		storage.setItem(HOME_CACHE_KEY, JSON.stringify(raw));
		expect(peekHomeCache(storage)).toBeNull();
	});
});

describe("clearHomeCache", () => {
	it("removes the key and is a safe no-op when already empty or storage-less", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] });
		clearHomeCache(storage);
		expect(storage.getItem(HOME_CACHE_KEY)).toBeNull();
		expect(() => clearHomeCache(undefined)).not.toThrow();
		expect(() => clearHomeCache({ getItem: () => null })).not.toThrow();
	});
});

describe("emptyHomeCacheRows", () => {
	it("gives an empty row set", () => {
		expect(emptyHomeCacheRows()).toEqual({ reprendre: [], pourToi: [], recemmentAcquis: [] });
	});
});
