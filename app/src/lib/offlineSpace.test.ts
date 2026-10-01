import { describe, expect, it } from "vitest";
import { fmtBytesFr, fmtQuotaFr, spaceButtonLabels, spaceStatusLine } from "./offlineSpace";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("offline space card (F7 + F15)", () => {
	it("formats bytes in French units", () => {
		expect(fmtBytesFr(0)).toBe("0 Mo");
		expect(fmtBytesFr(-5)).toBe("0 Mo");
		expect(fmtBytesFr(100)).toBe("1 Mo");
		expect(fmtBytesFr(56 * MB)).toBe("56 Mo");
		expect(fmtBytesFr(1.5 * GB)).toBe("1,5 Go");
		expect(fmtBytesFr(11 * GB)).toBe("11 Go");
		expect(fmtQuotaFr(0)).toBe("illimité");
		expect(fmtQuotaFr(2 * GB)).toBe("2,0 Go");
	});

	it("labels both actions with the one selected size", () => {
		expect(spaceButtonLabels(100)).toEqual({ freeUp: "Libérer 100 Mo", pack: "Préparer un pack de 100 Mo" });
		expect(spaceButtonLabels(500).freeUp).toBe("Libérer 500 Mo");
	});

	it("builds the status line from what is known", () => {
		expect(spaceStatusLine({ total: 56 * MB, quota: 0, pinnedBytes: 0 }).text).toBe("56 Mo en cache");
		expect(spaceStatusLine({ total: 56 * MB, quota: 2 * GB, pinnedBytes: 12 * MB }).text).toBe(
			"56 Mo en cache sur 2,0 Go, dont 12 Mo épinglés",
		);
		expect(spaceStatusLine({ total: 0, quota: 0, pinnedBytes: 0, loading: true }).text).toBe("Lecture du cache…");
		expect(spaceStatusLine({ total: 0, quota: 0, pinnedBytes: 0, unknown: true }).text).toBe("Taille du cache inconnue");
		expect(spaceStatusLine({ total: 44 * MB, quota: 0, pinnedBytes: 0 }).totalText).toBe("44 Mo");
	});
});
