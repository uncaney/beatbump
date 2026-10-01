import { describe, expect, it } from "vitest";
import { applyMixOp, planDragCommit, planInsert, planReorder, rebaseMove, removalAutoplay, removeAt, isLibraryRow, playAllMixType } from "./queueOps";

const row = (videoId: string) => ({ videoId, title: "T " + videoId });
const ids = (list: { videoId?: string }[]) => list.map((r) => r.videoId);

describe("removeAt (G3)", () => {
	const mix = [row("A"), row("B"), row("C"), row("D")];
	it("before the cursor: cursor shifts left, no replay", () => {
		const r = removeAt(mix, 2, 0);
		expect(ids(r.mix)).toEqual(["B", "C", "D"]);
		expect(r.position).toBe(1);
		expect(r.mix[r.position]).toBe(mix[2]);
		expect(r.replay).toBe(false);
	});
	it("the playing row: cursor stays, the row that takes its place must be played", () => {
		const r = removeAt(mix, 1, 1);
		expect(ids(r.mix)).toEqual(["A", "C", "D"]);
		expect(r.position).toBe(1);
		expect(r.mix[r.position].videoId).toBe("C");
		expect(r.replay).toBe(true);
	});
	it("the playing row when it is the last one: cursor on the new last row", () => {
		const r = removeAt(mix, 3, 3);
		expect(r.position).toBe(2);
		expect(r.replay).toBe(true);
	});
	it("after the cursor: nothing moves", () => {
		const r = removeAt(mix, 1, 3);
		expect(r.position).toBe(1);
		expect(r.replay).toBe(false);
	});
	it("H13: the replacement row starts only when the player was running", () => {
		expect(removalAutoplay(true, false)).toBe(true);
		expect(removalAutoplay(true, true)).toBe(false); // paused stays paused
		expect(removalAutoplay(false, false)).toBe(false); // nothing to replay
		expect(removalAutoplay(false, true)).toBe(false);
	});
	it("the only row: empty queue, nothing to replay; out of range is a no-op", () => {
		const one = [row("A")];
		expect(removeAt(one, 0, 0)).toEqual({ mix: [], position: 0, replay: false });
		expect(removeAt(mix, 1, 9).mix).toBe(mix);
		expect(removeAt(mix, 1, -1).mix).toBe(mix);
	});
});

describe("planInsert (G4)", () => {
	it("inserts after the key without dedupe", () => {
		const mix = [row("A"), row("B"), row("C")];
		const r = planInsert(mix, 1, [row("X")], 1, false);
		expect(ids(r.mix)).toEqual(["A", "B", "X", "C"]);
		expect(r.position).toBe(1);
		expect(r.inserted).toBe(1);
	});
	it("dedupe: a track already played (before the cursor) is dropped and reported", () => {
		const mix = [row("A"), row("B"), row("C")];
		const r = planInsert(mix, 1, [row("A")], 1, true);
		expect(ids(r.mix)).toEqual(["A", "B", "C"]);
		expect(r.inserted).toBe(0);
		expect(r.position).toBe(1);
	});
	it("dedupe: 'ajouter a la file' of a track already queued is a reported no-op", () => {
		const mix = [row("A"), row("B"), row("C")];
		const r = planInsert(mix, 0, [row("C")], 2, true);
		expect(ids(r.mix)).toEqual(["A", "B", "C"]);
		expect(r.inserted).toBe(0);
	});
	it("dedupe: an older copy further down moves up, the cursor stays on its track", () => {
		const mix = [row("A"), row("B"), row("C"), row("D")];
		const r = planInsert(mix, 2, [row("D")], 0, true);
		expect(ids(r.mix)).toEqual(["A", "D", "B", "C"]);
		expect(r.inserted).toBe(1);
		expect(r.mix[r.position]).toBe(mix[2]); // C is still the playing row
		expect(r.position).toBe(3);
	});
	it("dedupe: an album insert moves a queued-later copy up, drops an already-played one", () => {
		const later = [row("A"), row("B")];
		const r = planInsert(later, 0, [row("B"), row("X"), row("Y")], 0, true);
		expect(ids(r.mix)).toEqual(["A", "B", "X", "Y"]);
		expect(r.inserted).toBe(3);
		const played = [row("A"), row("B")];
		const p = planInsert(played, 1, [row("B"), row("X"), row("Y")], 1, true);
		expect(ids(p.mix)).toEqual(["A", "B", "X", "Y"]);
		expect(p.mix[1]).toBe(played[1]); // the played copy stays, the new one is dropped
		expect(p.inserted).toBe(2);
		expect(p.position).toBe(1);
	});
	it("empty queue: the item becomes row 0", () => {
		const r = planInsert([], 0, [row("A")], -1, true);
		expect(ids(r.mix)).toEqual(["A"]);
		expect(r.position).toBe(0);
		expect(r.inserted).toBe(1);
	});
});

