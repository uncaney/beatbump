import { describe, expect, it } from "vitest";
import { clockSummary, localDateKey, streakLabel, streakNeedsToday } from "./meStats";

describe("streakLabel", () => {
	it("says the run and the record", () => {
		expect(streakLabel({ current: 12, longest: 31 })).toBe("12 jours d'affilée · record 31");
		expect(streakLabel({ current: 1, longest: 4 })).toBe("1 jour · record 4");
		expect(streakLabel({ current: 0, longest: 3 })).toBe("Aucune série en cours · record 3");
		expect(streakLabel({ current: 0, longest: 0 })).toBe("Aucune série en cours");
	});
	it("nudges only when the streak is alive and today is not played yet", () => {
		expect(streakNeedsToday({ current: 3, lastDay: "2026-10-01" }, "2026-10-02")).toBe(true);
		expect(streakNeedsToday({ current: 3, lastDay: "2026-10-02" }, "2026-10-02")).toBe(false);
		expect(streakNeedsToday({ current: 0, lastDay: "2026-09-20" }, "2026-10-02")).toBe(false);
	});
	it("formats the local date key", () => {
		expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
	});
});

describe("clockSummary", () => {
	const empty = () => Array.from({ length: 7 }, () => Array(24).fill(0));
	it("names the part of the day and the weekday with the most minutes", () => {
		const m = empty();
		m[5][20] = 30; // samedi soir
		m[5][21] = 10;
		m[0][8] = 25; // lundi matin
		expect(clockSummary(m)).toBe("Tu écoutes surtout le soir, le samedi.");
		m[2][7] = 60;
		expect(clockSummary(m)).toBe("Tu écoutes surtout le matin, le mercredi.");
	});
	it("handles the night and the afternoon", () => {
		const m = empty();
		m[6][2] = 5;
		expect(clockSummary(m)).toBe("Tu écoutes surtout la nuit, le dimanche.");
		m[3][14] = 9;
		expect(clockSummary(m)).toBe("Tu écoutes surtout l'après-midi, le jeudi.");
	});
	it("is empty without plays or with a bad shape", () => {
		expect(clockSummary(empty())).toBe("");
		expect(clockSummary(null)).toBe("");
		expect(clockSummary([[1]])).toBe("");
	});
});
