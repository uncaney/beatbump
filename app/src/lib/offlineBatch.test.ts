import { describe, expect, it, vi } from "vitest";

// offlineBatch imports $lib/offline (SW helpers); the pure core takes its deps
// as a parameter, so the module is stubbed out here.
vi.mock("$lib/offline", () => ({
	cacheTrackOffline: vi.fn(),
	deviceOffline: () => false,
	downloadForOffline: vi.fn(),
	isStableAudioUrl: () => false,
	listCachedAudio: vi.fn(),
	pinOffline: vi.fn(),
	requestPersistentStorage: vi.fn(),
}));

import { cancelKeepJob, findKeepJob, jobMatchesKey, keepAliases, keepItemOfflineWith, keepMenuKey, KEEP_OFFLINE_MSG, KEEP_RUNNING_MSG, keepJobs, keepLabel, keepOffline, keepSummary, keepableTracks, QUOTA_MSG, rowOfflineState, startKeepJob, type KeepDeps, type KeepResult } from "./offlineBatch";
import { get } from "svelte/store";

const MB = 1024 * 1024;
const tr = (id: string, extra: Record<string, unknown> = {}) => ({ videoId: id, title: "T " + id, ...extra });

function fakeDeps(opts: { cached?: string[]; quota?: number; pinnedBytes?: number; failDl?: string[]; quotaDl?: string[]; bytes?: number }) {
	const cached = new Set(opts.cached ?? []);
	const downloads: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const deps: KeepDeps = {
		pin: async (t) => (cached.has(t.videoId) ? { ok: true } : { ok: false, reason: "not_cached" }),
		download: async (t) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			downloads.push(t.videoId);
			await new Promise((r) => setTimeout(r, 2));
			inFlight--;
			if (opts.failDl?.includes(t.videoId)) return { ok: false, reason: "no stream url" };
			if (opts.quotaDl?.includes(t.videoId)) return { ok: false, reason: "quota" };
			cached.add(t.videoId);
			return { ok: true, bytes: opts.bytes ?? 4 * MB };
		},
		cacheInfo: async () => ({ quota: opts.quota ?? 0, pinnedBytes: opts.pinnedBytes ?? 0, avgBytes: 4 * MB }),
	};
	return { deps, downloads, maxInFlight: () => maxInFlight };
}

describe("keepableTracks", () => {
	it("keeps one entry per videoId and drops albums / artists / playlists", () => {
		const out = keepableTracks([
			tr("a"),
			tr("a"),
			{ title: "Album", endpoint: { pageType: "MUSIC_PAGE_TYPE_ALBUM", browseId: "MPRE" } },
			{ videoId: "x", endpoint: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } },
			{ videoId: "p", type: "playlist" },
			tr("b"),
			null,
		]);
		expect(out.map((t) => t.videoId)).toEqual(["a", "b"]);
	});
});

