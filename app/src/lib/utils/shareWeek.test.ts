import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/utils", () => ({ notify: vi.fn() }));

import { shareLink } from "./shareLink";
import { shareableMinutes, weekShareCopy, weekShareData, weekShareText, yearShareData, yearShareFrom, yearShareText } from "./shareWeek";

const NNBSP = " ";
const NBSP = " ";

describe("weekShareText", () => {
	it("says minutes, titles and the top artist", () => {
		expect(weekShareText({ minutes: 212.4, tracks: 34, topArtist: "Daft Punk" })).toBe(
			`Cette semaine : 212${NNBSP}min, 34${NBSP}titres, artiste n°1 Daft Punk`,
		);
	});
	it("drops a missing artist and keeps the singular", () => {
		expect(weekShareText({ minutes: 4, tracks: 1, topArtist: " " })).toBe(`Cette semaine : 4${NNBSP}min, 1${NBSP}titre`);
		expect(weekShareText({ minutes: 1500, tracks: 0, topArtist: "" })).toContain(`1${NNBSP}500${NNBSP}min`);
	});
	it("links the top album when it has an id, else the site", () => {
		const d = weekShareData({ minutes: 212, tracks: 34, topArtist: "Daft Punk", topAlbumId: "lb-0123456789ab" }, "https://music.ekaii.fr");
		expect(d.url).toBe("https://music.ekaii.fr/release?id=lb-0123456789ab");
		expect(d.text).toContain("min");
		expect(weekShareData({ minutes: 1, tracks: 1, topArtist: "" }, "https://music.ekaii.fr/").url).toBe("https://music.ekaii.fr/");
		expect(weekShareCopy(d)).toBe(`${d.text}\nhttps://music.ekaii.fr/release?id=lb-0123456789ab`);
	});
	it("copies text + link with a 'Copié' toast without Web Share", async () => {
		const toast = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		const d = weekShareData({ minutes: 212, tracks: 34, topArtist: "Daft Punk" }, "https://x");
		const out = await shareLink(d, { clipboard: { writeText } } as any, toast, { copyText: weekShareCopy(d), copiedToast: "Copié" });
		expect(out).toBe("copied");
		expect(writeText).toHaveBeenCalledWith(weekShareCopy(d));
		expect(toast).toHaveBeenCalledWith("Copié", "success");
	});
	it("hands text and url to the native sheet", async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		const d = weekShareData({ minutes: 212, tracks: 34, topArtist: "Daft Punk", topAlbumId: "lb-x" }, "https://x");
		expect(await shareLink(d, { share } as any, vi.fn())).toBe("shared");
		expect(share).toHaveBeenCalledWith(d);
	});
});

// c45b (B7-11) "Partager mon année"
describe("yearShareText", () => {
	const full = { year: 2026, minutes: 1234.4, topArtists: ["Daft Punk", "Air", "Justice"], topAlbum: "Discovery", topAlbumId: "lb-disc", albums: 12, newArtists: 5 };
	it("says minutes, the top 3 artists, the album n°1, distinct albums and discoveries", () => {
		expect(yearShareText(full)).toBe(
			`Mon année 2026 : 1${NNBSP}234${NNBSP}min, artistes n°1 Daft Punk, Air et Justice, album n°1 Discovery, 12${NBSP}albums différents, 5${NBSP}nouveaux artistes`,
		);
	});
	it("uses the singular for one artist / album / discovery and drops what is missing", () => {
		expect(yearShareText({ year: 2025, minutes: 4, topArtists: ["Air"], albums: 1, newArtists: 1 })).toBe(
			`Mon année 2025 : 4${NNBSP}min, artiste n°1 Air, 1${NBSP}album différent, 1${NBSP}nouvel artiste`,
		);
		expect(yearShareText({ year: 2025, minutes: 90, topArtists: ["Air", " "], albums: 0, newArtists: 0 })).toBe(`Mon année 2025 : 90${NNBSP}min, artiste n°1 Air`);
		expect(yearShareText({ year: 2025, minutes: 10, topArtists: ["A", "B"], albums: 0, newArtists: 0 })).toContain("artistes n°1 A et B");
		expect(yearShareText({ year: 2025, minutes: 10, topArtists: ["A", "B", "C", "D"], albums: 0, newArtists: 0 })).toMatch(/artistes n°1 A, B et C$/);
	});
	it("links the album n°1 (lb-) when it has an id, else the site", () => {
		const d = yearShareData(full, "https://music.ekaii.fr");
		expect(d.url).toBe("https://music.ekaii.fr/release?id=lb-disc");
		expect(d.title).toBe("Mon année 2026 en musique");
		expect(d.text).toContain("min");
		expect(yearShareData({ ...full, topAlbumId: undefined }, "https://music.ekaii.fr/").url).toBe("https://music.ekaii.fr/");
		expect(weekShareCopy(d)).toBe(`${d.text}\nhttps://music.ekaii.fr/release?id=lb-disc`);
	});
});

describe("B8-5 shareableMinutes: no Partager at zero", () => {
	it("needs at least one rounded minute", () => {
		expect(shareableMinutes(null)).toBe(false);
		expect(shareableMinutes(undefined)).toBe(false);
		expect(shareableMinutes({})).toBe(false);
		expect(shareableMinutes({ minutes: 0 })).toBe(false);
		expect(shareableMinutes({ minutes: 0.4 })).toBe(false);
		expect(shareableMinutes({ minutes: NaN })).toBe(false);
		expect(shareableMinutes({ minutes: 0.5 })).toBe(true);
		expect(shareableMinutes({ minutes: 212.4 })).toBe(true);
	});
});

describe("yearShareFrom", () => {
	const view = {
		year: 2026, plays: 40, minutes: 150.2, distinctAlbums: 7, newArtists: 2,
		topArtist: { title: "Daft Punk" }, topArtists: [{ title: "Daft Punk" }, { title: "Air" }, { title: "Justice" }],
		topAlbum: { title: "Discovery", albumId: "lb-disc" },
	};
	it("reads the year answer (own numbers only)", () => {
		expect(yearShareFrom(view)).toEqual({ year: 2026, minutes: 150.2, topArtists: ["Daft Punk", "Air", "Justice"], topAlbum: "Discovery", topAlbumId: "lb-disc", albums: 7, newArtists: 2 });
	});
	it("is null without a play that year", () => {
		expect(yearShareFrom({ ...view, plays: 0 })).toBeNull();
		expect(yearShareFrom(null)).toBeNull();
	});
	it("falls back on the single topArtist of an older server and tolerates a YouTube album without id", () => {
		const y = yearShareFrom({ ...view, topArtists: undefined, topAlbum: { title: "Moon Safari" } });
		expect(y?.topArtists).toEqual(["Daft Punk"]);
		expect(y?.topAlbum).toBe("Moon Safari");
		expect(y?.topAlbumId).toBeUndefined();
		expect(yearShareFrom({ ...view, topArtist: null, topArtists: [] })?.topArtists).toEqual([]);
	});
});
