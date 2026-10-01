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
	_setVolumeReadOnlyForTest,
	albumEndIndex,
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
	sleepRemaining,
	sleepTracksLeft,
	startSleepTimer,
	stopsAt,
} from "./sleepTimer";

const A = (id: string) => ({ videoId: id, album: { browseId: "MPREb_A", title: "Discovery" } });
const B = (id: string) => ({ videoId: id, album: { browseId: "MPREb_B", title: "Homework" } });

describe("sleepDeadline", () => {
	const now = 1_000_000;
	it("minutes: a wall-clock deadline", () => {
		expect(sleepDeadline({ minutes: 15 }, { now, position: 2 })).toEqual({ at: "time", endsAt: now + 15 * 60_000 });
	});
	it("track: stop after the current index", () => {
		expect(sleepDeadline("track", { now, position: 4 })).toEqual({ at: "trackEnd", stopAfter: 4 });
	});
	it("tracks: the current track is the first of N", () => {
		expect(sleepDeadline({ tracks: 3 }, { now, position: 4 })).toEqual({ at: "trackEnd", stopAfter: 6 });
		expect(sleepDeadline({ tracks: 0 }, { now, position: 4 })).toEqual({ at: "trackEnd", stopAfter: 4 });
	});
	it("album: last consecutive row of the current album", () => {
		const mix = [B("b0"), A("a1"), A("a2"), A("a3"), B("b4"), A("a5")];
		expect(sleepDeadline("album", { now, position: 1, mix })).toEqual({ at: "trackEnd", stopAfter: 3 });
		expect(sleepDeadline("album", { now, position: 3, mix })).toEqual({ at: "trackEnd", stopAfter: 3 });
		expect(sleepDeadline("album", { now, position: 0, mix })).toEqual({ at: "trackEnd", stopAfter: 0 });
	});
});

describe("albumEndIndex", () => {
	it("album queue: the playback context's ids set the boundary", () => {
		const mix = [{ videoId: "a1" }, { videoId: "a2" }, { videoId: "a3" }, { videoId: "x9" }];
		const context = { kind: "album", ids: ["a1", "a2", "a3"] };
		expect(albumEndIndex({ position: 0, mix, context })).toBe(2);
		// a track outside the context ("Lire ensuite") falls back to its own album
		expect(albumEndIndex({ position: 3, mix, context })).toBe(3);
	});
	it("matches by album title when there is no browseId (slimmed offline rows)", () => {
		const mix = [
			{ videoId: "1", album: { text: "Moon Safari" } },
			{ videoId: "2", album: { title: "moon safari" } },
			{ videoId: "3", album: { text: "Talkie Walkie" } },
		];
		expect(albumEndIndex({ position: 0, mix })).toBe(1);
	});
	it("no album info: the current track", () => {
		expect(albumEndIndex({ position: 1, mix: [{ videoId: "1" }, { videoId: "2" }, { videoId: "3" }] })).toBe(1);
		expect(albumEndIndex({ position: 5, mix: [] })).toBe(5);
	});
});

describe("extendDeadline (+10 min)", () => {
	it("pushes a running minute deadline back", () => {
		expect(extendDeadline({ at: "time", endsAt: 5_000_000 }, 10, 1_000_000)).toEqual({ at: "time", endsAt: 5_600_000 });
	});
	it("counts from now when the deadline passed, or replaces a track-end mode", () => {
		expect(extendDeadline({ at: "time", endsAt: 500 }, 10, 1_000)).toEqual({ at: "time", endsAt: 601_000 });
		expect(extendDeadline({ at: "trackEnd", stopAfter: 3 }, 10, 1_000)).toEqual({ at: "time", endsAt: 601_000 });
		expect(extendDeadline(null, 10, 1_000)).toEqual({ at: "time", endsAt: 601_000 });
	});
});

describe("stopsAt", () => {
	it("stops once the position reaches the stop index", () => {
		const d = { at: "trackEnd", stopAfter: 6 } as const;
		expect(stopsAt(d, 4)).toBe(false);
		expect(stopsAt(d, 6)).toBe(true);
		expect(stopsAt(d, 7)).toBe(true);
		expect(stopsAt({ at: "time", endsAt: 0 }, 9)).toBe(false);
		expect(stopsAt(null, 9)).toBe(false);
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
		expect(shouldStopAtTrackEnd(3)).toBe(false);
		expect(get(sleepLabel)).toBe("1 titre");
		expect(shouldStopAtTrackEnd(4)).toBe(true);
	});

	it("'Fin de l'album' stops after the album's last queued track", () => {
		startSleepTimer("album", { position: 1, mix: [B("b0"), A("a1"), A("a2"), B("b3")] });
		expect(get(sleepLabel)).toBe("Fin de l'album");
		expect(shouldStopAtTrackEnd(1)).toBe(false);
		expect(shouldStopAtTrackEnd(2)).toBe(true);
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