describe("keepOffline", () => {
	it("pins cached tracks and downloads the rest 2 at a time", async () => {
		const f = fakeDeps({ cached: ["a"] });
		const seen: string[] = [];
		const r = await keepOffline([tr("a"), tr("b"), tr("c"), tr("d"), tr("e")], { onProgress: (p) => seen.push(`${p.ready}/${p.total}`) }, f.deps);
		expect(r).toEqual({ ready: 5, failed: 0, refused: 0, total: 5, cancelled: false });
		expect(f.downloads.sort()).toEqual(["b", "c", "d", "e"]);
		expect(f.maxInFlight()).toBe(2);
		expect(seen.at(-1)).toBe("5/5");
		expect(seen).toContain("1/5");
	});

	it("counts failed downloads", async () => {
		const f = fakeDeps({ failDl: ["b"] });
		const r = await keepOffline([tr("a"), tr("b")], {}, f.deps);
		expect(r).toMatchObject({ ready: 1, failed: 1, refused: 0, total: 2 });
	});

	it("refuses before downloading when the quota cannot hold the next track", async () => {
		const f = fakeDeps({ quota: 10 * MB, pinnedBytes: 0 });
		// 4 MB estimate each: 2 fit (8 MB), the third would reach 12 MB.
		const r = await keepOffline([tr("a"), tr("b"), tr("c"), tr("d")], {}, f.deps);
		expect(r.ready).toBe(2);
		expect(r.refused).toBe(2);
		expect(f.downloads.length).toBe(2);
	});

	it("stops on a SW quota refusal and refuses the remaining tracks", async () => {
		const f = fakeDeps({ quotaDl: ["a"] });
		const r = await keepOffline([tr("a"), tr("b"), tr("c"), tr("d"), tr("e")], {}, f.deps);
		expect(r.refused + r.ready + r.failed).toBe(5);
		expect(r.refused).toBeGreaterThanOrEqual(3);
		expect(f.downloads.length).toBeLessThanOrEqual(2);
	});

	it("refuses every download once a cached track was refused by the quota", async () => {
		const deps: KeepDeps = {
			pin: async (t) => (t.videoId === "a" ? { ok: false, reason: "quota" } : { ok: false, reason: "not_cached" }),
			download: vi.fn(async () => ({ ok: true })),
			cacheInfo: async () => null,
		};
		const r = await keepOffline([tr("a"), tr("b"), tr("c")], {}, deps);
		expect(r).toMatchObject({ ready: 0, refused: 3, failed: 0 });
		expect(deps.download).not.toHaveBeenCalled();
	});

	it("cancels: nothing new starts after abort", async () => {
		const f = fakeDeps({});
		const ac = new AbortController();
		const r = await keepOffline(
			[tr("a"), tr("b"), tr("c"), tr("d"), tr("e"), tr("f")],
			{ signal: ac.signal, onProgress: (p) => (p.ready >= 2 ? ac.abort() : undefined) },
			f.deps,
		);
		expect(r.cancelled).toBe(true);
		expect(r.ready).toBeLessThan(6);
		expect(f.downloads.length).toBeLessThan(6);
	});

	it("empty list: nothing to do", async () => {
		const r = await keepOffline([], {}, fakeDeps({}).deps);
		expect(r).toEqual({ ready: 0, failed: 0, refused: 0, total: 0, cancelled: false });
	});
});

describe("labels", () => {
	it("keepLabel", () => {
		expect(keepLabel(null, false)).toBe("Garder hors-ligne");
		expect(keepLabel({ ready: 9, failed: 0, refused: 0, total: 14 }, true)).toBe("9/14 prêts");
		expect(keepLabel({ ready: 14, failed: 0, refused: 0, total: 14 }, false)).toBe("Prêt hors-ligne");
	});
	it("keepSummary", () => {
		expect(keepSummary({ ready: 3, failed: 0, refused: 0, total: 3, cancelled: false }).text).toBe("3 morceaux prêts hors-ligne");
		expect(keepSummary({ ready: 0, failed: 0, refused: 1, total: 1, cancelled: false }).text).toBe(QUOTA_MSG);
		const s = keepSummary({ ready: 2, failed: 1, refused: 2, total: 5, cancelled: false });
		expect(s.type).toBe("error");
		expect(s.text).toBe("2 prêts sur 5 · 2 refusés : quota atteint, augmente-le dans Réglages · 1 impossible à télécharger");
		expect(keepSummary({ ready: 2, failed: 0, refused: 0, total: 5, cancelled: true }).text).toBe("Annulé : 2 sur 5 prêts hors-ligne");
	});
});

describe("rowOfflineState", () => {
	const cached = new Set(["a"]);
	it("ready when cached, online or not", () => {
		expect(rowOfflineState("a", cached, false)).toBe("ready");
		expect(rowOfflineState("a", cached, true)).toBe("ready");
	});
	it("unavailable only offline and not cached", () => {
		expect(rowOfflineState("b", cached, true)).toBe("unavailable");
		expect(rowOfflineState("b", cached, false)).toBe("");
	});
	it("no videoId (album, artist): nothing", () => {
		expect(rowOfflineState(undefined, cached, true)).toBe("");
	});
});

