// HL2 "Libérer de l'espace": pick the cached audio entries to drop so that at
// least `targetBytes` get freed, least recently accessed first, never a pinned
// entry. Pure (no SW / DOM): the service worker's `list-audio` entries
// ($lib/offline AudioListEntry) go in, the entries to uncache come out; the
// settings page applies the plan (uncache-audio per entry + applySwEviction so
// the "Prêt hors-ligne" badges follow at once).
import { formatBytesFr, formatCountFr } from "$lib/utils/formatFr";

export type FreeUpCandidate = {
	videoId?: string;
	url?: string;
	bytes?: number;
	/** Last time the SW served the entry (ms); falls back to `at` (cached at). */
	lastAccess?: number;
	at?: number;
	pinned?: boolean;
};

export type FreeUpPlan<T extends FreeUpCandidate = FreeUpCandidate> = {
	/** Entries to uncache, least recently accessed first. */
	entries: T[];
	/** Bytes those entries hold (what the plan frees). */
	bytes: number;
	count: number;
	target: number;
	/** false when every non-pinned entry together still frees less than the target. */
	reached: boolean;
	/** Bytes held by the entries the plan may never touch (pinned, protected). */
	protectedBytes: number;
};

export type FreeUpOptions = {
	/** videoIds never dropped (the track playing now, a batch in flight). */
	protect?: Iterable<string>;
};

function accessOf(e: FreeUpCandidate): number {
	const la = Number(e.lastAccess);
	if (Number.isFinite(la) && la > 0) return la;
	const at = Number(e.at);
	return Number.isFinite(at) && at > 0 ? at : 0;
}

function bytesOf(e: FreeUpCandidate): number {
	const b = Number(e.bytes);
	return Number.isFinite(b) && b > 0 ? b : 0;
}

/**
 * The entries to drop to free `targetBytes`: non-pinned (and non-protected)
 * entries sorted by last access (oldest first, `at` as tie-break), taken until
 * their summed bytes reach the target. Entries without a known size free
 * nothing measurable and are left alone. A target <= 0 plans nothing.
 */
export function planFreeUp<T extends FreeUpCandidate>(entries: ReadonlyArray<T | null | undefined>, targetBytes: number, opts: FreeUpOptions = {}): FreeUpPlan<T> {
	const target = Number.isFinite(targetBytes) && targetBytes > 0 ? Math.floor(targetBytes) : 0;
	const protect = new Set<string>();
	for (const id of opts.protect ?? []) if (typeof id === "string" && id) protect.add(id);
	const pool: T[] = [];
	let protectedBytes = 0;
	for (const e of entries || []) {
		if (!e) continue;
		if (e.pinned === true || (e.videoId && protect.has(e.videoId))) {
			protectedBytes += bytesOf(e);
			continue;
		}
		if (bytesOf(e) <= 0) continue;
		pool.push(e);
	}
	pool.sort((a, b) => accessOf(a) - accessOf(b) || bytesOf(b) - bytesOf(a));
	const out: T[] = [];
	let bytes = 0;
	if (target > 0) {
		for (const e of pool) {
			if (bytes >= target) break;
			out.push(e);
			bytes += bytesOf(e);
		}
	}
	return { entries: out, bytes, count: out.length, target, reached: bytes >= target && target > 0, protectedBytes };
}

/** "3 morceaux · 12 Mo" ($lib/utils/formatFr: no-break spaces, decimal comma). */
export function freeUpSummary(plan: Pick<FreeUpPlan, "count" | "bytes">): string {
	if (!plan.count) return "Rien à libérer";
	return `${formatCountFr(plan.count, "morceau", "morceaux")} · ${formatBytesFr(plan.bytes)}`;
}
