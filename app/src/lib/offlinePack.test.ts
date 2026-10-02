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

import {
	LAST_PACK_KEY,
	PACK_EST_BYTES,
	PACK_EST_SECONDS,
	lastPackOf,
	listenedPackIds,
	packDurationText,
	packLabel,
	packRefreshSummary,
	packSecondsOf,
	packSizeOf,
	parsePackChoice,
	planPack,
	planPackRefresh,
	readLastPack,
	refreshedLastPack,
	writeLastPack,
} from "./offlinePack";

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

describe("planPack by duration (trip pack)", () => {
	it("fills up to the target seconds with the same order and dedup, unknown lengths at 4 min", () => {
		const p = planPack(
			{
				favorites: [tr("f1", { duration: 600 }), tr("f2", { length: "5:00" })],
				recent: [tr("f1", { duration: 600 }), tr("r1")],
				mix: [tr("m1", { duration: 1200 }), tr("m2", { duration: 300 })],
			},
			1800,
			"seconds",
		);
		expect(p.mode).toBe("seconds");
		// 600 + 300 + 240 = 1140; m1 (1200) does not fit; m2 (300) does: 1440.
		expect(p.items.map((x) => [x.videoId, x.seconds])).toEqual([
			["f1", 600],
			["f2", 300],
			["r1", PACK_EST_SECONDS],
			["m2", 300],
		]);
		expect(p.seconds).toBe(1440);
		expect(p.target).toBe(1800);
		expect(p.left).toBe(1);
		expect(p.bytes).toBe(4 * PACK_EST_BYTES);
	});

	it("a 1 h pack of unknown-length tracks holds 15 of them, sizes ignored", () => {
		const favs = Array.from({ length: 40 }, (_, i) => tr("t" + i, { _bytes: 50 * MB }));
		const p = planPack({ favorites: favs }, 3600, "seconds");
		expect(p.count).toBe(15);
		expect(p.seconds).toBe(3600);
		expect(p.left).toBe(25);
	});

	it("packSecondsOf reads duration / durationSec / length and falls back to 4 min", () => {
		expect(packSecondsOf(tr("a", { durationSec: 181.4 }))).toBe(181);
		expect(packSecondsOf(tr("a", { length: "1:02:03" }))).toBe(3723);
		expect(packSecondsOf(tr("a", { duration: "nope" }))).toBe(PACK_EST_SECONDS);
	});

	it("parsePackChoice accepts the offered sizes and durations only", () => {
		expect(parsePackChoice("250")).toEqual({ kind: "bytes", mb: 250 });
		expect(parsePackChoice(100)).toEqual({ kind: "bytes", mb: 100 });
		expect(parsePackChoice("dur:7200")).toEqual({ kind: "seconds", seconds: 7200 });
		expect(parsePackChoice("dur:999")).toBeNull();
		expect(parsePackChoice("42")).toBeNull();
		expect(parsePackChoice(null)).toBeNull();
	});

	it("packDurationText reads done/total and minutes on the target", () => {
		expect(packDurationText(12, 30, 48 * 60, 3600)).toBe("12/30 · 48 min sur 1 h");
		expect(packDurationText(0, 30, 0, 7200)).toBe("0/30 · 0 min sur 2 h");
		expect(packDurationText(0, 0, 0, 1800)).toBe("Aucun morceau à préparer");
	});
});

describe("packLabel", () => {
	it("reads count + Mo in French", () => {
		expect(packLabel(0, 0, 0, 100 * MB)).toBe("Aucun morceau à préparer");
		expect(packLabel(3, 12, 12.4 * MB, 100 * MB)).toBe("3/12 · 12\u202fMo sur 100\u202fMo");
	});
});

