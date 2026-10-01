import { beforeEach, describe, expect, it, vi } from "vitest";

// c39c B6-9: pure deadline computation (minutes / track / N tracks / album),
// "+10 min", read-only volume detection, and the runtime track-end and
// fade-less (iOS) paths.

vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$lib/utils", () => ({ notify: vi.fn() }));

const player = vi.hoisted(() => {
	const paused = { value: false, subscribe: (run: (v: boolean) => void) => (run(paused.value), () => {}) };
	const AudioPlayer = {
		volume: { value: 0.8 },
		paused,
		fadeTo: vi.fn(),
		setVolume: vi.fn(),
		pause: vi.fn(() => {
			paused.value = true;
		}),
	};
	return { AudioPlayer };
});
vi.mock("$lib/player", () => ({ AudioPlayer: player.AudioPlayer }));

import { get } from "svelte/store";
import {
	TRACK_END_DEDUPE_MS,
	_setVolumeReadOnlyForTest,
	cancelSleepTimer,
	detectVolumeReadOnly,
	extendDeadline,
	extendSleepTimer,
	shouldStopAtTrackEnd,
	sleepCountdown,
	sleepDeadline,
	sleepFading,
	sleepLabel,
	sleepMode,
	sleepQueueAction,
	sleepQueueChanged,
	sleepRemaining,
	sleepTracksLeft,
	startSleepTimer,
	trackEndStep,
	type SleepDeadline,
} from "./sleepTimer";

const A = (id: string) => ({ videoId: id, album: { browseId: "MPREb_A", title: "Discovery" } });
const B = (id: string) => ({ videoId: id, album: { browseId: "MPREb_B", title: "Homework" } });

describe("sleepDeadline", () => {
	const now = 1_000_000;
	it("minutes: a wall-clock deadline", () => {
		expect(sleepDeadline({ minutes: 15 }, { now, position: 2 })).toEqual({ at: "time", endsAt: now + 15 * 60_000 });
	});
	it("track: stop at the end of the playing track", () => {
		expect(sleepDeadline("track", { now, position: 4 })).toEqual({ at: "trackEnd", mode: "track" });
	});
	it("tracks: a counter of track ends, not a queue index", () => {
		expect(sleepDeadline({ tracks: 3 }, { now, position: 4 })).toEqual({ at: "trackEnd", mode: "tracks", left: 3, lastEnd: "", lastAt: 0 });
		expect(sleepDeadline({ tracks: 0 }, { now, position: 4 })).toMatchObject({ mode: "tracks", left: 1 });
	});
	it("album: remembers the album key (and the album context ids)", () => {
		const mix = [B("b0"), A("a1"), A("a2")];
		expect(sleepDeadline("album", { now, position: 1, mix })).toEqual({ at: "trackEnd", mode: "album", key: "id:MPREb_A", ids: [] });
		const ctx = { kind: "album", ids: ["a1", "a2"] };
		expect(sleepDeadline("album", { now, position: 1, mix, context: ctx })).toMatchObject({ ids: ["a1", "a2"] });
		// a track outside the context keeps its own album only
		expect(sleepDeadline("album", { now, position: 0, mix, context: ctx })).toMatchObject({ key: "id:MPREb_B", ids: [] });
		// no album information: end of this track
		expect(sleepDeadline("album", { now, position: 0, mix: [{ videoId: "1" }] })).toEqual({ at: "trackEnd", mode: "track" });
	});
});

