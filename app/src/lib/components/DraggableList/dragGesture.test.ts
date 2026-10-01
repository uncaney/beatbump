import { describe, expect, it } from "vitest";
import { HOLD_MS, holdDelay, holdStartsDrag, idleMove, keyTarget, moveIndex, swallowClick } from "./dragGesture";

describe("holdDelay", () => {
	it("starts at once from the grip, holds 250 ms on the row", () => {
		expect(holdDelay(true)).toBe(0);
		expect(holdDelay(false)).toBe(HOLD_MS);
	});
});

describe("idleMove", () => {
	it("mouse: 6 px of travel starts the drag", () => {
		expect(idleMove("mouse", 0, 5, true)).toBe("none");
		expect(idleMove("mouse", 0, -6, true)).toBe("drag");
		expect(idleMove("mouse", 4, 5, true)).toBe("drag");
		expect(idleMove("pen", -30, 0, true)).toBe("drag");
	});
	it("touch: leftward horizontal travel swipes when allowed", () => {
		expect(idleMove("touch", -24, 3, true)).toBe("swipe");
		expect(idleMove("touch", -24, 3, false)).toBe("cancel");
		expect(idleMove("touch", -30, -40, true)).toBe("cancel");
		expect(idleMove("touch", 24, 0, true)).toBe("cancel");
	});
	it("touch: small travel keeps the long press, more cancels it", () => {
		expect(idleMove("touch", 3, -8, true)).toBe("none");
		expect(idleMove("touch", 0, 9, true)).toBe("cancel");
	});
});

describe("swallowClick", () => {
	it("a grip press never plays the row, even released in place", () => {
		expect(swallowClick("mouse", true, false)).toBe(true);
		expect(swallowClick("mouse", true, true)).toBe(true);
	});
	it("a mouse hold on the row released in place stays a click", () => {
		expect(swallowClick("mouse", false, false)).toBe(false);
		expect(swallowClick("mouse", false, true)).toBe(true);
	});
	it("touch drags always swallow", () => {
		expect(swallowClick("touch", false, false)).toBe(true);
	});
});

describe("moveIndex", () => {
	const list = ["a", "b", "c", "d"];
	it("moves up and down without touching the input", () => {
		expect(moveIndex(list, 2, 1)).toEqual(["a", "c", "b", "d"]);
		expect(moveIndex(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
		expect(moveIndex(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
		expect(list).toEqual(["a", "b", "c", "d"]);
	});
	it("is a single move (not a swap) across several rows", () => {
		expect(moveIndex(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
	});
	it("returns a copy for no-op or out-of-range moves", () => {
		const same = moveIndex(list, 1, 1);
		expect(same).toEqual(list);
		expect(same).not.toBe(list);
		expect(moveIndex(list, -1, 2)).toEqual(list);
		expect(moveIndex(list, 1, 4)).toEqual(list);
	});
});

describe("keyTarget", () => {
	it("steps one row within bounds", () => {
		expect(keyTarget("ArrowUp", 2, 4)).toBe(1);
		expect(keyTarget("ArrowDown", 2, 4)).toBe(3);
		expect(keyTarget("ArrowUp", 0, 4)).toBeNull();
		expect(keyTarget("ArrowDown", 3, 4)).toBeNull();
		expect(keyTarget("Enter", 1, 4)).toBeNull();
	});
});

describe("mouse on the row body needs hold AND travel (I21)", () => {
	it("travel alone (quick click drifting 7 px) is not a drag", () => {
		expect(idleMove("mouse", 7, 0, true, 80)).toBe("none");
		expect(idleMove("mouse", 0, 40, true, HOLD_MS - 1)).toBe("none");
	});
	it("hold alone (released in place) is not a drag", () => {
		expect(idleMove("mouse", 2, 3, true, 2000)).toBe("none");
		expect(holdStartsDrag("mouse")).toBe(false);
		expect(holdStartsDrag("pen")).toBe(false);
	});
	it("hold then travel starts the drag", () => {
		expect(idleMove("mouse", 6, 0, true, HOLD_MS)).toBe("drag");
		expect(idleMove("pen", 0, -10, true, 600)).toBe("drag");
	});
	it("touch long press and the grip are unchanged", () => {
		expect(holdStartsDrag("touch")).toBe(true);
		expect(holdDelay(true)).toBe(0);
		expect(holdDelay(false)).toBe(HOLD_MS);
		expect(idleMove("touch", 0, 9, true, 50)).toBe("cancel");
	});
});
