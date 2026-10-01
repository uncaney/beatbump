// S3 "Historique par jour": pure helpers for /library/recent. The history
// (me/stats/recent, one row per ref, most recent first) is split into local
// calendar days; each day's group lists its rows most recent first and replays
// them in listening order (oldest first).
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DayGroup {
	/** Local calendar day, YYYY-MM-DD. */
	key: string;
	/** "Aujourd'hui", "Hier", "mardi 29 septembre" (year added when not the current one). */
	label: string;
	/** Rows of the day, most recent first (display order). */
	items: any[];
	/** Rows of the day in listening order (oldest first): the replay queue. */
	replay: any[];
}

/** Epoch ms from a number (s or ms), a numeric string or an ISO date; NaN when unusable. */
export function toMs(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
	if (typeof v === "string" && v.trim()) {
		const s = v.trim();
		if (/^\d+$/.test(s)) return toMs(Number(s));
		const t = Date.parse(s);
		return Number.isFinite(t) ? t : NaN;
	}
	return NaN;
}

/**
 * Play time of row `i`: the response's `playedAt` array (aligned with
 * `items`), else a `playedAt` / `_playedAt` field on the row.
 */
export function playedAtOf(item: any, i: number, playedAt?: unknown): number {
	if (Array.isArray(playedAt)) {
		const t = toMs(playedAt[i]);
		if (Number.isFinite(t)) return t;
	}
	return toMs(item?.playedAt ?? item?._playedAt);
}

function dayKey(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** French label of the local day of `ms`, relative to `now`. */
export function dayLabel(ms: number, now: number = Date.now()): string {
	const d = new Date(ms);
	const n = new Date(now);
	const diff = Math.round((startOfDay(n) - startOfDay(d)) / 86400000);
	if (diff === 0) return "Aujourd'hui";
	if (diff === 1) return "Hier";
	const opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" };
	if (d.getFullYear() !== n.getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString("fr-FR", opts);
}

/**
 * Group the history by local day, most recent day first. Returns null when no
 * row carries a usable play time (the page then keeps the flat list). Rows
 * without a time are dropped from the groups.
 */
export function groupByDay(items: unknown, playedAt?: unknown, now: number = Date.now()): DayGroup[] | null {
	if (!Array.isArray(items)) return null;
	const rows: { item: any; t: number; i: number }[] = [];
	items.forEach((item, i) => {
		const t = playedAtOf(item, i, playedAt);
		if (item && Number.isFinite(t)) rows.push({ item, t, i });
	});
	if (!rows.length) return null;
	rows.sort((a, b) => b.t - a.t || a.i - b.i);
	const groups: DayGroup[] = [];
	const byKey = new Map<string, DayGroup>();
	for (const r of rows) {
		const key = dayKey(new Date(r.t));
		let g = byKey.get(key);
		if (!g) {
			g = { key, label: dayLabel(r.t, now), items: [], replay: [] };
			byKey.set(key, g);
			groups.push(g);
		}
		g.items.push(r.item);
	}
	for (const g of groups) g.replay = g.items.slice().reverse();
	return groups;
}
