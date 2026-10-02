import { describe, expect, it } from "vitest";
import { TRACK_END_MARGIN_S, knownTrackDuration, repeatActionAtTrackEnd, shouldAdvanceAtTrackEnd } from "./trackEnd";

describe("L15-2 repeat rule at the end of a track", () => {
	it("repeat off: advance, whatever the position", () => {
		expect(repeatActionAtTrackEnd("off", 0, 3)).toBe("advance");
		expect(repeatActionAtTrackEnd("off", 2, 3)).toBe("advance");
	});
	it("repeat track: the element loops by itself, the queue holds", () => {
		expect(repeatActionAtTrackEnd("track", 0, 3)).toBe("hold");
		expect(repeatActionAtTrackEnd("track", 2, 3)).toBe("hold");
	});
	it("repeat playlist: advance inside the queue, restart at 0 on the last row (not index 1)", () => {
		expect(repeatActionAtTrackEnd("playlist", 0, 3)).toBe("advance");
		expect(repeatActionAtTrackEnd("playlist", 1, 3)).toBe("advance");
		expect(repeatActionAtTrackEnd("playlist", 2, 3)).toBe("restart");
		expect(repeatActionAtTrackEnd("playlist", 5, 3)).toBe("restart");
		expect(repeatActionAtTrackEnd("playlist", 0, 1)).toBe("restart");
	});
	it("unknown mode or empty queue: advance", () => {
		expect(repeatActionAtTrackEnd(undefined, 0, 3)).toBe("advance");
		expect(repeatActionAtTrackEnd("playlist", 0, 0)).toBe("advance");
		expect(repeatActionAtTrackEnd("playlist", NaN, NaN)).toBe("advance");
	});
});

describe("c55a end-of-track rule (probe-gap v2: the last second was never played)", () => {
	it("advances on `ended`, whatever the position or the duration", () => {
		expect(shouldAdvanceAtTrackEnd({ currentTime: 0, duration: 0, ended: true })).toBe(true);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 12, duration: NaN, ended: true })).toBe(true);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 200, duration: 200, ended: true })).toBe(true);
	});

	it("plays the last second: duration - 1.0 s (the old rule) does not advance", () => {
		expect(shouldAdvanceAtTrackEnd({ currentTime: 199.0, duration: 200 })).toBe(false);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 199.05, duration: 200 })).toBe(false);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 199.5, duration: 200 })).toBe(false);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 199.8, duration: 200 })).toBe(false);
	});

	it("advances from duration - 0.15 s on a timeupdate", () => {
		expect(TRACK_END_MARGIN_S).toBe(0.15);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 200 - TRACK_END_MARGIN_S, duration: 200 })).toBe(true);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 199.9, duration: 200 })).toBe(true);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 200, duration: 200 })).toBe(true);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 200.4, duration: 200 })).toBe(true);
	});

	it("never advances from timeupdate against an unknown duration (source swap, cached source)", () => {
		expect(shouldAdvanceAtTrackEnd({ currentTime: 5, duration: 0 })).toBe(false);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 5, duration: NaN })).toBe(false);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 5, duration: Infinity })).toBe(false);
		expect(shouldAdvanceAtTrackEnd({ currentTime: 5, duration: -1 })).toBe(false);
		expect(shouldAdvanceAtTrackEnd({ currentTime: NaN, duration: 200 })).toBe(false);
		expect(shouldAdvanceAtTrackEnd(null)).toBe(false);
		expect(shouldAdvanceAtTrackEnd(undefined)).toBe(false);
	});

	it("measures against the media's own duration when known, else the declared one", () => {
		expect(knownTrackDuration(180, 181.4)).toBe(181.4);
		expect(knownTrackDuration(180, NaN)).toBe(180);
		expect(knownTrackDuration(180, Infinity)).toBe(180);
		expect(knownTrackDuration(180, 0)).toBe(180);
		expect(knownTrackDuration(0, 0)).toBe(0);
		expect(knownTrackDuration(undefined, undefined)).toBe(0);
		expect(knownTrackDuration(NaN, -3)).toBe(0);
	});
});
