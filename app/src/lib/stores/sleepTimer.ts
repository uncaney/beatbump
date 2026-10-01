// Sleep timer (brainstorm P4): stop playback after N minutes or at the end of
// the current track. Module-level stores so the countdown survives route
// changes; nothing here touches `window` at import time (SSR safe).
//
// - Minute modes: 1 s tick; on expiry the AudioPlayer volume is faded linearly
//   to 0 over FADE_MS, then `pause()` and the previous volume is restored.
// - "track" mode: player.ts asks `shouldStopAtTrackEnd()` on its end-of-track
//   path and calls `trackEnded()` after pausing (the auto-advance is skipped
//   for that one track only; repeat / shuffle semantics are untouched).
//
// The player module is imported lazily (dynamic import) to keep this store
// free of an import cycle with `$lib/player`.
import { browser } from "$app/environment";
import { notify } from "$lib/utils";
import { derived, get, writable } from "svelte/store";

export type SleepMode = 15 | 30 | 45 | 60 | "track";

export const SLEEP_MINUTE_OPTIONS: ReadonlyArray<15 | 30 | 45 | 60> = [15, 30, 45, 60];

const FADE_MS = 3000;
const FADE_STEPS = 30;

/** Active mode, `null` when no timer is running. */
export const sleepMode = writable<SleepMode | null>(null);
/** Seconds left (minute modes only; 0 in "track" mode / idle). */
export const sleepRemaining = writable<number>(0);
/** True while the 3 s fade-out is running. */
export const sleepFading = writable<boolean>(false);

/** Short French label for chips: "23 min", "45 s", "Fin du morceau", "" when idle. */
export const sleepLabel = derived(
	[sleepMode, sleepRemaining, sleepFading],
	([$mode, $remaining, $fading]) => {
		if ($fading) return "Fondu…";
		if ($mode === null) return "";
		if ($mode === "track") return "Fin du morceau";
		if ($remaining >= 60) return `${Math.ceil($remaining / 60)} min`;
		return `${Math.max(0, $remaining)} s`;
	},
);

export function modeLabel(mode: SleepMode): string {
	return mode === "track" ? "À la fin du morceau" : `Dans ${mode} min`;
}

let interval: ReturnType<typeof setInterval> | null = null;
let endsAt = 0;
let fadeToken = 0;

function clearTick() {
	if (interval) {
		clearInterval(interval);
		interval = null;
	}
}

function tick() {
	const left = Math.ceil((endsAt - Date.now()) / 1000);
	if (left <= 0) {
		clearTick();
		sleepRemaining.set(0);
		void expire();
		return;
	}
	sleepRemaining.set(left);
}

/** Start (or restart) the timer. */
export function startSleepTimer(mode: SleepMode) {
	if (!browser) return;
	cancelSleepTimer(true);
	sleepMode.set(mode);
	if (mode === "track") {
		sleepRemaining.set(0);
		notify("Minuterie : pause à la fin du morceau", "success");
		return;
	}
	endsAt = Date.now() + mode * 60_000;
	sleepRemaining.set(mode * 60);
	interval = setInterval(tick, 1000);
	notify(`Minuterie : pause dans ${mode} min`, "success");
}

/** Cancel a running timer (also aborts a fade in progress and restores volume). */
export function cancelSleepTimer(silent = false) {
	const wasActive = get(sleepMode) !== null || get(sleepFading);
	clearTick();
	fadeToken += 1; // aborts an in-flight fade
	sleepMode.set(null);
	sleepRemaining.set(0);
	sleepFading.set(false);
	if (wasActive && !silent) notify("Minuterie de sommeil annulée", "success");
}

/** player.ts end-of-track hook: true when the current track must be the last one. */
export function shouldStopAtTrackEnd(): boolean {
	return get(sleepMode) === "track";
}

/** player.ts calls this once it has paused at the end of the track. */
export function trackEnded() {
	clearTick();
	sleepMode.set(null);
	sleepRemaining.set(0);
	notify("Minuterie de sommeil : lecture en pause", "success");
}

function sleep(ms: number) {
	return new Promise<void>((r) => setTimeout(r, ms));
}

async function expire() {
	const token = ++fadeToken;
	sleepFading.set(true);
	try {
		const { AudioPlayer } = await import("$lib/player");
		const previous = AudioPlayer.volume.value;
		const playing = !get(AudioPlayer.paused);
		if (playing && previous > 0) {
			const step = FADE_MS / FADE_STEPS;
			for (let i = 1; i <= FADE_STEPS; i++) {
				await sleep(step);
				if (token !== fadeToken) {
					AudioPlayer.setVolume(previous);
					return; // cancelled during the fade
				}
				AudioPlayer.setVolume(previous * (1 - i / FADE_STEPS));
			}
		}
		if (token !== fadeToken) return;
		AudioPlayer.pause();
		AudioPlayer.setVolume(previous);
		notify("Minuterie de sommeil : lecture en pause", "success");
	} catch {
		/* player unavailable: nothing to pause */
	} finally {
		if (token === fadeToken) {
			sleepFading.set(false);
			sleepMode.set(null);
			sleepRemaining.set(0);
		}
	}
}

export const sleepTimer = {
	start: startSleepTimer,
	cancel: cancelSleepTimer,
	shouldStopAtTrackEnd,
	trackEnded,
	mode: sleepMode,
	remaining: sleepRemaining,
	label: sleepLabel,
};

export default sleepTimer;
