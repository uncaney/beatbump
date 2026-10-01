import { describe, expect, it, vi } from "vitest";

// offlinePack imports keepableTracks from offlineBatch, which imports the SW
// helpers of $lib/offline: stubbed out, the plan itself is pure.
vi.mock("$lib/offline", () => ({
	cacheTrackOffline: vi.fn(),
	deviceOffline: () => false,
	downloadForOffline: vi.fn(),
	isStableAudioUrl: () => false,
	listCachedAudio: vi.fn(),
	pinOffline: vi.fn(),
	requestPersistentStorage: vi.fn(),
	abortCacheAudio: vi.fn(),
}));

import { PACK_EST_BYTES, packLabel, packSizeOf, planPack } from "./offlinePack";

const MB = 1024 * 1024;
const tr = (id: string, extra: Record<string, unknown> = {}) => ({ videoId: id, title: "T " + id, ...extra });

describe("planPack", () => {
	it("fills favourites first, then recent plays, then the mix, deduped and uncached only", () => {
		const p = planPack(
			{
				favorites: [tr("f1"), tr("f2"), tr("cachedFav")],
				recent: [tr("f1"), tr("r1"), tr("r2")],
				mix: [tr("r2"), tr("m1")],
				cached: ["cachedFav"],
			},
			5 * PACK_EST_BYTES,
		);
		expect(p.items.map((x) => x.videoId)).toEqual(["f1", "f2", "r1", "r2", "m1"]);
		expect(p.items.map((x) => x.source)).toEqual(["favorites", "favorites", "recent", "recent", "mix"]);
		expect(p.bytes).toBe(5 * PACK_EST_BYTES);
		expect(p.count).toBe(5);
		expect(p.left).toBe(0);
		expect(p.candidates).toBe(5);
	});

	it("uses the known size (_bytes, then the sizes map) and the 4 MB estimate otherwise", () => {
		const sizes = new Map([["r1", 2 * MB]]);
		const p = planPack({ favorites: [tr("f1", { _bytes: 10 * MB })], recent: [tr("r1")], mix: [tr("m1")], sizes }, 100 * MB);
		expect(p.items.map((x) => [x.videoId, x.bytes, x.estimated])).toEqual([
			["f1", 10 * MB, false],
			["r1", 2 * MB, false],
			["m1", PACK_EST_BYTES, true],
		]);
		expect(p.bytes).toBe(16 * MB);
	});

	it("stops at the target, first fit: a long track is skipped, shorter ones still fit", () => {
		const p = planPack({ favorites: [tr("a", { _bytes: 6 * MB }), tr("big", { _bytes: 20 * MB }), tr("b", { _bytes: 3 * MB }), tr("c", { _bytes: 3 * MB })] }, 10 * MB);
		expect(p.items.map((x) => x.videoId)).toEqual(["a", "b"]);
		expect(p.bytes).toBe(9 * MB);
		expect(p.left).toBe(2);
		expect(p.candidates).toBe(4);
	});

	it("skips tracks flagged _cached, artists / albums / playlists and rows without a videoId", () => {
		const p = planPack(
			{
				favorites: [tr("x", { _cached: true }), { title: "no id" }, tr("album", { endpoint: { pageType: "MUSIC_PAGE_TYPE_ALBUM" }, playlistId: "OLAK" }), tr("ok")],
			},
			100 * MB,
		);
		expect(p.items.map((x) => x.videoId)).toEqual(["ok"]);
	});

	it("plans nothing without candidates or with a non-positive target", () => {
		expect(planPack(null, 100 * MB).items).toEqual([]);
		expect(planPack({ favorites: null, recent: undefined, mix: [] }, 100 * MB).count).toBe(0);
		const p = planPack({ favorites: [tr("a")] }, 0);
		expect(p.items).toEqual([]);
		expect(p.left).toBe(1);
	});

	it("packSizeOf prefers _bytes over the sizes map and ignores bad numbers", () => {
		expect(packSizeOf(tr("a", { _bytes: -1 }), new Map([["a", 3 * MB]]))).toEqual({ bytes: 3 * MB, estimated: false });
		expect(packSizeOf(tr("a", { _bytes: "nope" }), null)).toEqual({ bytes: PACK_EST_BYTES, estimated: true });
	});
});

describe("packLabel", () => {
	it("reads count + Mo in French", () => {
		expect(packLabel(0, 0, 0, 100 * MB)).toBe("Aucun morceau à préparer");
		expect(packLabel(3, 12, 12.4 * MB, 100 * MB)).toBe("3/12 · 12 Mo sur 100 Mo");
	});
});
