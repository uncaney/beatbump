import { describe, expect, it } from "vitest";
import { ALIAS_CHIPS_SHOWN, aliasChipLabel, foldAliases } from "./artistAliases";

const chip = (n: number) => ({ id: `la-${n}`, name: `The Chainsmokers ft. Guest ${n}`, href: `/artist/la-${n}` });
const chips = (n: number) => Array.from({ length: n }, (_, i) => chip(i + 1));

describe("foldAliases (U13-3)", () => {
	it("shows 3 chips and a '+N autres' toggle while folded", () => {
		const f = foldAliases(chips(16), false);
		expect(ALIAS_CHIPS_SHOWN).toBe(3);
		expect(f.shown.map((c) => c.id)).toEqual(["la-1", "la-2", "la-3"]);
		expect(f.hidden).toBe(13);
		expect(f.toggle).toBe("+13 autres");
		expect(foldAliases(chips(4), false).toggle).toBe("+1 autre");
	});

	it("shows every chip once open, with a 'Replier' toggle", () => {
		const f = foldAliases(chips(16), true);
		expect(f.shown).toHaveLength(16);
		expect(f.hidden).toBe(13);
		expect(f.toggle).toBe("Replier");
	});

	it("never shows a toggle for 3 chips or fewer, whatever the state", () => {
		for (const open of [false, true]) {
			const f = foldAliases(chips(3), open);
			expect(f.shown).toHaveLength(3);
			expect(f.hidden).toBe(0);
			expect(f.toggle).toBe("");
		}
		expect(foldAliases([], false)).toEqual({ shown: [], hidden: 0, toggle: "" });
		expect(foldAliases(null, false)).toEqual({ shown: [], hidden: 0, toggle: "" });
	});

	it("drops duplicated ids and nameless entries", () => {
		const f = foldAliases([chip(1), chip(1), { id: "la-9", name: " " } as any, chip(2)], false);
		expect(f.shown.map((c) => c.id)).toEqual(["la-1", "la-2"]);
	});
});

describe("aliasChipLabel (U13-3)", () => {
	it("drops the page's own name before a feat. tail", () => {
		expect(aliasChipLabel("The Chainsmokers ft. Daya", "The Chainsmokers")).toBe("ft. Daya");
		expect(aliasChipLabel("The Chainsmokers feat. Halsey", "the chainsmokers")).toBe("ft. Halsey");
		expect(aliasChipLabel("The Chainsmokers (featuring Halsey)", "The Chainsmokers")).toBe("ft. Halsey");
		expect(aliasChipLabel("The Chainsmokers Featuring ROZES", "The Chainsmokers")).toBe("ft. ROZES");
	});

	it("keeps a collaboration, a spelling variant and a non-prefix name whole", () => {
		expect(aliasChipLabel("Simon & Garfunkel", "Simon")).toBe("Simon & Garfunkel");
		expect(aliasChipLabel("Ed Shéeran", "Ed Sheeran")).toBe("Ed Shéeran");
		expect(aliasChipLabel("Khalid feat. Ed Sheeran", "Ed Sheeran")).toBe("Khalid feat. Ed Sheeran");
		expect(aliasChipLabel("The Chainsmokers", "The Chainsmokers")).toBe("The Chainsmokers");
		expect(aliasChipLabel("The Chainsmokers ft.", "The Chainsmokers")).toBe("The Chainsmokers ft.");
		expect(aliasChipLabel("", "x")).toBe("");
	});
});
