import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, toMs } from "./_byDay";

// Thursday 1 October 2026, 15:00 local time.
const NOW = new Date(2026, 9, 1, 15, 0, 0).getTime();
const at = (d: number, h: number) => new Date(2026, 8 + (d > 30 ? 1 : 0), d > 30 ? d - 30 : d, h, 0, 0).getTime();
const row = (id: string) => ({ videoId: id, title: id });

describe("recent by day (S3)", () => {
	it("labels today, yesterday and older days in French", () => {
		expect(dayLabel(NOW - 3600_000, NOW)).toBe("Aujourd'hui");
		expect(dayLabel(at(30, 23), NOW)).toBe("Hier");
		expect(dayLabel(at(29, 10), NOW)).toBe("mardi 29 septembre");
		expect(dayLabel(new Date(2025, 8, 29, 10).getTime(), NOW)).toBe("lundi 29 septembre 2025");
	});

	it("groups by local day, newest day first, replay in listening order", () => {
		const items = [row("a"), row("b"), row("c"), row("d")];
		const playedAt = [at(31, 14), at(31, 9), at(29, 20), at(29, 8)];
		const g = groupByDay(items, playedAt, NOW)!;
		expect(g.map((x) => x.label)).toEqual(["Aujourd'hui", "mardi 29 septembre"]);
		expect(g[0].items.map((x) => x.videoId)).toEqual(["a", "b"]);
		expect(g[0].replay.map((x) => x.videoId)).toEqual(["b", "a"]);
		expect(g[1].replay.map((x) => x.videoId)).toEqual(["d", "c"]);
	});

	it("reads per-row playedAt (ISO or seconds) and drops rows without a time", () => {
		const items = [
			{ ...row("a"), playedAt: new Date(at(31, 12)).toISOString() },
			{ ...row("b"), _playedAt: Math.floor(at(30, 12) / 1000) },
			row("c"),
		];
		const g = groupByDay(items, undefined, NOW)!;
		expect(g.map((x) => [x.label, x.items.length])).toEqual([
			["Aujourd'hui", 1],
			["Hier", 1],
		]);
	});

	it("returns null without any play time (flat list kept)", () => {
		expect(groupByDay([row("a")], undefined, NOW)).toBeNull();
		expect(groupByDay(null, undefined, NOW)).toBeNull();
		expect(toMs("nope")).toBeNaN();
	});
});
