import { describe, expect, it } from "vitest";
import { fmtBytesFr, fmtQuotaFr, spaceButtonLabels, spaceStatusLine } from "./offlineSpace";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("offline space card (F7 + F15)", () => {
	it("formats bytes in French units", () => {
		expect(fmtBytesFr(0)).toBe("0\u202fMo");
		expect(fmtBytesFr(-5)).toBe("0\u202fMo");
		expect(fmtBytesFr(100)).toBe("100\u202fo");
		expect(fmtBytesFr(56 * MB)).toBe("56\u202fMo");
		expect(fmtBytesFr(1.5 * GB)).toBe("1,5\u202fGo");
		expect(fmtBytesFr(11 * GB)).toBe("11\u202fGo");
		expect(fmtQuotaFr(0)).toBe("illimité");
		expect(fmtQuotaFr(2 * GB)).toBe("2\u202fGo");
	});

	it("labels both actions with the one selected size", () => {
		expect(spaceButtonLabels(100)).toEqual({ freeUp: "Libérer 100\u202fMo", pack: "Préparer un pack de 100\u202fMo" });
		expect(spaceButtonLabels(500).freeUp).toBe("Libérer 500\u202fMo");
	});

	it("builds the status line from what is known", () => {
		expect(spaceStatusLine({ total: 56 * MB, quota: 0, pinnedBytes: 0 }).text).toBe("56\u202fMo en cache");
		expect(spaceStatusLine({ total: 56 * MB, quota: 2 * GB, pinnedBytes: 12 * MB }).text).toBe(
			"56\u202fMo en cache sur 2\u202fGo, dont 12\u202fMo épinglés",
		);
		expect(spaceStatusLine({ total: 0, quota: 0, pinnedBytes: 0, loading: true }).text).toBe("Lecture du cache…");
		expect(spaceStatusLine({ total: 0, quota: 0, pinnedBytes: 0, unknown: true }).text).toBe("Taille du cache inconnue");
		expect(spaceStatusLine({ total: 44 * MB, quota: 0, pinnedBytes: 0 }).totalText).toBe("44\u202fMo");
	});
});
