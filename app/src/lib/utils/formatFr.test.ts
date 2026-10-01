import { describe, expect, it } from "vitest";
import { NBSP, NNBSP, formatBytesFr, formatCountFr, formatIntFr, formatMoFr } from "./formatFr";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const u = (s: string) => s.replace(" ", NNBSP);

describe("formatBytesFr", () => {
	it("uses French units, a decimal comma and a narrow no-break space", () => {
		expect(formatBytesFr(24 * MB)).toBe(`24${NNBSP}Mo`);
		expect(formatBytesFr(1.2 * GB)).toBe(u("1,2 Go"));
		expect(formatBytesFr(3.5 * MB)).toBe(u("3,5 Mo"));
		expect(formatBytesFr(11 * GB)).toBe(u("11 Go"));
		expect(formatBytesFr(512)).toBe(u("512 o"));
		expect(formatBytesFr(200 * KB)).toBe(u("200 Ko"));
	});
	it("drops a zero decimal and never prints 1024 of a unit", () => {
		expect(formatBytesFr(2 * GB)).toBe(u("2 Go"));
		expect(formatBytesFr(1024 * MB - 1)).toBe(u("1 Go"));
	});
	it("reads an empty or broken value as 0 Mo", () => {
		for (const v of [0, -5, NaN, undefined, null, Infinity]) expect(formatBytesFr(v as number)).toBe(u("0 Mo"));
	});
	it("never contains a plain space or a dot", () => {
		const s = formatBytesFr(1.25 * GB);
		expect(s).not.toMatch(/[ .]/);
		expect(s).not.toMatch(/MB|GB/);
	});
});

describe("formatMoFr / formatIntFr", () => {
	it("formats whole Mo and fr-FR grouping", () => {
		expect(formatMoFr(500)).toBe(u("500 Mo"));
		expect(formatIntFr(1234).replace(/\s/g, " ")).toBe("1 234");
		expect(formatIntFr(NaN)).toBe("0");
	});
});

describe("formatCountFr", () => {
	it("is singular under 2, plural from 2", () => {
		expect(formatCountFr(0, "titre")).toBe(`0${NBSP}titre`);
		expect(formatCountFr(1, "titre")).toBe(`1${NBSP}titre`);
		expect(formatCountFr(12, "titre")).toBe(`12${NBSP}titres`);
		expect(formatCountFr(2, "morceau", "morceaux")).toBe(`2${NBSP}morceaux`);
	});
	it("groups thousands", () => {
		expect(formatCountFr(1234, "album").replace(/\s/g, " ")).toBe("1 234 albums");
	});
});
