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
