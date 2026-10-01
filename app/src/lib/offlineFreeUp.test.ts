import { describe, expect, it } from "vitest";
import { freeUpSummary, planFreeUp } from "./offlineFreeUp";

const MB = 1024 * 1024;
const e = (videoId: string, bytes: number, lastAccess: number, extra: Record<string, unknown> = {}) => ({ videoId, url: "/aud/" + videoId, bytes, at: lastAccess, lastAccess, ...extra });

describe("planFreeUp", () => {
	it("takes the least recently accessed entries first until the target is reached", () => {
		const entries = [e("new", 4 * MB, 300), e("old", 4 * MB, 100), e("mid", 4 * MB, 200)];
		const p = planFreeUp(entries, 7 * MB);
		expect(p.entries.map((x) => x.videoId)).toEqual(["old", "mid"]);
		expect(p.bytes).toBe(8 * MB);
		expect(p.count).toBe(2);
		expect(p.reached).toBe(true);
		expect(p.target).toBe(7 * MB);
	});

	it("never touches pinned entries, even when the target cannot be met", () => {
		const entries = [e("p1", 50 * MB, 10, { pinned: true }), e("a", 3 * MB, 20), e("p2", 50 * MB, 30, { pinned: true })];
		const p = planFreeUp(entries, 20 * MB);
		expect(p.entries.map((x) => x.videoId)).toEqual(["a"]);
		expect(p.reached).toBe(false);
		expect(p.bytes).toBe(3 * MB);
		expect(p.protectedBytes).toBe(100 * MB);
	});

	it("leaves protected ids (now playing, batch in flight) alone", () => {
		const entries = [e("playing", 4 * MB, 1), e("b", 4 * MB, 2)];
		const p = planFreeUp(entries, 4 * MB, { protect: ["playing"] });
		expect(p.entries.map((x) => x.videoId)).toEqual(["b"]);
	});

	it("falls back to `at` when lastAccess is missing and ignores size-less entries", () => {
		const entries = [
			{ videoId: "noSize", url: "/aud/noSize", bytes: 0, at: 1, lastAccess: 1 },
			{ videoId: "atOnly", url: "/aud/atOnly", bytes: 2 * MB, at: 5 },
			e("recent", 2 * MB, 50),
		];
		const p = planFreeUp(entries, 3 * MB);
		expect(p.entries.map((x) => x.videoId)).toEqual(["atOnly", "recent"]);
	});

	it("plans nothing for a non-positive target, an empty cache, or null rows", () => {
		expect(planFreeUp([e("a", MB, 1)], 0).entries).toEqual([]);
		expect(planFreeUp([e("a", MB, 1)], -5).reached).toBe(false);
		expect(planFreeUp([], 500 * MB).entries).toEqual([]);
		expect(planFreeUp([null, undefined, e("a", MB, 1)], MB).entries.map((x) => x!.videoId)).toEqual(["a"]);
	});

	it("stops as soon as the target is reached (does not over-free)", () => {
		const entries = [e("a", 10 * MB, 1), e("b", 10 * MB, 2), e("c", 10 * MB, 3)];
		const p = planFreeUp(entries, 10 * MB);
		expect(p.entries.map((x) => x.videoId)).toEqual(["a"]);
	});
});

describe("freeUpSummary", () => {
	it("reads count + Mo in French", () => {
		expect(freeUpSummary({ count: 0, bytes: 0 })).toBe("Rien à libérer");
		expect(freeUpSummary({ count: 1, bytes: 3.6 * MB })).toBe("1\u00a0morceau · 3,6\u202fMo");
		expect(freeUpSummary({ count: 12, bytes: 480 * MB })).toBe("12\u00a0morceaux · 480\u202fMo");
	});
});
