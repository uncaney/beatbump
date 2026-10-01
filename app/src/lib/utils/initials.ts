// Cover placeholder helpers: when a cover <img> fails (bridge `/cover?lid=`
// without art) the tile shows two uppercase initials of the album or artist on
// a hue derived from that name, instead of the generic "?" image. Pure
// functions, no DOM: unit-tested in initials.test.ts.

/** Two uppercase initials: first letters of the first two words, or the first two letters of a single word. */
export function initials(label: string | undefined | null): string {
	const words = String(label ?? "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return "";
	const chars = (w: string) => Array.from(w);
	if (words.length === 1) return chars(words[0]).slice(0, 2).join("").toUpperCase();
	return (chars(words[0])[0] + chars(words[1])[0]).toUpperCase();
}

/** Deterministic hue (0-359) for a label; case / surrounding spaces do not change it. */
export function hueFor(label: string | undefined | null): number {
	const s = String(label ?? "").trim().toLowerCase();
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
	return h % 360;
}

/**
 * The name the placeholder stands for: the entity's own title for album /
 * artist / playlist cards, else the track's album, else its artist, else its
 * title.
 */
export function coverLabel(item: any): string {
	if (!item || typeof item !== "object") return "";
	const title = typeof item.title === "string" ? item.title : "";
	const pageType = String(item.endpoint?.pageType ?? "");
	if (/ALBUM|SINGLE|EP|ARTIST|PLAYLIST|USER_CHANNEL/.test(pageType)) return title;
	if (/^(artists?|albums?|playlists?)$/.test(String(item.type ?? ""))) return title;
	const album = item.album?.title ?? item.album?.text ?? item.album?.name ?? item.albumName;
	if (typeof album === "string" && album.trim()) return album;
	const subtitle: any[] = Array.isArray(item.subtitle) ? item.subtitle : [];
	const artist =
		subtitle.find((s) => s && /ARTIST/.test(String(s.pageType ?? "")) && typeof s.text === "string")?.text ??
		item.artistInfo?.artist?.[0]?.text ??
		(typeof item.artist === "string" ? item.artist : undefined) ??
		subtitle.find((s) => s && typeof s.text === "string" && s.text.trim())?.text;
	if (typeof artist === "string" && artist.trim()) return artist;
	return title;
}
