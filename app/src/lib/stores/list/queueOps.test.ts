import { describe, expect, it } from "vitest";
import { planInsert, planReorder, removeAt } from "./queueOps";

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
