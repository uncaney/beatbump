// HL3 "Préparer un pack": pick the tracks of a sized offline pack (100 / 250 /
// 500 Mo) out of what the profile listens to: not-yet-cached favourites first,
// then recent plays, then the me/mix items, deduped by videoId, each counted
// at its known size (`_bytes`, or `sizes`) else PACK_EST_BYTES. Pure (no SW /
// network): the settings page fetches the three sources, plans, then hands
// the items to keepOffline (downloaded + pinned, 2 at a time, cancellable).
import { keepableTracks } from "$lib/offlineBatch";
import { durationOf } from "$lib/offlineQueue";
import { formatMoFr } from "$lib/utils/formatFr";
import { formatDuration } from "$lib/utils/releaseMeta";

/** Size guess for a track never downloaded (a ~3-4 min Opus / AAC stream). */
export const PACK_EST_BYTES = 4 * 1024 * 1024;
export const PACK_SIZES_MB = [100, 250, 500] as const;
/** B6-16 "pack trajet": durations offered next to the sizes (seconds). */
export const PACK_DURATIONS_SEC = [1800, 3600, 7200, 14400] as const;
/** Duration guess for a track whose length is unknown. */
export const PACK_EST_SECONDS = 4 * 60;

/** A selector value: "100" (Mo) or "dur:3600" (seconds). */
export type PackChoice = { kind: "bytes"; mb: number } | { kind: "seconds"; seconds: number };
export function parsePackChoice(v: unknown): PackChoice | null {
	const s = String(v ?? "").trim();
	const d = s.match(/^dur:(\d+)$/);
	if (d) {
		const n = Number(d[1]);
		return (PACK_DURATIONS_SEC as readonly number[]).includes(n) ? { kind: "seconds", seconds: n } : null;
	}
	if (/^\d+$/.test(s)) {
		const n = Number(s);
		return (PACK_SIZES_MB as readonly number[]).includes(n) ? { kind: "bytes", mb: n } : null;
	}
	return null;
}
/** "30 min" / "1 h" / "2 h" / "4 h". */
export function packDurationLabel(seconds: number): string {
	return formatDuration(seconds);
}

export type PackCandidates = {
	favorites?: ReadonlyArray<any> | null;
	recent?: ReadonlyArray<any> | null;
	mix?: ReadonlyArray<any> | null;
	/** videoIds already in the SW cache (cachedIds store / list-audio): skipped. */
	cached?: Iterable<string> | null;
	/** Known sizes by videoId (list-audio entries, the local list `_bytes`). */
	sizes?: ReadonlyMap<string, number> | null;
};

export type PackItem = {
	item: any;
	videoId: string;
	bytes: number;
	estimated: boolean;
	/** Track length (seconds), PACK_EST_SECONDS when unknown. */
	seconds: number;
	source: "favorites" | "recent" | "mix";
};
export type PackPlan = {
	items: PackItem[];
	/** Planned bytes (known sizes + estimates). */
	bytes: number;
	/** Planned seconds (known durations + estimates). */
	seconds: number;
	count: number;
	/** The budget, in bytes ("bytes" mode) or seconds ("seconds" mode). */
	target: number;
	mode: "bytes" | "seconds";
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

export function packSecondsOf(item: any): number {
	const d = durationOf(item);
	return d && d > 0 ? Math.round(d) : PACK_EST_SECONDS;
}

/**
 * Fill up to `targetBytes` (or, with mode "seconds", up to `target` seconds of
 * listening, each track at its `duration` else PACK_EST_SECONDS): favourites, then recent plays, then mix, in their
 * own order, one entry per videoId, cached ones skipped. A track that does
 * not fit the remaining budget is left out and the next ones are still
 * tried (first fit), so a long favourite never blocks three short ones.
 */
export function planPack(candidates: PackCandidates | null | undefined, targetBytes: number, mode: "bytes" | "seconds" = "bytes"): PackPlan {
	const target = Number.isFinite(targetBytes) && targetBytes > 0 ? Math.floor(targetBytes) : 0;
	const cached = new Set<string>();
	for (const id of candidates?.cached ?? []) if (typeof id === "string" && id) cached.add(id);
	const sizes = candidates?.sizes ?? null;
	const seen = new Set<string>();
	const items: PackItem[] = [];
	let bytes = 0;
	let seconds = 0;
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
			const sec = packSecondsOf(item);
			const used = mode === "seconds" ? seconds + sec : bytes + s.bytes;
			if (target <= 0 || used > target) {
				left++;
				continue;
			}
			items.push({ item, videoId: id, bytes: s.bytes, estimated: s.estimated, seconds: sec, source });
			bytes += s.bytes;
			seconds += sec;
		}
	}
	return { items, bytes, seconds, count: items.length, target, mode, left, candidates: seenCandidates };
}

