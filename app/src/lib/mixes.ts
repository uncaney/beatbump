// c29b D1: pure helpers for the "Mixes" page (/library/mixes): the cards the
// backend lists (GET /api/v1/local/mixes) and the labels / query of each.
// No Svelte or store import so the page logic is unit-testable.

export interface MixCard {
	/** "decade:1990" | "genre:Rock" | "artist:la-…" (the data-mix attribute of the card). */
	key: string;
	kind: "decade" | "genre" | "artist";
	/** "Années 1990" | "Rock" | "Daft Punk" */
	title: string;
	/** "52 albums" | "1 234 titres · 20 albums" (genre albums since L8-6) | "12 écoutes" */
	subtitle: string;
	/** Query string of GET /api/v1/local/mix (without the "?"); for an artist card, of GET /api/v1/local/related. */
	query: string;
}

/** The API path a card's tracks come from (D7: artist cards play the EQ1 seeded radio). */
export function mixCardUrl(card: Pick<MixCard, "kind" | "query">): string {
	return card.kind === "artist" ? `/api/v1/local/related?${card.query}` : `/api/v1/local/mix?${card.query}`;
}

export function playsLabel(n: number): string {
	return `${nf(n)} écoute${n > 1 ? "s" : ""}`;
}

/**
 * D7 "Tes artistes": one card per top artist of the profile
 * (GET me/stats/top?by=artists rows) that is a LOCAL artist (artistId
 * "la-…": the seed local/related?seed=artist:<id> resolves). Rows without
 * a local id, blank names and duplicate ids are dropped; at most `max`.
 */
export function artistCardsFrom(resp: unknown, max = 10): MixCard[] {
	if (!resp || typeof resp !== "object") return [];
	const rows = (resp as { rows?: unknown }).rows;
	if (!Array.isArray(rows)) return [];
	const seen = new Set<string>();
	const out: MixCard[] = [];
	for (const r of rows) {
		const id = (r as { artistId?: unknown })?.artistId;
		const name = (r as { title?: unknown })?.title;
		if (typeof id !== "string" || !id.startsWith("la-") || seen.has(id)) continue;
		if (typeof name !== "string" || name.trim() === "") continue;
		seen.add(id);
		const count = Number((r as { count?: unknown })?.count);
		out.push({
			key: `artist:${id}`,
			kind: "artist",
			title: name.trim(),
			subtitle: count > 0 ? playsLabel(count) : "Radio depuis tes écoutes",
			query: `seed=${encodeURIComponent(`artist:${id}`)}`,
		});
		if (out.length >= max) break;
	}
	return out;
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
			const albums = Number((g as { albums?: unknown })?.albums);
			if (typeof name !== "string" || name.trim() === "" || !(count > 0)) continue;
			out.push({
				key: `genre:${name}`,
				kind: "genre",
				title: name,
				// L8-6: the backend only lists genres whose mix can play and says
				// over how many albums; older answers (no `albums`) keep the count.
				subtitle: albums > 0 ? `${tracksLabel(count)} · ${albumsLabel(albums)}` : tracksLabel(count),
				query: `genre=${encodeURIComponent(name)}`,
			});
		}
	}
	return out;
}

/** L10-14: how long an artist card stays marked "Radio indisponible" (still tappable: a tap retries). */
export const MIX_UNAVAILABLE_TTL_MS = 10 * 60 * 1000;

/** The keys of `marks` (key -> time marked) still within `ttlMs` at `now`. */
export function activeUnavailable(marks: ReadonlyMap<string, number>, now: number, ttlMs = MIX_UNAVAILABLE_TTL_MS): Set<string> {
	const out = new Set<string>();
	for (const [k, at] of marks) if (now - at < ttlMs) out.add(k);
	return out;
}

/** L10-13: accessible name of a mix card, its state included (the subtitle alone was hidden by aria-label). */
export function mixCardAriaLabel(card: Pick<MixCard, "kind" | "title">, state: "ok" | "unavailable" | "too_small" = "ok"): string {
	const base = card.kind === "artist" ? `Lancer la radio ${card.title}` : `Lire le mix ${card.title}`;
	if (state === "unavailable") return `${base} : radio indisponible, toucher pour réessayer`;
	if (state === "too_small") return `${base} : pas assez d'albums`;
	return base;
}
