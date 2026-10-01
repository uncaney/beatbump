// HL3 "Préparer un pack": pick the tracks of a sized offline pack (100 / 250 /
// 500 Mo) out of what the profile listens to: not-yet-cached favourites first,
// then recent plays, then the me/mix items, deduped by videoId, each counted
// at its known size (`_bytes`, or `sizes`) else PACK_EST_BYTES. Pure (no SW /
// network): the settings page fetches the three sources, plans, then hands
// the items to keepOffline (downloaded + pinned, 2 at a time, cancellable).
import { keepableTracks } from "$lib/offlineBatch";
import { formatMoFr } from "$lib/utils/formatFr";

/** Size guess for a track never downloaded (a ~3-4 min Opus / AAC stream). */
export const PACK_EST_BYTES = 4 * 1024 * 1024;
export const PACK_SIZES_MB = [100, 250, 500] as const;

export type PackCandidates = {
	favorites?: ReadonlyArray<any> | null;
	recent?: ReadonlyArray<any> | null;
	mix?: ReadonlyArray<any> | null;
	/** videoIds already in the SW cache (cachedIds store / list-audio): skipped. */
	cached?: Iterable<string> | null;
	/** Known sizes by videoId (list-audio entries, the local list `_bytes`). */
	sizes?: ReadonlyMap<string, number> | null;
};

export type PackItem = { item: any; videoId: string; bytes: number; estimated: boolean; source: "favorites" | "recent" | "mix" };
export type PackPlan = {
	items: PackItem[];
	/** Planned bytes (known sizes + estimates). */
	bytes: number;
	count: number;
	target: number;
	/** Candidate tracks (deduped, uncached) that did not fit. */
	left: number;
	/** Uncached candidates seen in total (count + left). */
	candidates: number;
};

export function packSizeOf(item: any, sizes?: ReadonlyMap<string, number> | null): { bytes: number; estimated: boolean } {
	const own = Number(item?._bytes);
	if (Number.isFinite(own) && own > 0) return { bytes: Math.floor(own), estimated: false };
	const known = sizes && item?.videoId ? Number(sizes.get(String(item.videoId))) : NaN;
	if (Number.isFinite(known) && known > 0) return { bytes: Math.floor(known), estimated: false };
	return { bytes: PACK_EST_BYTES, estimated: true };
}

/**
 * Fill up to `targetBytes`: favourites, then recent plays, then mix, in their
 * own order, one entry per videoId, cached ones skipped. A track that does
 * not fit the remaining budget is left out and the next ones are still
 * tried (first fit), so a long favourite never blocks three short ones.
 */
export function planPack(candidates: PackCandidates | null | undefined, targetBytes: number): PackPlan {
	const target = Number.isFinite(targetBytes) && targetBytes > 0 ? Math.floor(targetBytes) : 0;
	const cached = new Set<string>();
	for (const id of candidates?.cached ?? []) if (typeof id === "string" && id) cached.add(id);
	const sizes = candidates?.sizes ?? null;
	const seen = new Set<string>();
	const items: PackItem[] = [];
	let bytes = 0;
	let left = 0;
	let seenCandidates = 0;
	const sources: Array<[PackItem["source"], ReadonlyArray<any> | null | undefined]> = [
		["favorites", candidates?.favorites],
		["recent", candidates?.recent],
		["mix", candidates?.mix],
	];
	for (const [source, list] of sources) {
		for (const item of keepableTracks(Array.isArray(list) ? (list as any[]) : [])) {
			const id = String(item.videoId);
			if (seen.has(id)) continue;
			seen.add(id);
			if (cached.has(id) || item._cached === true) continue;
			seenCandidates++;
			const s = packSizeOf(item, sizes);
			if (target <= 0 || bytes + s.bytes > target) {
				left++;
				continue;
			}
			items.push({ item, videoId: id, bytes: s.bytes, estimated: s.estimated, source });
			bytes += s.bytes;
		}
	}
	return { items, bytes, count: items.length, target, left, candidates: seenCandidates };
}

/** "12 morceaux · 48 Mo" for a plan, "3/12 · 12 Mo sur 100 Mo" while running. */
export function packLabel(done: number, total: number, doneBytes: number, target: number): string {
	const mb = (n: number) => formatMoFr(Math.max(0, Math.round(n / (1024 * 1024))));
	if (total <= 0) return "Aucun morceau à préparer";
	return `${done}/${total} · ${mb(doneBytes)} sur ${mb(target)}`;
}
