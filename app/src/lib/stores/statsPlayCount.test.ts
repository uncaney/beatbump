import { describe, expect, it } from "vitest";
import { historyThreshold, isLoopRestart, listenedSeconds } from "./statsPlayCount";

describe("historyThreshold", () => {
	it("is 30 s for normal tracks and half of a short track", () => {
		expect(historyThreshold(200)).toBe(30);
		expect(historyThreshold(0)).toBe(30);
		expect(historyThreshold(40)).toBe(20);
	});
});

describe("isLoopRestart (G10 repeat one)", () => {
	it("detects the wrap from the end back to the start", () => {
		expect(isLoopRestart(199.6, 0.1, 200)).toBe(true);
		expect(isLoopRestart(198, 2, 200)).toBe(true);
	});
	it("ignores ordinary progress and mid-track seeks", () => {
		expect(isLoopRestart(10, 10.25, 200)).toBe(false);
		expect(isLoopRestart(120, 0, 200)).toBe(false);
		expect(isLoopRestart(199.6, 60, 200)).toBe(false);
		expect(isLoopRestart(0.2, 199, 200)).toBe(false);
	});
	it("needs a known duration", () => {
		expect(isLoopRestart(199.6, 0.1, 0)).toBe(false);
		expect(isLoopRestart(199.6, 0.1, NaN)).toBe(false);
		expect(isLoopRestart(199.6, 0.1, Infinity)).toBe(false);
	});
	it("one loop = one new play, counted again only after the threshold", () => {
		// Simulate timeupdates over two loops of a 100 s track and count plays.
		const duration = 100;
		let sent = false;
		let prev = 0;
		let plays = 0;
		const ticks: number[] = [];
		for (let loop = 0; loop < 2; loop++) for (let t = 0; t < duration; t += 0.25) ticks.push(t);
		ticks.push(0, 0.25, 10); // third loop stopped at 10 s: not a play
		for (const t of ticks) {
			if (sent && isLoopRestart(prev, t, duration)) sent = false;
			prev = t;
			if (!sent && t >= historyThreshold(duration)) {
				sent = true;
				plays++;
			}
		}
		expect(plays).toBe(2);
	});
});

describe("listenedSeconds (I6)", () => {
	const listen = (from: number, to: number, step = 0.25) => {
		let acc = 0;
		for (let t = from; t + step <= to + 1e-9; t += step) acc += listenedSeconds(t, t + step, true);
		return acc;
	};
	it("counts small forward steps while playing only", () => {
		expect(listenedSeconds(10, 10.25, true)).toBeCloseTo(0.25);
		expect(listenedSeconds(10, 10.25, false)).toBe(0);
	});
	it("a restore (0 -> 40 s jump) adds nothing", () => {
		expect(listenedSeconds(0, 40, false)).toBe(0);
		expect(listenedSeconds(0, 40, true)).toBe(0);
	});
	it("restored at 40 s then 30 s listened reaches the threshold", () => {
		expect(listen(40, 70)).toBeGreaterThanOrEqual(historyThreshold(240) - 1e-6);
		expect(listen(40, 60)).toBeLessThan(historyThreshold(240));
	});
	it("seeks (back or far forward) add nothing", () => {
		expect(listenedSeconds(120, 30, true)).toBe(0);
		expect(listenedSeconds(30, 120, true)).toBe(0);
	});
});