describe("keepJobs (I12)", () => {
	it("runs outside the component, joins a running job, clears at the end", async () => {
		const { deps, downloads } = fakeDeps({});
		const seen: Array<number | undefined> = [];
		const unsub = keepJobs.subscribe((m) => seen.push(m.get("/album/x")?.progress?.ready));
		let done: KeepResult | null = null;
		const p1 = startKeepJob("/album/x", () => [tr("a"), tr("b")], { deps, onDone: (r) => (done = r) });
		const p2 = startKeepJob("/album/x", () => [tr("zzz")], { deps });
		expect(get(keepJobs).has("/album/x")).toBe(true);
		const r = await p1;
		expect(await p2).toBe(r);
		expect(r?.ready).toBe(2);
		expect(done).toEqual(r);
		expect(downloads.sort()).toEqual(["a", "b"]);
		expect(get(keepJobs).has("/album/x")).toBe(false);
		unsub();
	});
	it("only cancelKeepJob stops it", async () => {
		const { deps } = fakeDeps({});
		const p = startKeepJob("/album/y", () => [tr("a"), tr("b"), tr("c"), tr("d"), tr("e")], { deps });
		cancelKeepJob("/album/y");
		const r = await p;
		expect(r?.cancelled).toBe(true);
	});
});

describe("menu Garder hors-ligne (I13)", () => {
	const album = { title: "Discovery", playlistId: "OLAK5uy_abc", endpoint: { pageType: "MUSIC_PAGE_TYPE_ALBUM", browseId: "MPREb_disc" } };
	const menuDeps = (over: Partial<Parameters<typeof keepItemOfflineWith>[1]> = {}) => {
		const toasts: Array<{ msg: string; action?: { label: string; run: () => void } }> = [];
		const fetched: string[] = [];
		const { deps } = fakeDeps({});
		return {
			toasts,
			fetched,
			deps: {
				offline: () => false,
				notify: (msg: string, _t: "success" | "error", action?: { label: string; run: () => void }) => void toasts.push({ msg, action }),
				fetchQueue: async (id: string) => {
					fetched.push(id);
					return [tr("a"), tr("b"), tr("c")];
				},
				keep: deps,
				...over,
			},
		};
	};
	it("offline: says so and starts nothing", async () => {
		const m = menuDeps({ offline: () => true });
		expect(await keepItemOfflineWith(album, m.deps)).toBeNull();
		expect(m.toasts.map((t) => t.msg)).toEqual([KEEP_OFFLINE_MSG]);
		expect(m.fetched).toEqual([]);
		expect(get(keepJobs).size).toBe(0);
	});
	it("a second menu click on the same album joins the running batch (déjà en cours)", async () => {
		const m = menuDeps();
		const p1 = keepItemOfflineWith(album, m.deps);
		const p2 = keepItemOfflineWith({ ...album }, m.deps);
		expect(m.toasts.some((t) => t.msg === KEEP_RUNNING_MSG && t.action?.label === "Annuler")).toBe(true);
		const r = await p1;
		expect(await p2).toBe(r);
		expect(r?.ready).toBe(3);
		expect(m.fetched).toEqual(["OLAK5uy_abc"]);
	});
	it("the start toast cancels the batch", async () => {
		const m = menuDeps();
		const p = keepItemOfflineWith(album, m.deps);
		await new Promise((r) => setTimeout(r, 0));
		const start = m.toasts.find((t) => /morceaux : téléchargement/.test(t.msg));
		expect(start?.action?.label).toBe("Annuler");
		start!.action!.run();
		const r = await p;
		expect(r?.cancelled).toBe(true);
		expect(m.toasts.at(-1)?.msg).toMatch(/^Annulé/);
	});
	it("matches the album page button key and the menu key", () => {
		expect(keepAliases(album)).toEqual(["MPREb_disc", "OLAK5uy_abc"]);
		expect(keepMenuKey(album)).toBe("keep:MPREb_disc");
		const menuJob = { key: "keep:MPREb_disc", aliases: keepAliases(album) };
		expect(jobMatchesKey(menuJob, "/release?type=album&id=MPREb_disc")).toBe(true);
		expect(jobMatchesKey(menuJob, "/release?id=MPREb_discX")).toBe(false);
		const pageJob = { key: "/release?id=MPREb_disc", aliases: [] };
		expect(jobMatchesKey(pageJob, "keep:MPREb_disc", keepAliases(album))).toBe(true);
		expect(jobMatchesKey(pageJob, "keep:other", ["other"])).toBe(false);
		const jobs = new Map([[pageJob.key, { ...pageJob, progress: null, ctrl: new AbortController(), done: Promise.resolve(null) }]]);
		expect(findKeepJob(jobs, "keep:MPREb_disc", keepAliases(album))?.key).toBe("/release?id=MPREb_disc");
		expect(keepAliases(tr("solo"))).toEqual(["solo"]);
		expect(keepAliases(tr("solo", { endpoint: { browseId: "MPREb_disc" } }))).toEqual(["solo"]);
	});
});

