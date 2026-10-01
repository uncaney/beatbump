import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

// offlineBatch imports $lib/offline (SW helpers): stubbed, deps are injected.
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

import { addFailed, clearFailed, failedDownloads, failedLine, failedSnapshot, FAILED_MAX, recordFailed, removeFailed, resetFailed } from "./offlineFailed";
import { keepOffline, startKeepJob, type KeepDeps } from "./offlineBatch";

const tr = (id: string, extra: Record<string, unknown> = {}) => ({ videoId: id, title: "T " + id, ...extra });
const ids = (l: any[]) => l.map((t) => t.videoId);

describe("addFailed / removeFailed", () => {
	it("keeps one entry per videoId, the latest copy last, and ignores id-less items", () => {
		let l = addFailed([], [tr("a"), tr("b")]);
		l = addFailed(l, [tr("a", { title: "new" }), { title: "no id" }, null]);
		expect(ids(l)).toEqual(["b", "a"]);
		expect(l[1].title).toBe("new");
		expect(addFailed(l, [])).toBe(l);
	});
	it("caps the list at FAILED_MAX, dropping the oldest", () => {
		const many = Array.from({ length: FAILED_MAX + 5 }, (_, i) => tr("id" + i));
		const l = addFailed([], many);
		expect(l.length).toBe(FAILED_MAX);
		expect(l[0].videoId).toBe("id5");
	});
	it("removes by id and returns the same list when nothing changes", () => {
		const l = addFailed([], [tr("a"), tr("b"), tr("c")]);
		expect(ids(removeFailed(l, ["b", "zz"]))).toEqual(["a", "c"]);
		expect(removeFailed(l, ["zz"])).toBe(l);
		expect(removeFailed(l, [])).toBe(l);
	});
});

describe("failedLine", () => {
	it("agrees in number", () => {
		expect(failedLine(1)).toBe("1 téléchargement a échoué");
		expect(failedLine(3)).toBe("3 téléchargements ont échoué");
	});
});

describe("failedDownloads store", () => {
	beforeEach(() => resetFailed());
	it("records, clears on success and snapshots", () => {
		recordFailed(tr("a"));
		recordFailed(tr("b"));
		recordFailed(tr("a"));
		recordFailed({ title: "no id" });
		expect(ids(get(failedDownloads))).toEqual(["b", "a"]);
		const snap = failedSnapshot();
		clearFailed("a");
		clearFailed(undefined);
		expect(ids(get(failedDownloads))).toEqual(["b"]);
		expect(ids(snap)).toEqual(["b", "a"]);
	});
});

function deps(failIds: string[]): KeepDeps {
	const cached = new Set<string>();
	return {
		pin: async (t) => (cached.has(t.videoId) ? { ok: true } : { ok: false, reason: "not_cached" }),
		download: async (t) => {
			if (failIds.includes(t.videoId)) return { ok: false, reason: "no stream url" };
			cached.add(t.videoId);
			return { ok: true, bytes: 1 };
		},
		cacheInfo: async () => ({ quota: 0, pinnedBytes: 0, avgBytes: 1 }),
	};
}

describe("keepOffline hooks (UX9)", () => {
	beforeEach(() => resetFailed());
	it("reports each failed and each ready track", async () => {
		const failed: string[] = [];
		const ready: string[] = [];
		const r = await keepOffline([tr("a"), tr("b"), tr("c")], { onFailed: (t) => failed.push(t.videoId), onReady: (t) => ready.push(t.videoId) }, deps(["b"]));
		expect(r.failed).toBe(1);
		expect(failed).toEqual(["b"]);
		expect(ready.sort()).toEqual(["a", "c"]);
	});
	it("a keep job fills the store, a retry that succeeds empties it", async () => {
		await startKeepJob("t:ux9", () => [tr("a"), tr("b")], { deps: deps(["a", "b"]) });
		expect(ids(get(failedDownloads)).sort()).toEqual(["a", "b"]);
		const r = await startKeepJob("retry:failed", () => failedSnapshot(), { deps: deps(["b"]) });
		expect(r?.ready).toBe(1);
		expect(ids(get(failedDownloads))).toEqual(["b"]);
	});
});
