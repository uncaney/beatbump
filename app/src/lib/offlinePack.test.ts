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

import { NNBSP } from "./utils/formatFr";
import {
	LAST_PACK_KEY,
	PACK_DATA_SAVER_CAP,
	PACK_DEFAULT_BPS,
	PACK_EST_BYTES,
	PACK_EST_SECONDS,
	averageBytesPerSecond,
	cutPackToBytes,
	estimatePackBytes,
	guardPackSpace,
	lastPackOf,
	listenedPackIds,
	originRoom,
	packDoneOf,
	packDurationText,
	packLabel,
	packRefreshPreviewTitle,
	packRefreshRows,
	packRefreshSummary,
	UNKNOWN_TITLE,
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

describe("B7-8 space guard (L12-14)", () => {
	const NB = " ";
	it("averageBytesPerSecond measures the cached entries with a known length, default under two", () => {
		const secs = new Map([
			["a", 100],
			["b", 300],
		]);
		expect(averageBytesPerSecond([{ videoId: "a", bytes: 1_000_000 }, { videoId: "b", bytes: 3_000_000 }, { videoId: "c", bytes: 9 }], secs)).toBe(10_000);
		expect(averageBytesPerSecond([{ videoId: "a", bytes: 1_000_000 }], secs)).toBe(PACK_DEFAULT_BPS);
		expect(averageBytesPerSecond(null, null)).toBe(PACK_DEFAULT_BPS);
		expect(PACK_DEFAULT_BPS).toBe(17476); // 1 Mo per minute
	});

	it("estimatePackBytes uses the known size, else the length at the bitrate", () => {
		const p = planPack({ favorites: [tr("a", { _bytes: 10 * MB, duration: 600 }), tr("b", { duration: 120 })] }, 3600, "seconds");
		expect(estimatePackBytes(p, 10_000)).toBe(10 * MB + 1_200_000);
	});

	it("fits: an unlimited quota never refuses, a quota keeps 10 % headroom above the pinned bytes", () => {
		const p = planPack({ favorites: [tr("a", { duration: 600 }), tr("b", { duration: 600 })] }, 3600, "seconds");
		const bps = 10_000; // 6 Mo per track
		const free = guardPackSpace(p, { quota: 0, pinnedBytes: 5_000 * MB }, bps);
		expect(free.fits).toBe(true);
		expect(free.limit).toBe("none");
		expect(free.available).toBe(Infinity);
		expect(free.shrunk).toBe(p);
		expect(free.message).toBe("");
		// 100 Mo quota, 80 Mo pinned: 18 Mo usable, 12 Mo asked.
		const ok = guardPackSpace(p, { quota: 100 * MB, pinnedBytes: 80 * MB }, bps);
		expect(ok.fits).toBe(true);
		expect(ok.available).toBe(Math.floor(20 * MB * 0.9));
		expect(ok.limit).toBe("quota");
	});

	it("too big: cuts the plan to the head that fits and names the demand, what fits and why", () => {
		const favs = Array.from({ length: 12 }, (_, i) => tr("t" + i, { duration: 600 }));
		const p = planPack({ favorites: favs }, 7200, "seconds"); // 12 x 10 min = 2 h
		const bps = Math.round(MB / 60); // 10 Mo per track, 120 Mo asked
		const g = guardPackSpace(p, { quota: 500 * MB, pinnedBytes: 450 * MB }, bps); // 45 Mo usable
		expect(g.fits).toBe(false);
		expect(g.limit).toBe("quota");
		expect(g.estimated).toBe(12 * 600 * bps);
		expect(g.shrunk.count).toBe(4);
		expect(g.shrunk.seconds).toBe(2400);
		expect(g.shrunk.mode).toBe("seconds");
		expect(g.shrunk.target).toBe(7200);
		expect(g.shrunk.left).toBe(8);
		expect(g.shrunk.items.map((i) => i.videoId)).toEqual(["t0", "t1", "t2", "t3"]);
		expect(g.message).toBe(`Pas assez de place : 2 h demandées (≈ 120${NB}Mo), 40 min tiennent dans les 45${NB}Mo libres (quota 500${NB}Mo, 450${NB}Mo épinglés).`);
	});

	it("too big: nothing fits when the pinned bytes already reach the quota", () => {
		const p = planPack({ favorites: [tr("a", { duration: 600 })] }, 1800, "seconds");
		const g = guardPackSpace(p, { quota: 100 * MB, pinnedBytes: 100 * MB });
		expect(g.fits).toBe(false);
		expect(g.available).toBe(0);
		expect(g.shrunk.count).toBe(0);
		expect(g.message).toBe(`Pas assez de place : 30 min demandées (≈ 10${NB}Mo), rien ne tient dans les 0${NB}Mo libres (quota 100${NB}Mo, 100${NB}Mo épinglés).`);
	});

	it("L13-4: the room the browser grants the origin bounds the pack when it is lower than the quota room", () => {
		const p = planPack({ favorites: [tr("a", { duration: 600 }), tr("b", { duration: 600 })] }, 3600, "seconds");
		const g = guardPackSpace(p, { quota: 0, pinnedBytes: 0, originFree: 12 * MB }, Math.round(MB / 60));
		expect(g.fits).toBe(false);
		expect(g.limit).toBe("origin");
		expect(g.available).toBe(Math.floor(12 * MB * 0.9));
		expect(g.shrunk.count).toBe(1);
		// Named for what it is (the site's storage), never "the device is full".
		expect(g.message).toContain("l'espace accordé au site est presque plein");
		expect(g.message).not.toContain("appareil");
		// An unknown estimate (null / NaN) bounds nothing.
		expect(guardPackSpace(p, { quota: 0, pinnedBytes: 0, originFree: null }).fits).toBe(true);
	});

	it("L13-4: originRoom = quota - usage + the unpinned (evictable) audio bytes, null without an estimate", () => {
		expect(originRoom(null)).toBeNull();
		expect(originRoom({ quota: 0, usage: 0 })).toBeNull();
		expect(originRoom({ quota: NaN, usage: 5 })).toBeNull();
		expect(originRoom({ quota: 100 * MB, usage: 90 * MB })).toBe(10 * MB);
		// 30 Mo cached of which 20 Mo pinned: the 10 Mo unpinned may be evicted for the pack.
		const entries = [
			{ bytes: 20 * MB, pinned: true },
			{ bytes: 6 * MB },
			{ bytes: 4 * MB, pinned: false },
			null,
		];
		expect(originRoom({ quota: 100 * MB, usage: 90 * MB }, entries)).toBe(20 * MB);
		// Never negative.
		expect(originRoom({ quota: 10 * MB, usage: 50 * MB })).toBe(0);
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

	it("listenedPackIds: a play after the pack began with >= 50 % / >= 2 min listened; never an SW serve (L13-1)", () => {
		const p = pack(1_000_000); // p1 600 s, p2 300 s, p3 900 s
		const got = listenedPackIds(p, {
			plays: [
				{ videoId: "p1", playedAt: 1_000_001, seconds: 300 }, // after the pack, half of 600 s
				{ videoId: "p2", playedAt: 999_999, seconds: 300 }, // before the pack: not listened since
				{ videoId: "p3", playedAt: 1_000_002, seconds: 120, duration: 900 }, // 2 min of a 15 min track
				{ videoId: "zz", playedAt: 2_000_000, seconds: 500 }, // not in the pack
				null,
			],
			entries: [
				{ videoId: "p2", at: 1_000_500, lastAccess: 1_000_900 }, // served after caching (startup restore): NOT listened
			],
		});
		expect([...got].sort()).toEqual(["p1", "p3"]);
		// a server play (no seconds), a 2 s skip, a short listen: not listened
		const weak = listenedPackIds(p, {
			plays: [
				{ videoId: "p1", playedAt: 1_000_001 },
				{ videoId: "p2", playedAt: 1_000_001, seconds: 2 },
				{ videoId: "p3", playedAt: 1_000_001, seconds: 119, duration: 900 },
			],
			entries: [{ videoId: "p1", at: 1_000_500, lastAccess: 1_000_900 }],
		});
		expect(weak.size).toBe(0);
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
		// L13-16: a drop the SW did not uncache stays in the remembered pack (it is still pinned).
		const partial = refreshedLastPack(p, r, 5, ["p3", "not-in-pack", null, ""]);
		expect(partial.items.map((i) => i.videoId)).toEqual(["p2", "p3", "n1", "n3"]);
		expect(partial.items.find((i) => i.videoId === "p3")?.seconds).toBe(900);
		expect(refreshedLastPack(p, r, 5, []).items.map((i) => i.videoId)).toEqual(["p2", "n1", "n3"]);
	});

	it("B8-11: packRefreshRows names the tracks to drop from any source at hand, never hides an unknown one", () => {
		const p = pack();
		const r = planPackRefresh(p, ["p1", "p3"], { favorites: [tr("n1", { duration: 600 })] });
		const rows = packRefreshRows(r.drop, [
			null,
			{ videoId: "p1", title: "  Around the World ", artistInfo: { artist: [{ text: "Daft Punk" }] } },
			{ videoId: "p1", title: "duplicate later: ignored", artist: "Nobody" },
			{ videoId: "n1", title: "not dropped" },
		]);
		expect(rows).toEqual([
			{ videoId: "p1", title: "Around the World", artist: "Daft Punk", seconds: 600 },
			{ videoId: "p3", title: UNKNOWN_TITLE, artist: "", seconds: 900 },
		]);
		// `name` is accepted as a title, a known item without an artist says so
		expect(packRefreshRows([{ videoId: "x", seconds: 0 }], [{ videoId: "x", name: "Nom" }])).toEqual([{ videoId: "x", title: "Nom", artist: "Artiste inconnu", seconds: 0 }]);
		expect(packRefreshRows([], null)).toEqual([]);
		expect(packRefreshPreviewTitle(r)).toBe("2 titres écoutés seront retirés du pack (25 min) et remplacés par 1 nouveau (10 min) :");
		const one = planPackRefresh(p, ["p1"], { favorites: [tr("n1", { duration: 300 }), tr("n2", { duration: 300 })] });
		expect(packRefreshPreviewTitle(one)).toBe("1 titre écouté sera retiré du pack (10 min) et remplacé par 2 nouveaux (10 min) :");
	});

	it("planPackRefresh: the track playing / restored is never dropped (L13-1)", () => {
		const r = planPackRefresh(pack(), ["p1", "p3"], { favorites: [tr("n1", { duration: 600 })] }, ["p3", undefined, null, ""]);
		expect(r.drop.map((i) => i.videoId)).toEqual(["p1"]);
		expect(r.keep.map((i) => i.videoId)).toEqual(["p2", "p3"]);
		expect(r.seconds).toBe(600);
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

	it("B9-6 (L14-11): a listen between preview and confirm changes what the refresh removes", () => {
		const p = pack(1_000_000); // p1 600 s, p2 300 s, p3 900 s
		const cands = { favorites: [tr("n1", { duration: 600 }), tr("n2", { duration: 600 })] };
		// Preview time: only p1 was listened since the pack began.
		const atPreview = listenedPackIds(p, { plays: [{ videoId: "p1", playedAt: 1_000_001, seconds: 400 }] });
		const previewPlan = planPackRefresh(p, atPreview, cands);
		expect(previewPlan.drop.map((i) => i.videoId)).toEqual(["p1"]);
		// Confirm time, recomputed from fresh sources: p3 was also heard in between.
		const atConfirm = listenedPackIds(p, {
			plays: [
				{ videoId: "p1", playedAt: 1_000_001, seconds: 400 },
				{ videoId: "p3", playedAt: 1_000_050, seconds: 500, duration: 900 },
			],
		});
		const confirmPlan = planPackRefresh(p, atConfirm, cands);
		expect(confirmPlan.drop.map((i) => i.videoId)).toEqual(["p1", "p3"]);
		expect(confirmPlan.drop.length).toBeGreaterThan(previewPlan.drop.length);
	});
});

describe("U13-2 size before the tap, progress of an adopted pack", () => {
	const item = (id: string, seconds: number, bytes = 0) => ({ item: tr(id), videoId: id, bytes: bytes || PACK_EST_BYTES, estimated: !bytes, seconds, source: "mix" as const });
	const plan = (items: ReturnType<typeof item>[]) => ({
		items,
		bytes: items.reduce((s, i) => s + i.bytes, 0),
		seconds: items.reduce((s, i) => s + i.seconds, 0),
		count: items.length,
		target: 3600,
		mode: "seconds" as const,
		left: 0,
		candidates: items.length,
	});

	it("cutPackToBytes keeps a plan under the cap (also unbounded) and cuts one over it, first fit in plan order", () => {
		// 1 Mo per second: a 100 Mo, b 250 Mo, c 40 Mo.
		const p = plan([item("a", 100), item("b", 250), item("c", 40)]);
		const ok = cutPackToBytes(p, 500 * MB, MB);
		expect(ok.cut).toBe(false);
		expect(ok.plan).toBe(p);
		expect(ok.estimated).toBe(390 * MB);
		expect(cutPackToBytes(p, Infinity, MB).cut).toBe(false);
		const cut = cutPackToBytes(p, PACK_DATA_SAVER_CAP, MB);
		expect(cut.cut).toBe(true);
		expect(cut.plan.items.map((i) => i.videoId)).toEqual(["a", "c"]);
		expect(cut.estimated).toBe(140 * MB);
		expect(cut.plan.seconds).toBe(140);
		expect(cut.plan.count).toBe(2);
		expect(cut.plan.left).toBe(1);
		expect(cut.plan.mode).toBe("seconds");
		expect(cut.plan.target).toBe(3600);
	});

	it("packDurationText adds the bytes against the estimate when it is known", () => {
		expect(packDurationText(3, 19, 12 * 60, 3600, 180 * MB, 1.1 * 1024 * MB)).toBe(`3/19 · 12 min sur 1 h · 180${NNBSP}Mo sur env. 1,1${NNBSP}Go`);
		expect(packDurationText(3, 19, 12 * 60, 3600, 180 * MB, 0)).toBe("3/19 · 12 min sur 1 h");
		expect(packDurationText(0, 19, 0, 3600, 0, 1.1 * 1024 * MB)).toBe(`0/19 · 0 min sur 1 h · 0${NNBSP}Mo sur env. 1,1${NNBSP}Go`);
	});

	it("packDoneOf counts the pack tracks now cached, and trusts a higher ready count in plan order", () => {
		const pack = { items: [{ videoId: "a", seconds: 100, bytes: 10 }, { videoId: "b", seconds: 200, bytes: 20 }, { videoId: "c", seconds: 300, bytes: 30 }] };
		expect(packDoneOf(pack, ["b", "zz"])).toEqual({ count: 1, seconds: 200, bytes: 20 });
		expect(packDoneOf(pack, new Set(["b"]), 2)).toEqual({ count: 2, seconds: 300, bytes: 30 });
		expect(packDoneOf(pack, new Set(["b"]), 1)).toEqual({ count: 1, seconds: 200, bytes: 20 });
		expect(packDoneOf(pack, null, 0)).toEqual({ count: 0, seconds: 0, bytes: 0 });
		expect(packDoneOf(null, ["a"], 3)).toEqual({ count: 0, seconds: 0, bytes: 0 });
	});

	it("the memo keeps the estimate of the pack, ignores a bad one", () => {
		const store = new Map<string, string>();
		const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
		writeLastPack(kv, { ...lastPackOf(plan([item("a", 100)]), 5), estimatedBytes: 1234 });
		expect(readLastPack(kv)?.estimatedBytes).toBe(1234);
		kv.setItem(LAST_PACK_KEY, JSON.stringify({ at: 5, mode: "seconds", target: 3600, items: [{ videoId: "a", seconds: 100, bytes: 1 }], estimatedBytes: -3 }));
		const back = readLastPack(kv);
		expect(back?.items.length).toBe(1);
		expect(back?.estimatedBytes).toBeUndefined();
	});
});
