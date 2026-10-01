import { describe, expect, it } from "vitest";
import {
	MEDIA_RETRY_TTL_MS,
	cacheBustUrl,
	claimMediaRetry,
	claimMediaRetryAttempt,
	planMediaRetry,
	type MediaRetryInput,
	type MediaRetryRecord,
} from "./mediaRetry";

describe("claimMediaRetry", () => {
	it("grants one retry per track, then refuses within the window", () => {
		const m = new Map<string, number>();
		expect(claimMediaRetry(m, "a", 1_000)).toBe(true);
		expect(claimMediaRetry(m, "a", 2_000)).toBe(false);
		expect(claimMediaRetry(m, "b", 2_000)).toBe(true); // other tracks unaffected
		expect(claimMediaRetry(m, "a", 1_000 + MEDIA_RETRY_TTL_MS - 1)).toBe(false);
	});

	it("grants again once the window has elapsed (G21: no retry for ever)", () => {
		const m = new Map<string, number>();
		expect(claimMediaRetry(m, "a", 1_000)).toBe(true);
		expect(claimMediaRetry(m, "a", 1_000 + MEDIA_RETRY_TTL_MS)).toBe(true);
		expect(m.get("a")).toBe(1_000 + MEDIA_RETRY_TTL_MS);
	});

	it("prunes expired entries and ignores an empty id", () => {
		const m = new Map<string, number>();
		claimMediaRetry(m, "old", 0);
		claimMediaRetry(m, "fresh", MEDIA_RETRY_TTL_MS - 1);
		expect(claimMediaRetry(m, "x", MEDIA_RETRY_TTL_MS)).toBe(true);
		expect(m.has("old")).toBe(false);
		expect(m.has("fresh")).toBe(true);
		expect(claimMediaRetry(m, "", 5)).toBe(false);
		expect(m.has("")).toBe(false);
	});
});

describe("claimMediaRetryAttempt (H1)", () => {
	it("counts attempts per track: 1, 2, then refused within the window", () => {
		const m = new Map<string, MediaRetryRecord>();
		expect(claimMediaRetryAttempt(m, "a", 1_000)).toBe(1);
		expect(claimMediaRetryAttempt(m, "b", 1_100)).toBe(1); // other tracks unaffected
		expect(claimMediaRetryAttempt(m, "a", 2_000)).toBe(2);
		expect(claimMediaRetryAttempt(m, "a", 3_000)).toBe(0);
		expect(claimMediaRetryAttempt(m, "a", 1_000 + MEDIA_RETRY_TTL_MS - 1)).toBe(0);
	});

	it("restarts at 1 once the window (from the first attempt) elapsed, prunes, ignores empty id", () => {
		const m = new Map<string, MediaRetryRecord>();
		expect(claimMediaRetryAttempt(m, "a", 0)).toBe(1);
		expect(claimMediaRetryAttempt(m, "a", MEDIA_RETRY_TTL_MS - 1)).toBe(2);
		expect(claimMediaRetryAttempt(m, "a", MEDIA_RETRY_TTL_MS)).toBe(1);
		claimMediaRetryAttempt(m, "old", 0);
		claimMediaRetryAttempt(m, "x", 3 * MEDIA_RETRY_TTL_MS);
		expect(m.has("old")).toBe(false);
		expect(claimMediaRetryAttempt(m, "", 5)).toBe(0);
		expect(m.has("")).toBe(false);
	});
});

describe("cacheBustUrl", () => {
	it("adds or replaces _r and keeps query + hash", () => {
		expect(cacheBustUrl("/vp?u=abc", 7)).toBe("/vp?u=abc&_r=7");
		expect(cacheBustUrl("https://x/y", 7)).toBe("https://x/y?_r=7");
		expect(cacheBustUrl("/vp?u=abc&_r=1#t", 9)).toBe("/vp?u=abc&_r=9#t");
		expect(cacheBustUrl("", 9)).toBe("");
	});
});

describe("planMediaRetry (H1)", () => {
	const base: MediaRetryInput = {
		attempt: 1,
		failedSrc: "https://m/vp?u=sig",
		failedSrcStable: false,
		cachedUrl: "https://m/vp?u=sig",
		localCopy: false,
		pinned: false,
		online: true,
		now: 42,
	};

	it("first attempt never purges: plain reload, cache-busted only for non-stable URLs", () => {
		expect(planMediaRetry(base)).toEqual({ kind: "reload", url: "https://m/vp?u=sig&_r=42" });
		expect(planMediaRetry({ ...base, failedSrc: "https://m/aud/v1", failedSrcStable: true })).toEqual({ kind: "reload", url: "https://m/aud/v1" });
		expect(planMediaRetry({ ...base, failedSrc: "" })).toEqual({ kind: "refetch", purge: false, bypassCache: false });
		expect(planMediaRetry({ ...base, online: false, pinned: true })).toEqual({ kind: "reload", url: "https://m/vp?u=sig&_r=42" });
	});

	it("second attempt within the window may purge a cached, unpinned, online entry", () => {
		expect(planMediaRetry({ ...base, attempt: 2 })).toEqual({ kind: "refetch", purge: true, bypassCache: true });
		expect(planMediaRetry({ ...base, attempt: 2, cachedUrl: "" })).toEqual({ kind: "refetch", purge: false, bypassCache: true });
	});

	it("never purges a pinned entry (or an unknown pin state)", () => {
		expect(planMediaRetry({ ...base, attempt: 2, pinned: true })).toEqual({ kind: "refetch", purge: false, bypassCache: true });
		expect(planMediaRetry({ ...base, attempt: 2, pinned: null })).toEqual({ kind: "refetch", purge: false, bypassCache: true });
	});

	it("never purges a /localf copy", () => {
		expect(planMediaRetry({ ...base, attempt: 2, localCopy: true })).toEqual({ kind: "refetch", purge: false, bypassCache: true });
	});

	it("offline: never purges, the second attempt gives up and keeps the copy", () => {
		expect(planMediaRetry({ ...base, attempt: 2, online: false })).toEqual({ kind: "give_up" });
	});

	it("gives up when no attempt is left", () => {
		expect(planMediaRetry({ ...base, attempt: 0 })).toEqual({ kind: "give_up" });
		expect(planMediaRetry({ ...base, attempt: 3 })).toEqual({ kind: "give_up" });
	});
});