describe("trackEndStep", () => {
	const tracks = (n: number): SleepDeadline => sleepDeadline({ tracks: n }, { now: 0, position: 0 });
	it("'Dans 3 titres' counts ends whatever the queue does (L12-1)", () => {
		let d: SleepDeadline | null = tracks(3);
		// started at index 10 of a 30-track queue
		let r = trackEndStep(d, { position: 10, mix: [], now: 1_000 });
		expect(r.stop).toBe(false);
		d = r.next;
		// the queue is replaced by another album: position 0
		r = trackEndStep(d, { position: 0, mix: [], now: 200_000 });
		expect(r.stop).toBe(false);
		d = r.next;
		expect(d).toMatchObject({ left: 1 });
		r = trackEndStep(d, { position: 1, mix: [], now: 400_000 });
		expect(r).toEqual({ stop: true, next: null });
	});
	it("the same end reported twice counts once", () => {
		const mix = [{ videoId: "x" }];
		const r1 = trackEndStep(tracks(2), { position: 0, mix, now: 1_000 });
		const r2 = trackEndStep(r1.next, { position: 0, mix, now: 1_000 + TRACK_END_DEDUPE_MS - 1 });
		expect(r2).toEqual({ stop: false, next: r1.next });
		// repeat-one: the same track ending again later is a new end
		expect(trackEndStep(r1.next, { position: 0, mix, now: 1_000 + TRACK_END_DEDUPE_MS + 1 }).stop).toBe(true);
	});
	it("'Fin de l'album' stops when the next row leaves the album or the queue ends", () => {
		const d = sleepDeadline("album", { now: 0, position: 0, mix: [A("a0")] });
		const mix = [A("a0"), A("a1"), B("b2")];
		expect(trackEndStep(d, { position: 0, mix, now: 0 }).stop).toBe(false);
		expect(trackEndStep(d, { position: 1, mix, now: 0 }).stop).toBe(true);
		expect(trackEndStep(d, { position: 0, mix: [A("a0")], now: 0 }).stop).toBe(true);
	});
	it("album after a shuffle: the live next row decides, not a stored index", () => {
		const d = sleepDeadline("album", { now: 0, position: 0, mix: [A("a0"), A("a1"), A("a2"), B("b3")] });
		// shuffled after the current index: B row moved up
		expect(trackEndStep(d, { position: 0, mix: [A("a0"), B("b3"), A("a1"), A("a2")], now: 0 }).stop).toBe(true);
		// a whole-album queue shuffled: keeps going until the album runs out
		expect(trackEndStep(d, { position: 0, mix: [A("a0"), A("a2"), A("a1")], now: 0 }).stop).toBe(false);
	});
	it("album context ids: rows without album info still belong", () => {
		const d = sleepDeadline("album", { now: 0, position: 0, mix: [{ videoId: "a1" }], context: { kind: "album", ids: ["a1", "a2"] } });
		const mix = [{ videoId: "a1" }, { videoId: "a2" }, { videoId: "x9" }];
		expect(trackEndStep(d, { position: 0, mix, now: 0 }).stop).toBe(false);
		expect(trackEndStep(d, { position: 1, mix, now: 0 }).stop).toBe(true);
	});
	it("'track' always stops, a minute deadline never does", () => {
		expect(trackEndStep({ at: "trackEnd", mode: "track" }, { position: 3, now: 0 }).stop).toBe(true);
		expect(trackEndStep({ at: "time", endsAt: 0 }, { position: 3, now: 0 }).stop).toBe(false);
		expect(trackEndStep(null, { position: 3, now: 0 }).stop).toBe(false);
	});
});

describe("sleepQueueAction", () => {
	const d = sleepDeadline("album", { now: 0, position: 0, mix: [A("a0")] });
	it("keeps while the album plays, cancels once another album plays", () => {
		expect(sleepQueueAction(d, { position: 4, mix: [B("b"), B("b"), B("b"), B("b"), A("a4")] })).toBe("keep");
		expect(sleepQueueAction(d, { position: 0, mix: [B("b0"), B("b1")] })).toBe("cancel");
	});
	it("rows without album info and counters are kept", () => {
		expect(sleepQueueAction(d, { position: 0, mix: [{ videoId: "z" }] })).toBe("keep");
		expect(sleepQueueAction(d, { position: 0, mix: [] })).toBe("keep");
		expect(sleepQueueAction(sleepDeadline({ tracks: 3 }, { now: 0, position: 0 }), { position: 0, mix: [B("b0")] })).toBe("keep");
	});
});

describe("extendDeadline (+10 min)", () => {
	it("pushes a running minute deadline back", () => {
		expect(extendDeadline({ at: "time", endsAt: 5_000_000 }, 10, 1_000_000)).toEqual({ at: "time", endsAt: 5_600_000 });
	});
	it("counts from now when the deadline passed, or replaces a track-end mode", () => {
		expect(extendDeadline({ at: "time", endsAt: 500 }, 10, 1_000)).toEqual({ at: "time", endsAt: 601_000 });
		expect(extendDeadline({ at: "trackEnd", mode: "track" }, 10, 1_000)).toEqual({ at: "time", endsAt: 601_000 });
		expect(extendDeadline(null, 10, 1_000)).toEqual({ at: "time", endsAt: 601_000 });
	});
});

