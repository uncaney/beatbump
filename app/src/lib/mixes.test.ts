import { describe, expect, it } from "vitest";
import { albumsLabel, decadeLabel, mixCardsFrom, tracksLabel } from "./mixes";

describe("mixes cards (c29b D1)", () => {
	it("labels", () => {
		expect(decadeLabel(1990)).toBe("Années 1990");
		expect(albumsLabel(1)).toBe("1 album");
		expect(albumsLabel(52)).toBe("52 albums");
		expect(tracksLabel(1)).toBe("1 titre");
		expect(tracksLabel(1234).replace(/ | | /g, " ")).toBe("1 234 titres");
	});

	it("builds decade cards then genre cards, dropping malformed rows", () => {
		const cards = mixCardsFrom({
			decades: [
				{ decade: 2000, albums: 40 },
				{ decade: 1990, albums: 15 },
				{ decade: 1995, albums: 9 },
				{ decade: "x", albums: 3 },
			],
			genres: [
				{ name: "Rock", count: 3000 },
				{ name: " ", count: 300 },
				{ name: "Pop", count: 0 },
				{ name: "Hip Hop", count: 250 },
			],
		});
		expect(cards.map((c) => c.key)).toEqual(["decade:2000", "decade:1990", "genre:Rock", "genre:Hip Hop"]);
		expect(cards[0]).toMatchObject({ kind: "decade", title: "Années 2000", subtitle: "40 albums", query: "decade=2000" });
		expect(cards[3]).toMatchObject({ kind: "genre", title: "Hip Hop", query: "genre=Hip%20Hop" });
	});

	it("gives no card for an empty or malformed answer", () => {
		expect(mixCardsFrom(null)).toEqual([]);
		expect(mixCardsFrom({})).toEqual([]);
		expect(mixCardsFrom({ decades: [], genres: [] })).toEqual([]);
		expect(mixCardsFrom("nope")).toEqual([]);
	});
});
