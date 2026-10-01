import { describe, expect, it, vi } from "vitest";
import { HOME_CACHE_KEY, HOME_CACHE_ROW_KEYS, HOME_CACHE_VERSION, clearHomeCache, createPersistScheduler, emptyHomeCacheRows, peekHomeCache, readHomeCache, slimCard, writeHomeCache } from "./homeCache";

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
	it("AP4 (c30a): round-trips, slims and caps the three cycle-29 rows too", () => {
		const storage = memoryStorage();
		const many = Array.from({ length: 25 }, (_, i) => card(`j${i}`));
		writeHomeCache(storage, "p1", {
			redecouvrir: [card("r1")],
			nouveautes: [card("n1"), card("n2")],
			jamaisEcoute: many,
		});
		const rows = readHomeCache(storage, "p1");
		expect(rows?.redecouvrir.map((c) => c.videoId)).toEqual(["r1"]);
		expect(rows?.nouveautes.map((c) => c.videoId)).toEqual(["n1", "n2"]);
		expect(rows?.jamaisEcoute).toHaveLength(20);
		expect(rows?.jamaisEcoute[0]).not.toHaveProperty("loggingContext");
		expect(rows?.jamaisEcoute[0].thumbnails).toHaveLength(1);
		// rows not written are empty, never undefined
		expect(rows?.reprendre).toEqual([]);
		expect(HOME_CACHE_ROW_KEYS).toEqual(["reprendre", "pourToi", "recemmentAcquis", "redecouvrir", "nouveautes", "jamaisEcoute"]);
	});
	it("ignores v1 (three-row) and v2 (no album of the day) envelopes: the version is now 3", () => {
		expect(HOME_CACHE_VERSION).toBe(3);
		const v1 = { v: 1, savedAt: Date.now(), profileId: "p1", rows: { reprendre: [card("r1")], pourToi: [], recemmentAcquis: [] } };
		expect(readHomeCache({ getItem: () => JSON.stringify(v1) }, "p1")).toBeNull();
		const v2 = { v: 2, savedAt: Date.now(), profileId: "p1", rows: { ...emptyHomeCacheRows(), reprendre: [card("r1")] } };
		expect(readHomeCache({ getItem: () => JSON.stringify(v2) }, "p1")).toBeNull();
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
		raw.v = 99;
		storage.setItem(HOME_CACHE_KEY, JSON.stringify(raw));
		expect(readHomeCache(storage, "p1")).toBeNull();
	});
	it("never throws on corrupted JSON, missing storage or missing rows", () => {
		expect(readHomeCache({ getItem: () => "{not json" }, "p1")).toBeNull();
		expect(readHomeCache(undefined, "p1")).toBeNull();
		expect(readHomeCache({ getItem: () => JSON.stringify({ v: HOME_CACHE_VERSION, savedAt: Date.now(), profileId: "p1" }) }, "p1")).toBeNull();
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
		expect(emptyHomeCacheRows()).toEqual({ reprendre: [], pourToi: [], recemmentAcquis: [], redecouvrir: [], nouveautes: [], jamaisEcoute: [] });
	});
});

describe("L9-8 debounced home cache writes", () => {
	it("six row loads in a burst cost one write", () => {
		vi.useFakeTimers();
		try {
			const write = vi.fn();
			const p = createPersistScheduler(write, 600);
			for (let i = 0; i < 6; i++) {
				p.schedule();
				vi.advanceTimersByTime(100);
			}
			expect(write).not.toHaveBeenCalled();
			vi.advanceTimersByTime(600);
			expect(write).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(5000);
			expect(write).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("flush writes a pending snapshot at once, and only once", () => {
		vi.useFakeTimers();
		try {
			const write = vi.fn();
			const p = createPersistScheduler(write, 600);
			p.flush();
			expect(write).not.toHaveBeenCalled(); // nothing pending
			p.schedule();
			p.flush();
			expect(write).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1000);
			expect(write).toHaveBeenCalledTimes(1);
			p.schedule();
			p.cancel();
			vi.advanceTimersByTime(1000);
			p.flush();
			expect(write).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("album of the day in the cache (c39b v3)", () => {
	const aod = (date: string) => ({
		album: { title: "Discovery", browseId: "lb-0123456789ab", subtitle: [{ text: "Daft Punk" }], thumbnails: [{ url: "/cover?lid=a" }, { url: "/cover?lid=b" }], loggingContext: { x: 1 } },
		year: "2001",
		date,
		tracks: [card("t1"), card("t2")],
	});
	const at = (iso: string) => new Date(iso).getTime();

	it("round-trips the card (slim, no tracks) and paints it on its own UTC day", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] }, aod(new Date().toISOString().slice(0, 10)));
		const snap = peekHomeCache(storage);
		expect(snap?.albumOfDay?.album.browseId).toBe("lb-0123456789ab");
		expect(snap?.albumOfDay?.album.thumbnails).toHaveLength(1);
		expect(snap?.albumOfDay?.album).not.toHaveProperty("loggingContext");
		expect(snap?.albumOfDay?.year).toBe("2001");
		expect(snap?.albumOfDay?.tracks).toEqual([]);
		expect(JSON.parse(storage.getItem(HOME_CACHE_KEY)!).albumOfDay.tracks).toEqual([]);
	});

	it("drops yesterday's card at UTC midnight, keeps the rows", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] }, aod("2026-10-01"));
		const raw = JSON.parse(storage.getItem(HOME_CACHE_KEY)!);
		raw.savedAt = at("2026-10-01T20:00:00Z");
		storage.setItem(HOME_CACHE_KEY, JSON.stringify(raw));
		expect(peekHomeCache(storage, at("2026-10-01T23:59:00Z"))?.albumOfDay?.date).toBe("2026-10-01");
		const next = peekHomeCache(storage, at("2026-10-02T00:01:00Z"));
		expect(next?.albumOfDay).toBeNull();
		expect(next?.rows.reprendre.map((c) => c.videoId)).toEqual(["r1"]);
	});

	it("no card written, or a malformed one, reads null", () => {
		const storage = memoryStorage();
		writeHomeCache(storage, "p1", { reprendre: [card("r1")] });
		expect(peekHomeCache(storage)?.albumOfDay).toBeNull();
		const raw = JSON.parse(storage.getItem(HOME_CACHE_KEY)!);
		raw.albumOfDay = { album: { title: "YT", browseId: "MPREb_x" }, date: new Date().toISOString().slice(0, 10) };
		storage.setItem(HOME_CACHE_KEY, JSON.stringify(raw));
		expect(peekHomeCache(storage)?.albumOfDay).toBeNull();
	});
});
