import { describe, expect, it } from "vitest";
import {
	AZ_LETTERS,
	SEEK_MAX_PAGES,
	findLetterIndex,
	initialOf,
	isTitleSort,
	letterRank,
	loadSortPrefs,
	saveSortPrefs,
	seekShouldContinue,
	seekStep,
	sortKey,
	type PrefStorage,
} from "./sortMemory";

/** `n` rows whose titles start with `letter` (A-sorted fixture helper). */
const rowsOf = (letter: string, n: number) => Array.from({ length: n }, (_, i) => ({ title: `${letter}${i}` }));

describe("L8-8 bounded A-Z seek: seekStep", () => {
	it("found as soon as a row of the letter is loaded", () => {
		expect(seekStep([...rowsOf("A", 3), ...rowsOf("M", 1)], "M", false, 0, false)).toBe("found");
		expect(seekStep(rowsOf("M", 1), "M", true, SEEK_MAX_PAGES + 3, true)).toBe("found");
	});
	it("loads while the list has not reached the letter and the budget is not spent", () => {
		expect(seekStep([], "M", false, 0, false)).toBe("load");
		expect(seekStep(rowsOf("A", 200), "M", false, 0, false)).toBe("load");
		expect(seekStep(rowsOf("A", 200), "M", false, SEEK_MAX_PAGES - 1, false)).toBe("load");
		// descending: the list runs Z..A, "M" is still ahead while the last row is later
		expect(seekStep(rowsOf("Z", 200), "M", true, 2, false)).toBe("load");
	});
	it("too_far once SEEK_MAX_PAGES pages were loaded without reaching the letter", () => {
		expect(SEEK_MAX_PAGES).toBe(5);
		expect(seekStep(rowsOf("A", 1000), "Z", false, SEEK_MAX_PAGES, false)).toBe("too_far");
		expect(seekStep(rowsOf("A", 1000), "Z", false, SEEK_MAX_PAGES + 1, false)).toBe("too_far");
		expect(seekStep(rowsOf("Z", 1000), "#", true, SEEK_MAX_PAGES, false)).toBe("too_far");
		// a custom budget
		expect(seekStep(rowsOf("A", 10), "Z", false, 2, false, 2)).toBe("too_far");
	});
	it("absent when the list is exhausted or already went past the letter (no page, no message)", () => {
		expect(seekStep(rowsOf("A", 10), "Z", false, 0, true)).toBe("absent");
		expect(seekStep([...rowsOf("A", 2), ...rowsOf("N", 2)], "M", false, 0, false)).toBe("absent");
		expect(seekStep(rowsOf("L", 2), "M", true, 0, false)).toBe("absent");
		// the budget is spent AND the list is exhausted: exhausted wins (nothing more to load)
		expect(seekStep(rowsOf("A", 10), "Z", false, SEEK_MAX_PAGES, true)).toBe("absent");
	});
	it("a seek loop stops after exactly SEEK_MAX_PAGES loads (simulated 6 831-album index, tap Z)", () => {
		let rows: { title: string }[] = rowsOf("A", 60); // first page of 60
		let loads = 0;
		let step = seekStep(rows, "Z", false, 0, false);
		let pages = 0;
		while (step === "load") {
			rows = [...rows, ...rowsOf(String.fromCharCode(66 + loads), 200)]; // B.., C.. never Z
			loads++;
			pages++;
			step = seekStep(rows, "Z", false, pages, false);
		}
		expect(step).toBe("too_far");
		expect(loads).toBe(SEEK_MAX_PAGES);
		expect(rows.length).toBe(60 + SEEK_MAX_PAGES * 200);
	});
});

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
