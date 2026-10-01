import { describe, expect, it } from "vitest";
import { isSeparatorRun, trimSeparatorRuns } from "./subtitleRuns";

const r = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

describe("trimSeparatorRuns", () => {
	it("drops a trailing orphan separator (restored queue row)", () => {
		expect(trimSeparatorRuns([r("Daft Punk", { browseId: "UC1" }), r(" • "), r("One More Time"), r(" • ")])).toEqual([
			r("Daft Punk", { browseId: "UC1" }),
			r(" • "),
			r("One More Time"),
		]);
	});
	it("drops leading separators and empty runs", () => {
		expect(trimSeparatorRuns([r(""), r("•"), r("Song"), r(" · "), r("2001")])).toEqual([r("Song"), r(" · "), r("2001")]);
	});
	it("collapses adjacent separators left by a missing run", () => {
		expect(trimSeparatorRuns([r("A"), r(" • "), r(" • "), r("B")])).toEqual([r("A"), r(" • "), r("B")]);
	});
	it("returns the same array when nothing changes, and [] for all-separator input", () => {
		const runs = [r("A"), r(" • "), r("B")];
		expect(trimSeparatorRuns(runs)).toBe(runs);
		expect(trimSeparatorRuns([r("•"), r(" • ")])).toEqual([]);
		expect(trimSeparatorRuns(null)).toEqual([]);
		expect(trimSeparatorRuns(undefined)).toEqual([]);
	});
	it("treats '|' and whitespace-only runs as separators, keeps real text", () => {
		expect(isSeparatorRun(r(" | "))).toBe(true);
		expect(isSeparatorRun(r("   "))).toBe(true);
		expect(isSeparatorRun(r("Album • 2001"))).toBe(false);
		expect(isSeparatorRun(null)).toBe(true);
	});
});
