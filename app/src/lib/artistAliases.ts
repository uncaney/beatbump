// U13-3: the "Aussi sous" chips of a local artist page. Sixteen 44px chips
// (one per line on a phone) used to stand between the header and the titles.
// Pure helpers, unit-tested; the page (routes/(app)/[artistOrChannel=channel]/
// [slug]/+page.svelte) only renders what they give back.

/** Chips shown before the "+N autres" toggle is opened. */
export const ALIAS_CHIPS_SHOWN = 3;

export interface AliasChip {
	id: string;
	name: string;
	href?: string;
}

export interface FoldedAliases<T extends AliasChip> {
	/** The chips to render now. */
	shown: T[];
	/** How many chips the toggle still hides (0 = no toggle). */
	hidden: number;
	/** The toggle's label ("+13 autres", "+1 autre", "Replier" once open). */
	toggle: string;
}

/**
 * The chips to paint: the first `max` while folded, every one once open.
 * A list of `max` or fewer never shows a toggle (hidden 0). Duplicated ids
 * are dropped (the API dedupes spellings server side; this keeps the row
 * sane whatever it answers).
 */
export function foldAliases<T extends AliasChip>(all: T[] | null | undefined, open: boolean, max = ALIAS_CHIPS_SHOWN): FoldedAliases<T> {
	const list: T[] = [];
	const seen = new Set<string>();
	for (const a of Array.isArray(all) ? all : []) {
		if (!a || typeof a !== "object" || typeof a.name !== "string" || !a.name.trim()) continue;
		const key = String(a.id || a.name);
		if (seen.has(key)) continue;
		seen.add(key);
		list.push(a);
	}
	const cap = Math.max(0, max);
	if (list.length <= cap) return { shown: list, hidden: 0, toggle: "" };
	const hidden = list.length - cap;
	if (open) return { shown: list, hidden, toggle: "Replier" };
	return { shown: list.slice(0, cap), hidden, toggle: `+${hidden} ${hidden > 1 ? "autres" : "autre"}` };
}

const FEAT_TAIL = /^(?:\(|\[)?\s*(?:feat|ft|featuring)\b\.?\s*/i;

/**
 * The chip's label: the credit without the page's own name ("The
 * Chainsmokers ft. Daya" on The Chainsmokers' page reads "ft. Daya"). Only a
 * "feat." tail is shortened: "Simon & Garfunkel" on Simon's page would lose
 * its meaning, it stays whole; so does a name that is not a prefix match.
 */
export function aliasChipLabel(name: string, primary: string): string {
	const n = (name || "").trim();
	const p = (primary || "").trim();
	if (!n || !p || n.toLowerCase() === p.toLowerCase()) return n;
	if (!n.toLowerCase().startsWith(p.toLowerCase())) return n;
	const rest = n.slice(p.length).trim();
	if (!FEAT_TAIL.test(rest)) return n;
	const guest = rest.replace(FEAT_TAIL, "").replace(/[\)\]]\s*$/, "").trim();
	return guest ? `ft. ${guest}` : n;
}
