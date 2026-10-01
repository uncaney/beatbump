import { describe, expect, it } from "vitest";
import { EXPLORE_GENRES_MAX, genreHref, localGenreLinks } from "./localGenres";

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
