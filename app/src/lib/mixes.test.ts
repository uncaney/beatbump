import { describe, expect, it } from "vitest";
import { albumsLabel, artistCardsFrom, decadeLabel, mixCardUrl, mixCardsFrom, playsLabel, tracksLabel } from "./mixes";

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
				{ name: "Rock", count: 3000, albums: 48 },
				{ name: " ", count: 300 },
				{ name: "Pop", count: 0 },
				{ name: "Hip Hop", count: 250 },
			],
		});
		expect(cards.map((c) => c.key)).toEqual(["decade:2000", "decade:1990", "genre:Rock", "genre:Hip Hop"]);
		expect(cards[0]).toMatchObject({ kind: "decade", title: "Années 2000", subtitle: "40 albums", query: "decade=2000" });
		expect(cards[2].subtitle.replace(/[\u00a0\u202f\u2009]/g, " ")).toBe("3 000 titres · 48 albums");
		expect(cards[3]).toMatchObject({ kind: "genre", title: "Hip Hop", subtitle: "250 titres", query: "genre=Hip%20Hop" });
	});

	it("builds artist cards from the local top artists only (D7)", () => {
		const cards = artistCardsFrom({
			by: "artists",
			days: 365,
			rows: [
				{ key: "Daft Punk", title: "Daft Punk", artistId: "la-1234567890ab", count: 42 },
				{ key: "YouTube Act", title: "YouTube Act", artistId: "UCxyz", count: 30 },
				{ key: "Daft Punk", title: "Daft Punk", artistId: "la-1234567890ab", count: 3 },
				{ key: "", title: " ", artistId: "la-ffffffffffff", count: 9 },
				{ key: "Air", title: "Air", artistId: "la-abcdefabcdef", count: 1 },
				{ key: "No id", title: "No id", count: 50 },
			],
		});
		expect(cards.map((c) => c.key)).toEqual(["artist:la-1234567890ab", "artist:la-abcdefabcdef"]);
		expect(cards[0]).toMatchObject({ kind: "artist", title: "Daft Punk", subtitle: "42 écoutes", query: "seed=artist%3Ala-1234567890ab" });
		expect(cards[1].subtitle).toBe("1 écoute");
		expect(mixCardUrl(cards[0])).toBe("/api/v1/local/related?seed=artist%3Ala-1234567890ab");
		expect(mixCardUrl({ kind: "genre", query: "genre=Rock" })).toBe("/api/v1/local/mix?genre=Rock");
		expect(artistCardsFrom({ rows: Array.from({ length: 12 }, (_, i) => ({ title: `A${i}`, artistId: `la-${i}`, count: 1 })) })).toHaveLength(10);
		expect(playsLabel(0)).toBe("0 écoute");
		expect(artistCardsFrom(null)).toEqual([]);
		expect(artistCardsFrom({ rows: "x" })).toEqual([]);
	});

	it("gives no card for an empty or malformed answer", () => {
		expect(mixCardsFrom(null)).toEqual([]);
		expect(mixCardsFrom({})).toEqual([]);
		expect(mixCardsFrom({ decades: [], genres: [] })).toEqual([]);
		expect(mixCardsFrom("nope")).toEqual([]);
	});
});
