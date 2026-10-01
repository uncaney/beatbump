import { describe, expect, it } from "vitest";
import { MEDIA_RETRY_TTL_MS, claimMediaRetry } from "./mediaRetry";

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