describe("planReorder (G1)", () => {
	const mix = [row("A"), row("B"), row("C")];
	it("applies a permutation and keeps the cursor on the playing row", () => {
		const r = planReorder(mix, 0, [mix[0], mix[2], mix[1]]);
		expect(r).not.toBeNull();
		expect(ids(r!.mix)).toEqual(["A", "C", "B"]);
		expect(r!.position).toBe(0);
		const moved = planReorder(mix, 1, [mix[1], mix[0], mix[2]]);
		expect(moved!.position).toBe(0);
		expect(moved!.mix).not.toBe(mix); // a fresh array, so store subscribers are notified
	});
	it("H12: a row dragged across the cursor, either way: the cursor follows the playing row", () => {
		const q = [row("A"), row("B"), row("C"), row("D")];
		// playing C; D dragged before A (a drop before the cursor)
		const r = planReorder(q, 2, [q[3], q[0], q[1], q[2]]);
		expect(ids(r!.mix)).toEqual(["D", "A", "B", "C"]);
		expect(r!.position).toBe(3);
		// playing B; A (before the cursor) dragged to the end
		const r2 = planReorder(q, 1, [q[1], q[2], q[3], q[0]]);
		expect(ids(r2!.mix)).toEqual(["B", "C", "D", "A"]);
		expect(r2!.position).toBe(0);
		// playing A; the playing row itself dragged last
		expect(planReorder(q, 0, [q[1], q[2], q[3], q[0]])!.position).toBe(3);
	});
	it("refuses a list that is not the same rows", () => {
		expect(planReorder(mix, 0, [mix[0], mix[1]])).toBeNull();
		expect(planReorder(mix, 0, [mix[0], mix[1], row("Z")])).toBeNull();
		expect(planReorder(mix, 0, [mix[0], mix[0], mix[1]])).toBeNull();
	});
	it("accepts the same row listed twice when the queue holds it twice", () => {
		const dup = row("A");
		const q = [dup, row("B"), dup];
		expect(planReorder(q, 1, [dup, dup, q[1]])!.position).toBe(2);
		expect(planReorder(q, 1, [dup, q[1], q[1]])).toBeNull();
	});
});

describe("applyMixOp (H3, Dedupe Automix)", () => {
	it("set with dedupe ON drops later duplicates (initial queue)", () => {
		const a = row("A");
		const r = applyMixOp([], 0, "set", [a, row("B"), row("A")], true);
		expect(ids(r.mix)).toEqual(["A", "B"]);
		expect(r.mix[r.position]).toBe(a);
	});
	it("set with dedupe OFF keeps duplicates and the requested cursor", () => {
		const r = applyMixOp([], 2, "set", [row("A"), row("B"), row("A")], false);
		expect(ids(r.mix)).toEqual(["A", "B", "A"]);
		expect(r.position).toBe(2);
	});
	it("append with dedupe OFF keeps duplicates (continuation respects the setting)", () => {
		const mix = [row("A"), row("B")];
		const r = applyMixOp(mix, 1, "append", [row("B"), row("C")], false);
		expect(ids(r.mix)).toEqual(["A", "B", "B", "C"]);
		expect(r.position).toBe(1);
		expect(mix.length).toBe(2); // input untouched
	});
	it("append with dedupe ON re-anchors on the playing row by identity", () => {
		const mix = [row("A"), row("B"), row("A"), row("C")];
		const playing = mix[2];
		const r = applyMixOp(mix, 2, "append", [row("D"), row("C")], true);
		expect(r.mix[r.position]).toBe(playing);
		expect(ids(r.mix)).toEqual(["B", "A", "C", "D"]);
		expect(r.mix[r.position + 1].videoId).toBe("C"); // "next" is C, not skipped
	});
	it("append with dedupe ON, cursor before the duplicates: stays on the same row", () => {
		const mix = [row("A"), row("B"), row("C")];
		const r = applyMixOp(mix, 1, "append", [row("A"), row("D")], true);
		expect(ids(r.mix)).toEqual(["A", "B", "C", "D"]);
		expect(r.mix[r.position]).toBe(mix[1]);
	});
	it("out-of-range cursor and rows without videoId are tolerated", () => {
		const r = applyMixOp([], 5, "set", [row("A"), {} as { videoId?: string }, row("A")], true);
		expect(r.mix.length).toBe(2);
		expect(r.position).toBe(1);
	});
});