describe("B7-7 refresh my pack", () => {
	const pack = (at = 1_000_000) => ({
		at,
		mode: "seconds" as const,
		target: 3600,
		items: [
			{ videoId: "p1", seconds: 600, bytes: 5 * MB },
			{ videoId: "p2", seconds: 300, bytes: 3 * MB },
			{ videoId: "p3", seconds: 900, bytes: 8 * MB },
		],
	});

	it("lastPackOf / write / read round-trip through a storage, bad records ignored", () => {
		const store = new Map<string, string>();
		const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
		const plan = planPack({ favorites: [tr("a", { duration: 600, _bytes: 5 * MB }), tr("b")] }, 3600, "seconds");
		const lp = lastPackOf(plan, 42);
		expect(lp).toEqual({
			at: 42,
			mode: "seconds",
			target: 3600,
			items: [
				{ videoId: "a", seconds: 600, bytes: 5 * MB },
				{ videoId: "b", seconds: PACK_EST_SECONDS, bytes: PACK_EST_BYTES },
			],
		});
		writeLastPack(kv, lp);
		expect(JSON.parse(store.get(LAST_PACK_KEY) || "{}").items).toHaveLength(2);
		expect(readLastPack(kv)).toEqual(lp);
		writeLastPack(kv, null);
		expect(readLastPack(kv)).toBeNull();
		kv.setItem(LAST_PACK_KEY, "{not json");
		expect(readLastPack(kv)).toBeNull();
		kv.setItem(LAST_PACK_KEY, JSON.stringify({ at: "x", items: [{ videoId: "a", seconds: -3 }, { videoId: "a" }, { nope: 1 }] }));
		expect(readLastPack(kv)).toEqual({ at: 0, mode: "seconds", target: 0, items: [{ videoId: "a", seconds: PACK_EST_SECONDS, bytes: PACK_EST_BYTES }] });
		expect(readLastPack(null)).toBeNull();
		expect(
			readLastPack({
				getItem: () => {
					throw new Error("private");
				},
				setItem() {},
				removeItem() {},
			}),
		).toBeNull();
	});

	it("listenedPackIds: a play after the pack began, or an SW entry served after it was cached", () => {
		const p = pack(1_000_000);
		const got = listenedPackIds(p, {
			plays: [
				{ videoId: "p1", playedAt: 1_000_001 }, // after the pack
				{ videoId: "p2", playedAt: 999_999 }, // before the pack: not listened since
				{ videoId: "zz", playedAt: 2_000_000 }, // not in the pack
				null,
			],
			entries: [
				{ videoId: "p3", at: 1_000_500, lastAccess: 1_000_900 }, // served after caching
				{ videoId: "p2", at: 1_000_500, lastAccess: 1_000_500 }, // never served since caching
				{ videoId: "zz", at: 1, lastAccess: 2 },
			],
		});
		expect([...got].sort()).toEqual(["p1", "p3"]);
		expect(listenedPackIds(p, {}).size).toBe(0);
	});

	it("planPackRefresh: drops the listened tracks and plans the same seconds of new tracks, pack ids excluded", () => {
		const p = pack();
		const r = planPackRefresh(p, ["p1", "p3", "nope"], {
			favorites: [tr("p1", { duration: 600 }), tr("n1", { duration: 1200 }), tr("n2", { duration: 300 })],
			recent: [tr("p2", { duration: 300 }), tr("n3", { duration: 100 })],
			cached: ["n2"],
		});
		expect(r.drop.map((i) => i.videoId)).toEqual(["p1", "p3"]);
		expect(r.keep.map((i) => i.videoId)).toEqual(["p2"]);
		expect(r.seconds).toBe(1500);
		expect(r.add.mode).toBe("seconds");
		expect(r.add.target).toBe(1500);
		expect(r.add.items.map((i) => i.videoId)).toEqual(["n1", "n3"]);
		expect(r.add.seconds).toBe(1300);
		expect(packRefreshSummary(r)).toBe("2 titres écoutés remplacés par 2 nouveaux (22 min)");
		const next = refreshedLastPack(p, r, 5);
		expect(next.at).toBe(5);
		expect(next.target).toBe(3600);
		expect(next.items.map((i) => i.videoId)).toEqual(["p2", "n1", "n3"]);
	});

	it("planPackRefresh: nothing listened plans nothing, no candidate keeps the pack whole", () => {
		const none = planPackRefresh(pack(), [], { favorites: [tr("n1")] });
		expect(none.drop).toEqual([]);
		expect(none.seconds).toBe(0);
		expect(none.add.count).toBe(0);
		expect(packRefreshSummary(none)).toBe("Rien à rafraîchir : aucun titre du pack n'a encore été écouté.");
		const dry = planPackRefresh(pack(), ["p2"], { favorites: [tr("p2")], recent: null });
		expect(dry.drop.map((i) => i.videoId)).toEqual(["p2"]);
		expect(dry.add.count).toBe(0);
		expect(packRefreshSummary(dry)).toBe("Rien à rafraîchir : pas de nouveau titre pour remplacer 1 titre écouté (5 min).");
	});
});