describe("detectVolumeReadOnly", () => {
	const writable = () => ({ volume: 1 });
	it("iPhone / iPad (and iPadOS desktop UA) are read-only", () => {
		expect(detectVolumeReadOnly("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5, writable)).toBe(true);
		expect(detectVolumeReadOnly("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5, writable)).toBe(true);
	});
	it("desktop: probes the element", () => {
		expect(detectVolumeReadOnly("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0, writable)).toBe(false);
		const stuck = () => {
			const el = { _v: 1 } as { _v: number; volume: number };
			Object.defineProperty(el, "volume", { get: () => 1, set: () => {} });
			return el;
		};
		expect(detectVolumeReadOnly("Mozilla/5.0 (X11; Linux x86_64)", 0, stuck)).toBe(true);
		expect(detectVolumeReadOnly("Mozilla/5.0 (X11; Linux x86_64)", 0, null)).toBe(false);
	});
});

describe("runtime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		cancelSleepTimer(true);
		_setVolumeReadOnlyForTest(false);
		player.AudioPlayer.paused.value = false;
		player.AudioPlayer.pause.mockClear();
		player.AudioPlayer.fadeTo.mockClear();
	});

	it("'Dans 3 titres' stops at the 3rd track end", () => {
		startSleepTimer("tracks", { position: 2, mix: [] });
		expect(get(sleepLabel)).toBe("3 titres");
		expect(shouldStopAtTrackEnd(2)).toBe(false);
		expect(get(sleepTracksLeft)).toBe(2);
		vi.advanceTimersByTime(60_000);
		expect(shouldStopAtTrackEnd(3)).toBe(false);
		expect(get(sleepLabel)).toBe("1 titre");
		vi.advanceTimersByTime(60_000);
		expect(shouldStopAtTrackEnd(4)).toBe(true);
	});

	it("'Dans 3 titres' started at index 10 survives a queue replacement (L12-1)", () => {
		startSleepTimer("tracks", { position: 10, mix: [] });
		expect(shouldStopAtTrackEnd(10)).toBe(false);
		vi.advanceTimersByTime(60_000);
		sleepQueueChanged({ position: 0, mix: [B("b0"), B("b1"), B("b2")] });
		expect(get(sleepMode)).toBe("tracks");
		expect(shouldStopAtTrackEnd(0)).toBe(false);
		vi.advanceTimersByTime(60_000);
		expect(shouldStopAtTrackEnd(1)).toBe(true);
	});

	it("'Fin de l'album' stops after the album's last queued track", () => {
		const mix = [B("b0"), A("a1"), A("a2"), B("b3")];
		startSleepTimer("album", { position: 1, mix });
		expect(get(sleepLabel)).toBe("Fin de l'album");
		expect(shouldStopAtTrackEnd(1, { mix })).toBe(false);
		expect(shouldStopAtTrackEnd(2, { mix })).toBe(true);
	});

	it("'Fin de l'album' is cancelled when another album replaces the queue", () => {
		startSleepTimer("album", { position: 0, mix: [A("a0"), A("a1")] });
		sleepQueueChanged({ position: 0, mix: [A("a0"), A("a1"), A("a2")] });
		expect(get(sleepMode)).toBe("album");
		sleepQueueChanged({ position: 24, mix: Array.from({ length: 30 }, (_, i) => B(`b${i}`)) });
		expect(get(sleepMode)).toBeNull();
		expect(shouldStopAtTrackEnd(24)).toBe(false);
	});

	it("'À la fin du morceau' keeps stopping at whatever track ends", () => {
		startSleepTimer("track", { position: 1, mix: [] });
		expect(shouldStopAtTrackEnd(5)).toBe(true);
	});

	it("+10 min extends a running minute timer", () => {
		startSleepTimer(15);
		extendSleepTimer(10);
		expect(get(sleepMode)).toBe(25);
		expect(get(sleepRemaining)).toBe(25 * 60);
	});

	it("read-only volume: 5 s countdown then a pause at the deadline, no fade", async () => {
		_setVolumeReadOnlyForTest(true);
		startSleepTimer(15);
		await vi.advanceTimersByTimeAsync(15 * 60_000 - 5_000);
		expect(get(sleepCountdown)).toBe(5);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(get(sleepCountdown)).toBe(2);
		expect(player.AudioPlayer.pause).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2_100);
		expect(player.AudioPlayer.pause).toHaveBeenCalledTimes(1);
		expect(player.AudioPlayer.fadeTo).not.toHaveBeenCalled();
		expect(get(sleepFading)).toBe(false);
		expect(get(sleepCountdown)).toBeNull();
		expect(get(sleepMode)).toBeNull();
	});

	it("'Continuer' during the countdown cancels the pause", async () => {
		_setVolumeReadOnlyForTest(true);
		startSleepTimer(15);
		await vi.advanceTimersByTimeAsync(15 * 60_000 - 3_000);
		expect(get(sleepCountdown)).not.toBeNull();
		cancelSleepTimer(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(player.AudioPlayer.pause).not.toHaveBeenCalled();
		expect(get(sleepCountdown)).toBeNull();
	});
});
