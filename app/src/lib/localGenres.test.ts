import { describe, expect, it } from "vitest";
import { EXPLORE_GENRES_MAX, genreHref, isJunkGenre, isSoundtrackGenre, localGenreLinks, normalizeGenreList, splitGenreValue } from "./localGenres";

describe("Explore local genres (c29b EQ2)", () => {
	it("links to the all-songs genre view", () => {
		expect(genreHref("Hip Hop")).toBe("/library/all-songs?genre=Hip%20Hop");
	});

	it("keeps backend order, drops blanks and duplicates, caps to max", () => {
		const genres = [
			{ name: "Rock", count: 3000 },
			{ name: " ", count: 10 },
			{ name: "rock", count: 5 },
			{ name: "Pop", count: "12" },
			{ name: "Jazz" },
			null,
			{ count: 3 },
		];
		const links = localGenreLinks({ genres });
		expect(links.map((l) => l.name)).toEqual(["Rock", "Pop", "Jazz"]);
		expect(links[0]).toEqual({ name: "Rock", count: 3000, href: "/library/all-songs?genre=Rock" });
		expect(links[1].count).toBe(12);
		expect(links[2].count).toBe(0);
		const many = Array.from({ length: 30 }, (_, i) => ({ name: `G${i}`, count: 30 - i }));
		expect(localGenreLinks({ genres: many }).length).toBe(EXPLORE_GENRES_MAX);
		expect(localGenreLinks({ genres: many }, 3).map((l) => l.name)).toEqual(["G0", "G1", "G2"]);
	});

	it("gives nothing for an empty or malformed answer", () => {
		expect(localGenreLinks({ genres: [] })).toEqual([]);
		expect(localGenreLinks({})).toEqual([]);
		expect(localGenreLinks(null)).toEqual([]);
		expect(localGenreLinks("x")).toEqual([]);
	});
});

describe("Genres page list (U12-5)", () => {
	it("flags junk tag values", () => {
		for (const j of ["", " ", "x", "_Soundtrack", "B.O.", "O.S.T", "b.o."]) expect(isJunkGenre(j)).toBe(true);
		for (const ok of ["Rock", "R&B", "Hip Hop", "Électro"]) expect(isJunkGenre(ok)).toBe(false);
	});

	it("splits raw values, drops junk, merges case variants, sorts by count", () => {
		const genres = [
			{ name: "Acoustic Rock;Blues Rock;Rock", count: 3 },
			{ name: "Rock", count: 10 },
			{ name: "rock", count: 2 },
			{ name: "_Soundtrack", count: 8 },
			{ name: "B.O.", count: 6 },
			{ name: "bossa nova/samba", count: 4 },
			{ name: "", count: 1 },
			null,
		];
		expect(normalizeGenreList({ genres })).toEqual([
			{ name: "Rock", count: 15 },
			{ name: "Bande originale", count: 14 },
			{ name: "bossa nova", count: 4 },
			{ name: "samba", count: 4 },
			{ name: "Acoustic Rock", count: 3 },
			{ name: "Blues Rock", count: 3 },
		]);
		expect(normalizeGenreList(null)).toEqual([]);
		expect(normalizeGenreList({ genres: "x" })).toEqual([]);
	});

	it("L11-6: slash names stay whole, commas split, soundtracks grouped", () => {
		expect(splitGenreValue("Singer/Songwriter")).toEqual(["Singer/Songwriter"]);
		expect(splitGenreValue("AC/DC")).toEqual(["AC/DC"]);
		expect(splitGenreValue("Rock/Pop")).toEqual(["Rock/Pop"]);
		expect(splitGenreValue("Electronic/House")).toEqual(["Electronic", "House"]);
		expect(splitGenreValue("Rock, Britpop")).toEqual(["Rock", "Britpop"]);
		expect(splitGenreValue("Soundtrack, Classical")).toEqual(["Bande originale", "Classical"]);
		for (const v of ["B.O.", "BSO", "OST", "O.S.T", "score", "Soundtrack", "_Soundtrack", "Bande originale", "Original Score"]) {
			expect(isSoundtrackGenre(v)).toBe(true);
		}
		for (const v of ["CORE", "Rock", "Hardcore"]) expect(isSoundtrackGenre(v)).toBe(false);
		expect(normalizeGenreList({ genres: [{ name: "Bande originale", count: 5 }, { name: "Singer/Songwriter", count: 3 }] })).toEqual([
			{ name: "Bande originale", count: 5 },
			{ name: "Singer/Songwriter", count: 3 },
		]);
	});

	it("keeps junk out of the Explore chips", () => {
		const links = localGenreLinks({ genres: [{ name: "_Soundtrack", count: 9 }, { name: "B.O.", count: 8 }, { name: "Jazz", count: 1 }] });
		expect(links.map((l) => l.name)).toEqual(["Jazz"]);
	});
});