describe("planDragCommit / rebaseMove (H4, queue changed during a drag)", () => {
	const make = () => {
		const [a, b, c, d] = [row("A"), row("B"), row("C"), row("D")];
		return { a, b, c, d, base: [a, b, c] };
	};
	it("queue unchanged: commits the private copy as is", () => {
		const { a, b, c, base } = make();
		const r = planDragCommit(base, [a, c, b], c, base.slice());
		expect(r.kind).toBe("apply");
		if (r.kind === "apply") {
			expect(r.mix).toEqual([a, c, b]);
			expect(r.rebased).toBe(false);
		}
	});
	it("no move: noop", () => {
		const { base } = make();
		expect(planDragCommit(base, base.slice(), base[2], [...base, row("X")]).kind).toBe("noop");
	});
	it("continuation appended during the drag: the move is rebased, new rows kept", () => {
		const { a, b, c, d, base } = make();
		const fresh = [a, b, c, d];
		const r = planDragCommit(base, [a, c, b], c, fresh);
		expect(r.kind).toBe("apply");
		if (r.kind === "apply") {
			expect(r.mix).toEqual([a, c, b, d]);
			expect(r.rebased).toBe(true);
			// still a permutation of the fresh queue: planReorder accepts it and
			// anchors the cursor on the fresh playing row
			const plan = planReorder(fresh, 1, r.mix);
			expect(plan?.mix[plan.position]).toBe(b);
		}
	});
	it("a row removed during the drag: rebases on the next neighbour", () => {
		const { a, b, c, d } = make();
		const base = [a, b, c, d];
		// C dragged to the front... [C, A, B, D]; meanwhile A was removed
		const r = rebaseMove([b, c, d], base, [c, a, b, d], c);
		expect(r).toEqual([c, b, d]);
		// D dragged after A; meanwhile A was removed: falls back to before B
		expect(rebaseMove([b, c, d], base, [a, d, b, c], d)).toEqual([d, b, c]);
	});
	it("rows re-created with the same videoId are matched by videoId", () => {
		const { a, b, c, base } = make();
		const fresh = [row("A"), row("B"), row("C"), row("D")];
		expect(ids(rebaseMove(fresh, base, [c, a, b], c) ?? [])).toEqual(["C", "A", "B", "D"]);
	});
	it("aborts when the dragged row is gone or the drag was not a single move", () => {
		const { a, b, c, d, base } = make();
		expect(planDragCommit(base, [a, c, b], c, [a, b, d]).kind).toBe("abort");
		expect(planDragCommit(base, [c, a, b], c, [a, b, c, d]).kind).toBe("apply");
		// not a single move of the dragged row (a jump swapped two rows)
		expect(rebaseMove([a, b, c, d], base, [b, c, a], b)).toBeNull();
		expect(planDragCommit(base, [b, c, a], b, [a, b, c, d]).kind).toBe("abort");
		expect(planDragCommit(base, [c, b, a], c, [a, b, c, d]).kind).toBe("abort");
		expect(planDragCommit(base, [c, a, b], null, [a, b, c, d]).kind).toBe("abort");
	});
});

describe("I20: playAllMixType / isLibraryRow", () => {
	const yt = { videoId: "dQw4w9WgXcQ" };
	const lib = { videoId: "0123456789a" };
	const cached = { videoId: "dQw4w9WgXcQ", localUrl: "/localf?lid=1" };
	it("tells library rows from YouTube rows", () => {
		expect(isLibraryRow(lib)).toBe(true);
		expect(isLibraryRow(cached)).toBe(true);
		expect(isLibraryRow(yt)).toBe(false);
		expect(isLibraryRow(null)).toBe(false);
	});
	it("local only when every row is a library row", () => {
		expect(playAllMixType([lib, cached])).toBe("local");
		expect(playAllMixType([lib, yt])).toBe("playlist");
		expect(playAllMixType([yt])).toBe("playlist");
		expect(playAllMixType([])).toBe("playlist");
	});
});
