import { beforeEach, describe, expect, it, vi } from "vitest";

// Sleep-timer fade (G11): the 30 fade steps must not persist the volume; only
// the restore at the end goes through setVolume() (the store behind
// localStorage.volume), and with the level that was active before the fade.

vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$lib/utils", () => ({ notify: vi.fn() }));

const player = vi.hoisted(() => {
	const storage = new Map<string, string>();
	const paused = { value: false, subscribe: (run: (v: boolean) => void) => (run(paused.value), () => {}) };
	const volume = { value: 0.8 };
	const element = { volume: 0.8 };
	const AudioPlayer = {
		volume,
		paused,
		fadeTo: vi.fn((v: number) => {
			element.volume = v;
		}),
		setVolume: vi.fn((v: number) => {
			volume.value = v;
			element.volume = v;
			storage.set("volume", String(v)); // what the real store subscription does
		}),
		pause: vi.fn(() => {
			paused.value = true;
		}),
	};
	return { AudioPlayer, storage, element };
});
vi.mock("$lib/player", () => ({ AudioPlayer: player.AudioPlayer }));

import { cancelSleepTimer, sleepFading, sleepMode, startSleepTimer } from "./sleepTimer";
import { get } from "svelte/store";

beforeEach(() => {
	vi.useFakeTimers();
	player.storage.clear();
	player.storage.set("volume", "0.8");
	player.AudioPlayer.volume.value = 0.8;
	player.element.volume = 0.8;
	player.AudioPlayer.paused.value = false;
	player.AudioPlayer.fadeTo.mockClear();
	player.AudioPlayer.setVolume.mockClear();
	player.AudioPlayer.pause.mockClear();
});

describe("sleep timer fade", () => {
	it("fades on the element only and leaves localStorage.volume untouched", async () => {
		startSleepTimer(15);
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 50);
		expect(get(sleepFading)).toBe(true);
		await vi.advanceTimersByTimeAsync(3_500);
		expect(player.AudioPlayer.pause).toHaveBeenCalledTimes(1);
		expect(player.AudioPlayer.fadeTo.mock.calls.length).toBeGreaterThanOrEqual(30);
		// The only persisted write is the restore, with the previous level.
		expect(player.AudioPlayer.setVolume.mock.calls).toEqual([[0.8]]);
		expect(player.storage.get("volume")).toBe("0.8");
		expect(player.element.volume).toBe(0.8);
		expect(get(sleepMode)).toBeNull();
		expect(get(sleepFading)).toBe(false);
	});

	it("restores the previous level when cancelled mid-fade, without persisting the fade", async () => {
		startSleepTimer(15);
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_200);
		expect(player.element.volume).toBeLessThan(0.8);
		cancelSleepTimer(true);
		await vi.advanceTimersByTimeAsync(200);
		expect(player.AudioPlayer.pause).not.toHaveBeenCalled();
		expect(player.AudioPlayer.setVolume.mock.calls).toEqual([[0.8]]);
		expect(player.element.volume).toBe(0.8);
		expect(player.storage.get("volume")).toBe("0.8");
	});
});
