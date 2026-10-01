import { describe, expect, it } from "vitest";
import {
	AZ_LETTERS,
	findLetterIndex,
	initialOf,
	isTitleSort,
	letterRank,
	loadSortPrefs,
	saveSortPrefs,
	seekShouldContinue,
	sortKey,
	type PrefStorage,
} from "./sortMemory";

const mem = (): PrefStorage & { map: Map<string, string> } => {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
	};
};
const albumSorts = ["dateAdded:desc", "album:asc", "albumArtist:asc", "year:desc"];

describe("BI2 remembered sort: key + round trip", () => {
	it("keys per route pathname, without query or hash", () => {
		expect(sortKey("/library/albums")).toBe("ytm-sort:/library/albums");
		expect(sortKey("/library/artists?x=1#y")).toBe("ytm-sort:/library/artists");
		expect(sortKey("")).toBe("ytm-sort:/");
	});
	it("round-trips sort and filter per route", () => {
		const s = mem();
		saveSortPrefs("/library/albums", { sort: "album:asc", q: "daft" }, s);
		saveSortPrefs("/library/artists", { sort: "name:desc", q: "" }, s);
		expect(loadSortPrefs("/library/albums", albumSorts, "dateAdded:desc", s)).toEqual({ sort: "album:asc", q: "daft" });
		expect(loadSortPrefs("/library/artists", ["name:asc", "name:desc"], "name:asc", s)).toEqual({ sort: "name:desc", q: "" });
		expect(s.map.get("ytm-sort:/library/albums")).toBe(JSON.stringify({ sort: "album:asc", q: "daft" }));
	});
	it("falls back to the default when nothing / garbage / an unknown sort is stored", () => {
		const s = mem();
		expect(loadSortPrefs("/library/albums", albumSorts, "dateAdded:desc", s)).toEqual({ sort: "dateAdded:desc", q: "" });
		s.setItem("ytm-sort:/library/albums", "{not json");
		expect(loadSortPrefs("/library/albums", albumSorts, "dateAdded:desc", s).sort).toBe("dateAdded:desc");
		s.setItem("ytm-sort:/library/albums", JSON.stringify({ sort: "zz:desc", q: "ok" }));
		expect(loadSortPrefs("/library/albums", albumSorts, "dateAdded:desc", s)).toEqual({ sort: "dateAdded:desc", q: "ok" });
		s.setItem("ytm-sort:/library/albums", JSON.stringify({ sort: 3, q: 4 }));
		expect(loadSortPrefs("/library/albums", albumSorts, "dateAdded:desc", s)).toEqual({ sort: "dateAdded:desc", q: "" });
	});
	it("never throws on a broken or missing storage", () => {
		const broken: PrefStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(() => saveSortPrefs("/x", { sort: "a", q: "" }, broken)).not.toThrow();
		expect(loadSortPrefs("/x", ["a"], "a", broken)).toEqual({ sort: "a", q: "" });
		expect(loadSortPrefs("/x", ["a"], "a", null)).toEqual({ sort: "a", q: "" });
	});
});

describe("BI2 A-Z index helpers", () => {
	it("maps a title to its index letter", () => {
		expect(initialOf("Discovery")).toBe("D");
		expect(initialOf("édith Piaf")).toBe("E");
		expect(initialOf("Ólafur Arnalds")).toBe("O");
		expect(initialOf("  the Strokes")).toBe("T");
		expect(initialOf("1999")).toBe("#");
		expect(initialOf("...And Justice")).toBe("#");
		expect(initialOf("宇多田ヒカル")).toBe("#");
		expect(initialOf("")).toBe("#");
		expect(initialOf(undefined)).toBe("#");
	});
	it("ranks # before A and lists 27 letters", () => {
		expect(AZ_LETTERS.length).toBe(27);
		expect(letterRank("#")).toBe(-1);
		expect(letterRank("A")).toBe(0);
		expect(letterRank("Z")).toBe(25);
	});
	it("applies only to the title sorts of albums / artists", () => {
		expect(isTitleSort("albums", "album:asc")).toBe(true);
		expect(isTitleSort("albums", "album:desc")).toBe(true);
		expect(isTitleSort("albums", "albumArtist:asc")).toBe(false);
		expect(isTitleSort("albums", "dateAdded:desc")).toBe(false);
		expect(isTitleSort("artists", "name:asc")).toBe(true);
		expect(isTitleSort("artists", "trackCount:desc")).toBe(false);
		expect(isTitleSort("songs", "title:asc")).toBe(false);
	});
	it("finds the first row of a letter and knows when to stop seeking", () => {
		const rows = [{ title: "1999" }, { title: "Abbey Road" }, { title: "Aja" }, { title: "Blue" }];
		expect(findLetterIndex(rows, "A")).toBe(1);
		expect(findLetterIndex(rows, "#")).toBe(0);
		expect(findLetterIndex(rows, "C")).toBe(-1);
		// ascending: the list ends at B, so C may still come, A cannot
		expect(seekShouldContinue(rows, "C", false)).toBe(true);
		expect(seekShouldContinue(rows, "A", false)).toBe(false);
		expect(seekShouldContinue(rows, "#", false)).toBe(false);
		// descending (Z..A): the list ends at B, so A may still come, C cannot
		const desc = rows.slice().reverse();
		expect(seekShouldContinue(desc, "A", true)).toBe(false); // ends at 1999 (#): past A
		expect(seekShouldContinue([{ title: "Zoo" }, { title: "Blue" }], "A", true)).toBe(true);
		expect(seekShouldContinue([{ title: "Zoo" }, { title: "Blue" }], "C", true)).toBe(false);
		expect(seekShouldContinue([], "Q", false)).toBe(true);
	});
});
