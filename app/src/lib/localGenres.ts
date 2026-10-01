// c29b EQ2: the "Dans ta bibliothèque" genre chips on Explore (/trending),
// built from GET /api/v1/local/genres (the same answer /library/genres
// renders: {genres: [{name, count}]}, most tracks first). Pure, testable.

export interface LocalGenreLink {
	name: string;
	count: number;
	/** The all-songs genre view the genres page already links to. */
	href: string;
}

export const EXPLORE_GENRES_MAX = 12;

export function genreHref(name: string): string {
	return `/library/all-songs?genre=${encodeURIComponent(name)}`;
}

/**
 * Up to `max` genres as links, in the order the backend gives (track count
 * desc), blank / malformed rows and duplicate names dropped. An empty or
 * malformed answer gives no link (the section stays hidden).
 */
export function localGenreLinks(resp: unknown, max = EXPLORE_GENRES_MAX): LocalGenreLink[] {
	if (!resp || typeof resp !== "object") return [];
	const list = (resp as { genres?: unknown }).genres;
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: LocalGenreLink[] = [];
	for (const g of list) {
		const name = typeof (g as { name?: unknown })?.name === "string" ? ((g as { name: string }).name).trim() : "";
		if (!name) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const count = Number((g as { count?: unknown })?.count);
		out.push({ name, count: Number.isFinite(count) && count > 0 ? count : 0, href: genreHref(name) });
		if (out.length >= max) break;
	}
	return out;
}