/** "12 morceaux · 48 Mo" for a plan, "3/12 · 12 Mo sur 100 Mo" while running. */
export function packLabel(done: number, total: number, doneBytes: number, target: number): string {
	const mb = (n: number) => formatMoFr(Math.max(0, Math.round(n / (1024 * 1024))));
	if (total <= 0) return "Aucun morceau à préparer";
	return `${done}/${total} · ${mb(doneBytes)} sur ${mb(target)}`;
}

/** "12/30 · 48 min sur 1 h" while a duration pack runs. */
export function packDurationText(done: number, total: number, doneSeconds: number, targetSeconds: number): string {
	if (total <= 0) return "Aucun morceau à préparer";
	const d = doneSeconds > 0 ? formatDuration(doneSeconds) : "0 min";
	return `${done}/${total} · ${d} sur ${formatDuration(targetSeconds)}`;
}

// ---- B7-7 "Rafraîchir mon pack" ----
// The last pack the card prepared is remembered (localStorage LAST_PACK_KEY:
// when it started, its mode / target, its tracks with their length). A
// refresh drops the pack tracks already listened to (a play event since the
// pack began: me/stats/recent `playedAt`, or the SW `lastAccess` of the entry
// moved after it was cached) and fills the same listening time with new
// tracks (planPack by seconds, the pack's own tracks excluded). Pinned
// entries outside the pack are never touched: only the dropped pack tracks
// are uncached.

export const LAST_PACK_KEY = "ytm-offline-pack-last";
export type LastPackItem = { videoId: string; seconds: number; bytes: number };
export type LastPack = { at: number; mode: "bytes" | "seconds"; target: number; items: LastPackItem[] };
type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** The record to remember for a plan that starts now. */
export function lastPackOf(plan: Pick<PackPlan, "items" | "mode" | "target">, at = Date.now()): LastPack {
	return {
		at,
		mode: plan.mode,
		target: plan.target,
		items: plan.items.map((i) => ({ videoId: i.videoId, seconds: i.seconds, bytes: i.bytes })),
	};
}

export function readLastPack(store: KV | null | undefined): LastPack | null {
	try {
		const raw = store?.getItem(LAST_PACK_KEY);
		if (!raw) return null;
		const p = JSON.parse(raw);
		if (!p || typeof p !== "object" || !Array.isArray(p.items)) return null;
		const at = Number(p.at);
		const items: LastPackItem[] = [];
		const seen = new Set<string>();
		for (const i of p.items) {
			const id = typeof i?.videoId === "string" ? i.videoId : "";
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const s = Number(i.seconds);
			const b = Number(i.bytes);
			items.push({ videoId: id, seconds: Number.isFinite(s) && s > 0 ? Math.round(s) : PACK_EST_SECONDS, bytes: Number.isFinite(b) && b > 0 ? Math.floor(b) : PACK_EST_BYTES });
		}
		if (!items.length) return null;
		return { at: Number.isFinite(at) && at > 0 ? at : 0, mode: p.mode === "bytes" ? "bytes" : "seconds", target: Number(p.target) || 0, items };
	} catch {
		return null;
	}
}

export function writeLastPack(store: KV | null | undefined, pack: LastPack | null): void {
	try {
		if (!store) return;
		if (!pack || !pack.items.length) store.removeItem(LAST_PACK_KEY);
		else store.setItem(LAST_PACK_KEY, JSON.stringify(pack));
	} catch {
		/* private mode / full storage: the refresh button is simply absent next time */
	}
}

