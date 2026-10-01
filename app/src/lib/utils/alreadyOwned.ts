// D5 "Tu l'as déjà": on a YouTube album page, the local twin of the album
// (strict artist + title match, GET /api/v1/local/albums/match).
import { APIClient } from "$lib/api";

export type OwnedAlbum = {
	id: string;
	title: string;
	artist: string;
	thumbnail?: string;
	trackCount?: number;
	href: string;
};

/** Only YouTube album ids (MPREb_…) ask the library; local lb- pages never do. */
export function isYouTubeAlbumId(id: string | null | undefined): boolean {
	return typeof id === "string" && id.startsWith("MPREb_");
}

/** Validates the endpoint answer: a local lb- album with its /release link, else null. */
export function parseOwnedMatch(body: unknown): OwnedAlbum | null {
	const m = (body as { match?: unknown } | null)?.match as Partial<OwnedAlbum> | null | undefined;
	if (!m || typeof m !== "object") return null;
	if (typeof m.id !== "string" || !m.id.startsWith("lb-")) return null;
	return {
		id: m.id,
		title: typeof m.title === "string" ? m.title : "",
		artist: typeof m.artist === "string" ? m.artist : "",
		thumbnail: typeof m.thumbnail === "string" && m.thumbnail ? m.thumbnail : undefined,
		trackCount: typeof m.trackCount === "number" ? m.trackCount : undefined,
		href: `/release?id=${encodeURIComponent(m.id)}`,
	};
}

/** Strict local match of a YouTube album; null on no match or any error. */
export async function findOwnedAlbum(artist: string, title: string): Promise<OwnedAlbum | null> {
	if (!artist.trim() || !title.trim()) return null;
	try {
		const qs = new URLSearchParams({ artist, title }).toString();
		const res = await APIClient.fetch(`/api/v1/local/albums/match?${qs}`);
		if (!res.ok) return null;
		return parseOwnedMatch(await res.json());
	} catch {
		return null;
	}
}
