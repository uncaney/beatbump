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