export type PlayEvent = { videoId?: string | null; playedAt?: number | null };
export type ListenedSources = {
	/** SW list-audio entries (lastAccess moves when the SW serves the track). */
	entries?: ReadonlyArray<{ videoId?: string; at?: number; lastAccess?: number } | null | undefined> | null;
	/** Play events (me/stats/recent items zipped with `playedAt`, the local outbox). */
	plays?: Iterable<PlayEvent | null | undefined> | null;
};

/**
 * The pack tracks listened to since the pack began: a play event dated after
 * `pack.at`, or an SW entry served (lastAccess) after it was cached (and after
 * the pack began). Tracks outside the pack are never reported.
 */
export function listenedPackIds(pack: Pick<LastPack, "at" | "items">, src: ListenedSources): Set<string> {
	const inPack = new Set(pack.items.map((i) => i.videoId));
	const out = new Set<string>();
	const since = Math.max(0, Number(pack.at) || 0);
	for (const p of src.plays ?? []) {
		const id = typeof p?.videoId === "string" ? p.videoId : "";
		const at = Number(p?.playedAt);
		if (id && inPack.has(id) && Number.isFinite(at) && at > since) out.add(id);
	}
	for (const e of src.entries ?? []) {
		const id = typeof e?.videoId === "string" ? e.videoId : "";
		if (!id || !inPack.has(id)) continue;
		const cachedAt = Number(e?.at) || 0;
		const la = Number(e?.lastAccess) || 0;
		if (la > cachedAt && la > since) out.add(id);
	}
	return out;
}

export type PackRefreshPlan = {
	/** Pack tracks to uncache (listened). */
	drop: LastPackItem[];
	/** Pack tracks that stay. */
	keep: LastPackItem[];
	/** Listening time freed by `drop` (what `add` fills). */
	seconds: number;
	/** New tracks of that duration (planPack by seconds, pack tracks excluded). */
	add: PackPlan;
};

/**
 * The refresh: drop the listened pack tracks, plan as many seconds of new
 * tracks (favourites, recent plays, mix: same order as a pack, cached ones and
 * the pack's own tracks excluded). Pure: the card uncaches `drop`, then runs
 * `add` as a pack.
 */
export function planPackRefresh(pack: Pick<LastPack, "items">, listened: Iterable<string>, candidates: PackCandidates | null | undefined): PackRefreshPlan {
	const gone = new Set<string>();
	for (const id of listened) if (typeof id === "string" && id) gone.add(id);
	const drop: LastPackItem[] = [];
	const keep: LastPackItem[] = [];
	for (const i of pack.items) (gone.has(i.videoId) ? drop : keep).push(i);
	const seconds = drop.reduce((s, i) => s + i.seconds, 0);
	const cached = new Set<string>();
	for (const id of candidates?.cached ?? []) if (typeof id === "string" && id) cached.add(id);
	for (const i of pack.items) cached.add(i.videoId);
	const add = planPack({ ...(candidates ?? {}), cached }, seconds, "seconds");
	return { drop, keep, seconds, add };
}

/** The pack remembered after a refresh: what stayed plus what was added, dated now. */
export function refreshedLastPack(prev: Pick<LastPack, "mode" | "target">, plan: PackRefreshPlan, at = Date.now()): LastPack {
	return { at, mode: prev.mode, target: prev.target, items: [...plan.keep, ...lastPackOf(plan.add, at).items] };
}

/** "3 titres écoutés remplacés par 4 nouveaux (42 min)" / "Rien à rafraîchir : …". */
export function packRefreshSummary(plan: Pick<PackRefreshPlan, "drop" | "seconds" | "add">): string {
	if (!plan.drop.length) return "Rien à rafraîchir : aucun titre du pack n'a encore été écouté.";
	const dropped = `${plan.drop.length} titre${plan.drop.length > 1 ? "s" : ""} écouté${plan.drop.length > 1 ? "s" : ""}`;
	if (!plan.add.count) return `Rien à rafraîchir : pas de nouveau titre pour remplacer ${dropped} (${formatDuration(plan.seconds)}).`;
	return `${dropped} remplacé${plan.drop.length > 1 ? "s" : ""} par ${plan.add.count} nouveau${plan.add.count > 1 ? "x" : ""} (${formatDuration(plan.add.seconds)})`;
}
