import { describe, expect, it } from "vitest";
import { WEEKEND_PACK_HREF, hasPackMaterial, shouldShowWeekendCard } from "./weekendCard";

// 2026-10-02 is a Friday. Local-time constructors (the card reads getDay()).
const thu = new Date(2026, 9, 1, 20, 0);
const fri = new Date(2026, 9, 2, 8, 0);
const sat = new Date(2026, 9, 3, 12, 0);
const sun = new Date(2026, 9, 4, 23, 30);
const mon = new Date(2026, 9, 5, 7, 0);
const nextFri = new Date(2026, 9, 9, 9, 0);

describe("shouldShowWeekendCard", () => {
	it("shows Friday to Sunday only", () => {
		expect(shouldShowWeekendCard(thu, null)).toBe(false);
		expect(shouldShowWeekendCard(fri, null)).toBe(true);
		expect(shouldShowWeekendCard(sat, undefined)).toBe(true);
		expect(shouldShowWeekendCard(sun, "")).toBe(true);
		expect(shouldShowWeekendCard(mon, null)).toBe(false);
	});

	it("a dismissal hides it for the rest of that weekend, not the next one", () => {
		const dismissed = String(fri.getTime());
		expect(shouldShowWeekendCard(sat, dismissed)).toBe(false);
		expect(shouldShowWeekendCard(sun, fri.getTime())).toBe(false);
		expect(shouldShowWeekendCard(nextFri, dismissed)).toBe(true);
	});

	it("ignores a garbage stored value", () => {
		expect(shouldShowWeekendCard(sat, "yes")).toBe(true);
		expect(shouldShowWeekendCard(sat, "-5")).toBe(true);
	});
});

describe("hasPackMaterial", () => {
	it("needs one favourite or recent track with a videoId", () => {
		expect(hasPackMaterial([], [])).toBe(false);
		expect(hasPackMaterial(null, undefined)).toBe(false);
		expect(hasPackMaterial([{ browseId: "MPRE1" }], [])).toBe(false);
		expect(hasPackMaterial([], [{ videoId: "abc" }])).toBe(true);
		expect(hasPackMaterial([{ videoId: "f" }], null)).toBe(true);
	});

	it("links to the Hors-ligne page with a 2 h pack", () => {
		expect(WEEKEND_PACK_HREF).toBe("/library/downloads-offline?pack=dur:7200");
	});
});
