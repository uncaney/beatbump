import { describe, expect, it } from "vitest";
import {
	buildReleaseLine,
	durationSeconds,
	formatReleaseDuration,
	isYearToken,
	releaseDurationSeconds,
	releaseYear,
} from "./releaseMeta";

describe("durationSeconds", () => {
	it("reads the YouTube English labels", () => {
		expect(durationSeconds("1 hour, 14 minutes")).toBe(74 * 60);
		expect(durationSeconds("74 minutes")).toBe(74 * 60);
		expect(durationSeconds("1 hr 14 min")).toBe(74 * 60);
		expect(durationSeconds("2 hours")).toBe(7200);
		expect(durationSeconds("45 seconds")).toBe(45);
		expect(durationSeconds("3 minutes, 20 seconds")).toBe(200);
	});
	it("reads the French label the local backend sends", () => {
		expect(durationSeconds("1 h 14 min")).toBe(74 * 60);
		expect(durationSeconds("4 min")).toBe(240);
	});
	it("reads clocks and numeric seconds", () => {
		expect(durationSeconds("1:14:05")).toBe(4445);
		expect(durationSeconds("4:03")).toBe(243);
		expect(durationSeconds(4440)).toBe(4440);
		expect(durationSeconds("300")).toBe(300);
	});
	it("never takes a bare year for seconds", () => {
		expect(durationSeconds("2013")).toBe(0);
		expect(durationSeconds("1999")).toBe(0);
		expect(isYearToken("2013")).toBe(true);
		expect(isYearToken("2013 seconds")).toBe(false);
	});
	it("is empty on junk", () => {
		expect(durationSeconds("")).toBe(0);
		expect(durationSeconds(undefined)).toBe(0);
		expect(durationSeconds(null)).toBe(0);
		expect(durationSeconds("13 songs")).toBe(0);
		expect(durationSeconds(-5)).toBe(0);
		expect(durationSeconds(NaN)).toBe(0);
	});
});

describe("formatReleaseDuration", () => {
	it("formats in French, rounding to the minute", () => {
		expect(formatReleaseDuration("1 hour, 14 minutes")).toBe("1 h 14 min");
		expect(formatReleaseDuration("74 minutes")).toBe("1 h 14 min");
		expect(formatReleaseDuration(243)).toBe("4 min");
		expect(formatReleaseDuration(3600)).toBe("1 h");
		expect(formatReleaseDuration(20)).toBe("1 min");
		expect(formatReleaseDuration("2013")).toBe("");
	});
});

describe("releaseYear / releaseDurationSeconds", () => {
	it("takes the fields by shape when the backend swapped the YouTube runs", () => {
		const swapped = { year: "1 hour, 14 minutes", tracks: "13 songs", length: "2013" };
		expect(releaseYear(swapped)).toBe("2013");
		expect(releaseDurationSeconds(swapped)).toBe(74 * 60);
	});
	it("still reads the straight shape", () => {
		const straight = { year: "2013", tracks: "13 songs", length: "1 hour, 14 minutes" };
		expect(releaseYear(straight)).toBe("2013");
		expect(releaseDurationSeconds(straight)).toBe(74 * 60);
	});
	it("prefers the label, falls back to the numeric durationSec", () => {
		expect(releaseDurationSeconds({ year: "2023", tracks: "1 songs", length: "4 min", durationSec: 243 })).toBe(240);
		expect(releaseDurationSeconds({ year: "2023", tracks: "1 songs", length: "", durationSec: 243 })).toBe(243);
		expect(releaseDurationSeconds({ durationSec: 0 })).toBe(0);
	});
	it("finds a year inside a composite subtitle", () => {
		expect(releaseYear({ year: "Album • 2013" })).toBe("2013");
		expect(releaseYear({ year: 2013 })).toBe("2013");
		expect(releaseYear({ year: "" })).toBe("");
		expect(releaseYear(undefined)).toBe("");
	});
});

describe("buildReleaseLine", () => {
	it("YouTube album with swapped runs (audit v7 TOP 4): year and real length", () => {
		expect(
			buildReleaseLine({ year: "1 hour, 14 minutes", tracks: "13 songs", length: "2013" }),
		).toBe("Album · 13 titres · 2013 · 1 h 14 min");
	});
	it("local album from local_pages.go", () => {
		expect(
			buildReleaseLine({ year: "2023", tracks: "1 songs", length: "4 min", durationSec: 243 }),
		).toBe("Album · 1 titre · 2023 · 4 min");
	});
	it("drops the unknown parts and keeps the type label", () => {
		expect(buildReleaseLine({ tracks: 5 })).toBe("Album · 5 titres");
		expect(buildReleaseLine({ type: "single", tracks: "1 song", year: "2005" })).toBe("Single · 1 titre · 2005");
		expect(buildReleaseLine({ type: "ep", tracks: 0 })).toBe("EP");
		expect(buildReleaseLine({})).toBe("Album");
		expect(buildReleaseLine(null)).toBe("Album");
	});
});
