// c29b D1: pure helpers for the "Mixes" page (/library/mixes): the cards the
// backend lists (GET /api/v1/local/mixes) and the labels / query of each.
// No Svelte or store import so the page logic is unit-testable.

export interface MixCard {
	/** "decade:1990" | "genre:Rock" (the data-mix attribute of the card). */
	key: string;
	kind: "decade" | "genre";
	/** "Années 1990" | "Rock" */
	title: string;
	/** "52 albums" | "1 234 titres" */
	subtitle: string;
	/** Query string of GET /api/v1/local/mix (without the "?"). */
	query: string;
}

export function decadeLabel(decade: number): string {
	return `Années ${decade}`;
}

const nf = (n: number): string => {
	try {
		return new Intl.NumberFormat("fr-FR").format(n);
	} catch {
		return String(n);
	}
};

export function albumsLabel(n: number): string {
	return `${nf(n)} album${n > 1 ? "s" : ""}`;
}

export function tracksLabel(n: number): string {
	return `${nf(n)} titre${n > 1 ? "s" : ""}`;
}

/**
 * Cards from the local/mixes answer: decades first (as listed, newest first),
 * then genres. Malformed rows are dropped; unknown shapes give no card.
 */
export function mixCardsFrom(resp: unknown): MixCard[] {
	if (!resp || typeof resp !== "object") return [];
	const r = resp as { decades?: unknown; genres?: unknown };
	const out: MixCard[] = [];
	if (Array.isArray(r.decades)) {
		for (const d of r.decades) {
			const decade = Number((d as { decade?: unknown })?.decade);
			const albums = Number((d as { albums?: unknown })?.albums);
			if (!Number.isInteger(decade) || decade % 10 !== 0 || !(albums > 0)) continue;
			out.push({
				key: `decade:${decade}`,
				kind: "decade",
				title: decadeLabel(decade),
				subtitle: albumsLabel(albums),
				query: `decade=${decade}`,
			});
		}
	}
	if (Array.isArray(r.genres)) {
		for (const g of r.genres) {
			const name = (g as { name?: unknown })?.name;
			const count = Number((g as { count?: unknown })?.count);
			if (typeof name !== "string" || name.trim() === "" || !(count > 0)) continue;
			out.push({
				key: `genre:${name}`,
				kind: "genre",
				title: name,
				subtitle: tracksLabel(count),
				query: `genre=${encodeURIComponent(name)}`,
			});
		}
	}
	return out;
}
