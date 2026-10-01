/**
 * Pure queue edits (no store, no player): the session list applies the
 * returned `{ mix, position }` and deals with playback / prefetch / tab sync.
 * Rows are compared by identity (the queue holds its own objects) and, for
 * the Dedupe Automix rule, by `videoId` (first occurrence wins, the same rule
 * as `filterList`).
 */

type Row = { videoId?: string };

const clamp = (position: number, length: number) =>
	Math.min(Math.max(position, 0), Math.max(length - 1, 0));

/**
 * Remove the row at `index`. The cursor keeps pointing at the playing row
 * (it shifts left by one when a row before it is removed). `replay` is true
 * when the playing row itself was removed: the cursor then points at the row
 * that took its place (or the last row), which the caller must start (G3).
 */
export function removeAt<T>(mix: T[], position: number, index: number): { mix: T[]; position: number; replay: boolean } {
	if (index < 0 || index >= mix.length) return { mix, position, replay: false };
	const next = [...mix.slice(0, index), ...mix.slice(index + 1)];
	const newPosition = index < position ? position - 1 : clamp(position, next.length);
	return { mix: next, position: newPosition, replay: index === position && next.length > 0 };
}

/**
 * H13: whether the row that takes a removed playing row's place should
 * start right away: only when the removed row was the playing one
 * (`replay`) AND the player was running. Paused stays paused: the new row
 * is loaded, shown in the player bar, and waits for the user.
 */
export function removalAutoplay(replay: boolean, paused: boolean): boolean {
	return replay && !paused;
}

/**
 * Insert `items` at `key + 1`. With `dedupe` (Dedupe Automix) a videoId is
 * kept once, first occurrence wins: an inserted row whose videoId already
 * sits at or before the insertion point is dropped (`inserted` counts the
 * rows that survive; 0 = nothing changed, G4), while an older copy further
 * down the queue is removed (the row effectively moves up). The cursor is
 * re-anchored on the playing row's identity, so a removal before it never
 * leaves it on a different track.
 */
