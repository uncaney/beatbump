import { describe, expect, it } from "vitest";
import { browseHeaderCount, emptyListText, monthFr, reasonFr } from "./browseEmpty";

describe("L14-11 collection header count", () => {
	it("prefers the folded row count of the artists list over the raw credits", () => {
		expect(browseHeaderCount({ total: 1936, shown: 1934, collapsed: true } as any, 60)).toBe(1934);
	});
	it("falls back to total, then to the rows on screen", () => {
		expect(browseHeaderCount({ total: 412 }, 60)).toBe(412);
		expect(browseHeaderCount({ total: "412" } as any, 60)).toBe(60);
		expect(browseHeaderCount({ total: 412, shown: -1 }, 60)).toBe(412);
		expect(browseHeaderCount({}, 7)).toBe(7);
		expect(browseHeaderCount(null, 0)).toBe(0);
	});
});

describe("L13-13 empty collection list", () => {
	it("monthFr names the month in French", () => {
		expect(monthFr("2026-07")).toBe("juillet 2026");
		expect(monthFr("2026-06")).toBe("juin 2026");
		expect(monthFr("garbage")).toBe("garbage");
	});

	it("translates the reasons local_browse.go emits", () => {
		expect(reasonFr("month before 2026-07: dates de migration (...): 2026-06")).toBe(
			"les arrivées ne sont connues qu'à partir de juillet 2026 (dates de migration)",
		);
		expect(reasonFr("month in the future: 2027-01")).toBe("janvier 2027 n'est pas encore arrivé");
		expect(reasonFr("month must be YYYY-MM: 2026-6")).toBe("le mois du lien est invalide");
		expect(reasonFr("unknown filter: foo")).toBe("le filtre du lien est inconnu");
		expect(reasonFr("unknown sort: bar")).toBe("le tri du lien est inconnu");
		expect(reasonFr("offset too large")).toBe("la liste ne va pas aussi loin");
		// Unknown reasons are shown as they are, never swallowed.
		expect(reasonFr("something else")).toBe("something else");
		expect(reasonFr("")).toBe("");
		expect(reasonFr(null)).toBe("");
	});

	it("names the reason of a refused deep link, keeps the usual texts otherwise", () => {
		expect(emptyListText({ filter: "added-month", reason: "month in the future: 2027-01" })).toBe("Aucun résultat : janvier 2027 n'est pas encore arrivé.");
		expect(emptyListText({ q: "zzz" })).toBe("Aucun résultat");
		expect(emptyListText({ filter: "never-played", reason: "" })).toBe("Aucun résultat");
		expect(emptyListText({})).toBe("Rien ici pour l’instant");
		expect(emptyListText({ q: "", filter: "", reason: null })).toBe("Rien ici pour l’instant");
	});
});
