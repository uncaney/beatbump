// Client-side helpers for local-library items. resolveArtistId mirrors the
// backend/indexer `la-` recipe (la- + sha1(norm(name))[:12]) so a local item
// always resolves to its artist page even if it carries no browseId.

function normName(s: string): string {
	return (s || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export async function laId(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(normName(text)));
	const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return "la-" + hex.slice(0, 12);
}

// entityHref decides the correct route for a browseId given its (optional) pageType.
// Critically: a subtitle/artist id (la-… or UC…) NEVER goes to /release (album route),
// which was the dead-end bug; an album id (lb-/MPRE/OLAK/VL…) goes to /release.
export function entityHref(browseId: string | undefined, pageType?: string): string {
	const id = browseId || "";
	const pt = pageType || "";
	if (/USER_CHANNEL/.test(pt)) return `/channel/${id}`;
	if (/ARTIST/.test(pt) || id.startsWith("la-") || id.startsWith("UC")) return `/artist/${id}`;
	if (
		/ALBUM|PLAYLIST|SINGLE|EP/.test(pt) ||
		id.startsWith("lb-") ||
		id.startsWith("MPRE") ||
		id.startsWith("OLAK") ||
		id.startsWith("VL")
	)
		return `/release?id=${id}`;
	// A bare subtitle entry is far more often an artist than an album.
	return `/artist/${id}`;
}

export async function resolveArtistId(item: any): Promise<string | null> {
	if (!item) return null;
	const sub = Array.isArray(item?.subtitle) ? item.subtitle : [];
	const direct =
		item?.artistInfo?.artist?.[0]?.browseId ||
		sub.find((s: any) => s?.browseId)?.browseId ||
		null;
	if (direct) return direct;
	const text =
		item?.artistInfo?.artist?.[0]?.text ||
		sub[0]?.text ||
		(typeof item?.artist === "string" ? item.artist : null);
	if (text) return await laId(text);
	return null;
}