describe("keepOffline pins per track (I15)", () => {
	it("a batch cut midway keeps the tracks it finished pinned", async () => {
		const pinned: string[] = [];
		const cached = new Set<string>();
		const ctrl = new AbortController();
		const deps: KeepDeps = {
			pin: async (t) => {
				if (!cached.has(t.videoId)) return { ok: false, reason: "not_cached" };
				pinned.push(t.videoId);
				return { ok: true };
			},
			download: async (t) => {
				await new Promise((r) => setTimeout(r, t.videoId === "a" ? 1 : 20));
				cached.add(t.videoId);
				return { ok: true, bytes: MB };
			},
			cacheInfo: async () => null,
		};
		const p = keepOffline([tr("a"), tr("b"), tr("c"), tr("d")], {
			signal: ctrl.signal,
			onProgress: (pr) => {
				if (pr.ready === 1) ctrl.abort(); // network cut / Annuler after the first one
			},
		}, deps);
		const r = await p;
		expect(r.cancelled).toBe(true);
		expect(pinned[0]).toBe("a"); // pinned before the rest of the batch finished
		expect(pinned).not.toContain("d");
	});
	it("re-downloads once a track evicted between its write and its pin", async () => {
		const cached = new Set<string>();
		const downloads: string[] = [];
		let evictOnce = true;
		const deps: KeepDeps = {
			pin: async (t) => {
				if (t.videoId === "a" && evictOnce && downloads.includes("a")) {
					evictOnce = false;
					cached.delete("a"); // B's write ran the LRU
				}
				return cached.has(t.videoId) ? { ok: true } : { ok: false, reason: "not_cached" };
			},
			download: async (t) => {
				downloads.push(t.videoId);
				cached.add(t.videoId);
				return { ok: true, bytes: MB };
			},
			cacheInfo: async () => null,
		};
		const r = await keepOffline([tr("a"), tr("b")], {}, deps);
		expect(r).toMatchObject({ ready: 2, failed: 0, refused: 0 });
		expect(downloads.filter((x) => x === "a")).toHaveLength(2);
	});
	it("evicted twice: refused (cache too small), not failed", async () => {
		const deps: KeepDeps = {
			pin: async () => ({ ok: false, reason: "not_cached" }),
			download: async () => ({ ok: true, bytes: MB }),
			cacheInfo: async () => null,
		};
		const r = await keepOffline([tr("a")], {}, deps);
		expect(r).toMatchObject({ ready: 0, failed: 0, refused: 1 });
	});
});

describe("keepOffline I15 (atomic pin)", () => {
	it("asks each download to be written pinned, then confirms the pin", async () => {
		const f = fakeDeps({ cached: ["a"] });
		const calls: Array<unknown> = [];
		const inner = f.deps.download;
		f.deps.download = (t, o) => {
			calls.push([t.videoId, o]);
			return inner(t, o);
		};
		const r = await keepOffline([tr("a"), tr("b"), tr("c")], {}, f.deps);
		expect(r).toEqual({ ready: 3, failed: 0, refused: 0, total: 3, cancelled: false });
		expect(calls.sort()).toEqual([
			["b", { pinned: true }],
			["c", { pinned: true }],
		]);
	});
});