export function planInsert<T extends Row>(
	mix: T[],
	position: number,
	items: T[],
	key: number,
	dedupe: boolean,
): { mix: T[]; position: number; inserted: number } {
	const at = Math.min(Math.max(key + 1, 0), mix.length);
	let next = [...mix.slice(0, at), ...items, ...mix.slice(at)];
	let inserted = items.length;
	if (dedupe) {
		const seen = new Set<string>();
		next = next.filter((row) => {
			const id = row?.videoId;
			if (!id) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
		const kept = new Set<T>(next);
		inserted = items.filter((row) => kept.has(row)).length;
	}
	return { mix: next, position: anchor(mix, position, next), inserted };
}

/**
 * Replace the queue with `mix`, a permutation of it (drag reorder, G1).
 * Returns null when `mix` is not the same set of rows (a stale list from
 * a drag that straddled a queue change is refused rather than applied).
 */
export function planReorder<T>(mix: T[], position: number, reordered: T[]): { mix: T[]; position: number } | null {
	if (!Array.isArray(reordered) || reordered.length !== mix.length) return null;
	// Same multiset of row objects (a row may legitimately sit in the queue twice).
	const count = (list: T[]) => {
		const m = new Map<T, number>();
		for (const r of list) m.set(r, (m.get(r) ?? 0) + 1);
		return m;
	};
	const before = count(mix);
	const after = count(reordered);
	if (before.size !== after.size) return null;
	for (const [r, n] of before) if (after.get(r) !== n) return null;
	return { mix: reordered.slice(), position: anchor(mix, position, reordered) };
}

/** Index of the playing row (by identity) in `next`, else the clamped old position. */
function anchor<T>(mix: T[], position: number, next: T[]): number {
	const current = mix[position];
	const idx = current === undefined ? -1 : next.indexOf(current);
	return idx >= 0 ? idx : clamp(position, next.length);
}

/**
 * Apply a session-list mix operation (H3): `append` (continuation) adds
 * `items` after the queue, `set` replaces it. `position` is the cursor the
 * caller means in the resulting, not yet deduplicated list (for `append`
 * the current cursor, for `set` the requested one). With `dedupe` (Dedupe
 * Automix ON, both ops) a videoId is kept once, first occurrence wins, except
 * that the playing row always survives (an earlier copy of it is dropped
 * instead), and the cursor is re-anchored on that row by identity, so the
 * highlight and "next" never drift onto another track. Without `dedupe` the
 * list is kept as is (duplicates included) and the cursor is unchanged.
 * Never mutates its inputs.
 */
export function applyMixOp<T extends Row>(
	mix: T[],
	position: number,
	op: "append" | "set",
	items: T[],
	dedupe: boolean,
): { mix: T[]; position: number } {
	const next = op === "append" ? [...mix, ...items] : items.slice();
	if (!dedupe) return { mix: next, position };
	const current = position >= 0 && position < next.length ? next[position] : undefined;
	const currentId = current?.videoId;
	const seen = new Set<string>();
	const kept = next.filter((row) => {
		if (row === current) return true;
		const id = row?.videoId;
		if (!id) return true;
		if (id === currentId) return false; // the playing row is this videoId's copy
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
	const idx = current === undefined ? -1 : kept.indexOf(current);
	return { mix: kept, position: idx >= 0 ? idx : clamp(position, kept.length) };
}

/** Same rows (by identity) in the same order. */
function sameOrder<T>(a: T[], b: T[]): boolean {
	return a.length === b.length && a.every((r, i) => r === b[i]);
}

/** Index of `row` in `list`: by identity, else first row with the same videoId. */
function locate<T extends Row>(list: T[], row: T): number {
	const idx = list.indexOf(row);
	if (idx >= 0 || !row?.videoId) return idx;
	return list.findIndex((r) => r?.videoId === row.videoId);
}

/**
 * Rebase a drag reorder on a queue that changed during the gesture (H4).
 * `base` is the queue when the drag started, `reordered` the private copy
 * after the drag, `moved` the dragged row, `fresh` the queue now. The drag
 * must be a single move of `moved` (base and reordered equal once `moved`
 * is taken out), which is re-applied on `fresh`: `moved` is placed right
 * after the row that precedes it in `reordered` (or before the row that
 * follows it, or first when it has no neighbour). Rows are found by identity,
 * else by videoId. Returns null (abort) when the drag was not a single move
 * or `moved` / its neighbours are gone from `fresh`. Never mutates inputs.
 */
export function rebaseMove<T extends Row>(fresh: T[], base: T[], reordered: T[], moved: T): T[] | null {
	const to = reordered.indexOf(moved);
	if (to < 0 || base.indexOf(moved) < 0) return null;
	const strip = (list: T[]) => list.filter((r) => r !== moved);
	if (!sameOrder(strip(base), strip(reordered))) return null;
	const from = locate(fresh, moved);
	if (from < 0) return null;
	const row = fresh[from];
	const rest = [...fresh.slice(0, from), ...fresh.slice(from + 1)];
	const prev = to > 0 ? reordered[to - 1] : undefined;
	const next = to < reordered.length - 1 ? reordered[to + 1] : undefined;
	let at = -1;
	if (prev !== undefined) {
		const p = locate(rest, prev);
		if (p >= 0) at = p + 1;
	} else {
		at = 0;
	}
	if (at < 0 && next !== undefined) {
		const n = locate(rest, next);
		if (n >= 0) at = n;
	}
	if (at < 0) return null;
	return [...rest.slice(0, at), row, ...rest.slice(at)];
}

export type DragCommit<T> =
	/** Hand `mix` to SessionListService.reorder (`rebased`: the queue changed). */
	| { kind: "apply"; mix: T[]; rebased: boolean }
	/** The drag did not change the order: nothing to commit. */
	| { kind: "noop" }
	/** The queue changed during the drag and the move cannot be rebased. */
	| { kind: "abort" };

/**
 * What a queue drag commits on drop (H4): the private copy as is when the
 * queue still holds the drag-start rows in the same order, else the single
 * move rebased on the fresh queue (`rebaseMove`), else an abort. The cursor
 * is then re-anchored by `planReorder` on the fresh playing row.
 */
export function planDragCommit<T extends Row>(base: T[], reordered: T[], moved: T | null, fresh: T[]): DragCommit<T> {
	if (sameOrder(base, reordered)) return { kind: "noop" };
	if (sameOrder(base, fresh)) return { kind: "apply", mix: reordered.slice(), rebased: false };
	const rebased = moved ? rebaseMove(fresh, base, reordered, moved) : null;
	return rebased ? { kind: "apply", mix: rebased, rebased: true } : { kind: "abort" };
}

/**
 * I20: an owned-library row (served by /localf: a `localUrl` or an 11-hex
 * lid, the backend `isLid()` rule), as opposed to a YouTube track.
 */
export function isLibraryRow(row: { videoId?: unknown; localUrl?: unknown } | null | undefined): boolean {
	if (!row) return false;
	if (typeof row.localUrl === "string" && row.localUrl) return true;
	return typeof row.videoId === "string" && /^[0-9a-f]{11}$/.test(row.videoId);
}

/**
 * I20: the mix type of a "Lire tout" queue. "local" (C4 library continuation
 * at the end) only when every row is a library row; any YouTube row makes it
 * a "playlist" queue, so its end continues with the YouTube radio.
 */
export function playAllMixType(rows: ReadonlyArray<{ videoId?: unknown; localUrl?: unknown } | null | undefined>): "local" | "playlist" {
	return rows.length > 0 && rows.every((r) => isLibraryRow(r)) ? "local" : "playlist";
}
