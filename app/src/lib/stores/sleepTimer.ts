// Sleep timer (brainstorm P4, c39c B6-9): stop playback after N minutes, at
// the end of the current track, after N tracks or at the end of the album.
// Module-level stores so the countdown survives route changes; nothing here
// touches `window` at import time (SSR safe).
//
// - Minute modes: 1 s tick. On expiry the AudioPlayer volume is faded linearly
//   to 0 over FADE_MS, then `pause()` and the previous volume is restored.
//   Where the media volume is read-only (iPhone / iPad: iOS ignores a
//   programmatic `volume`), there is no fade: a 5 s visual countdown
//   (`sleepCountdown`, toast in SleepTimerSheet) runs before the deadline and
//   playback pauses exactly at it.
// - Track-end modes ("track", "album", "tracks"): `sleepDeadline()` fixes the
//   queue index after which playback stops; player.ts asks
//   `shouldStopAtTrackEnd(position)` on its end-of-track path and calls
//   `trackEnded()` after pausing (the auto-advance is skipped for that one
//   track only; repeat / shuffle semantics are untouched).
// - "+10 min" (`extendSleepTimer`) pushes a minute deadline back, or starts a
//   10 min timer when none (or a track-end one) is running.
//
// The player module is imported lazily (dynamic import) to keep this store
// free of an import cycle with `$lib/player`.
import { browser } from "$app/environment";
import { notify } from "$lib/utils";
import { derived, get, writable } from "svelte/store";

/** Minutes (15 / 30 / 45 / 60, or any length after "+10 min"), or a track-end mode. */
export type SleepMode = number | "track" | "album" | "tracks";

export const SLEEP_MINUTE_OPTIONS: ReadonlyArray<15 | 30 | 45 | 60> = [15, 30, 45, 60];
/** "Dans 3 titres". */
export const SLEEP_TRACK_COUNT = 3;
/** "+10 min". */
export const SLEEP_EXTEND_MIN = 10;
/** Seconds of visual countdown before a fade-less pause. */
export const SLEEP_COUNTDOWN_S = 5;

const FADE_MS = 3000;
const FADE_STEPS = 30;

/** Active mode, `null` when no timer is running. */
export const sleepMode = writable<SleepMode | null>(null);
/** Seconds left (minute modes only; 0 in track-end modes / idle). */
export const sleepRemaining = writable<number>(0);
/** True while the 3 s fade-out is running. */
export const sleepFading = writable<boolean>(false);
/** Seconds before a fade-less pause (read-only volume), `null` otherwise. */
export const sleepCountdown = writable<number | null>(null);
/** Tracks still to play in "tracks" mode (the current one included). */
export const sleepTracksLeft = writable<number>(0);

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

/** Short French label for chips: "23 min", "45 s", "Fin du morceau", "" when idle. */
export const sleepLabel = derived(
	[sleepMode, sleepRemaining, sleepFading, sleepTracksLeft],
	([$mode, $remaining, $fading, $tracks]) => {
		if ($fading) return "Fondu…";
		if ($mode === null) return "";
		if ($mode === "track") return "Fin du morceau";
		if ($mode === "album") return "Fin de l'album";
		if ($mode === "tracks") return `${$tracks} ${plural($tracks, "titre", "titres")}`;
		if ($remaining >= 60) return `${Math.ceil($remaining / 60)} min`;
		return `${Math.max(0, $remaining)} s`;
	},
);

export function modeLabel(mode: SleepMode): string {
	if (mode === "track") return "À la fin du morceau";
	if (mode === "album") return "Fin de l'album";
	if (mode === "tracks") return `Dans ${SLEEP_TRACK_COUNT} titres`;
	return `Dans ${mode} min`;
}

// ---------------------------------------------------------------------------
// Pure deadline computation (vitest: sleepTimer.deadline.test.ts)

type QueueRow = { videoId?: unknown; album?: unknown } | null | undefined;
export interface SleepQueueState {
	/** Date.now() at the start. */
	now: number;
	/** Current queue index. */
	position: number;
	mix?: ReadonlyArray<QueueRow>;
	/** Playback context (album queue: `kind: "album"` + source ids). */
	context?: { kind?: unknown; ids?: unknown } | null;
}
export type SleepKind =
	| { minutes: number }
	| { tracks: number }
	| "track"
	| "album";
export type SleepDeadline =
	| { at: "time"; endsAt: number }
	| { at: "trackEnd"; stopAfter: number };

function albumKey(row: QueueRow): string {
	const al = row && row.album && typeof row.album === "object" ? (row.album as Record<string, unknown>) : null;
	if (!al) return "";
	const id = typeof al.browseId === "string" ? al.browseId.trim() : "";
	if (id) return `id:${id}`;
	const t = typeof al.title === "string" ? al.title : typeof al.text === "string" ? al.text : "";
	return t.trim() ? `t:${t.trim().toLowerCase()}` : "";
}

/**
 * Last queue index of the album the current track belongs to: the run of
 * consecutive rows from `position` that are in the album queue's source list
 * (playback context "album"), or that share the current row's album. The
 * current index when neither tells (stop at the end of this track).
 */
export function albumEndIndex(state: Pick<SleepQueueState, "position" | "mix" | "context">): number {
	const mix = Array.isArray(state.mix) ? state.mix : [];
	const p = Math.max(0, Math.floor(Number(state.position) || 0));
	const cur = mix[p];
	if (!cur) return p;
	const ctx = state.context;
	const vid = (r: QueueRow) => (r && typeof r.videoId === "string" ? r.videoId : "");
	let belongs: ((r: QueueRow) => boolean) | null = null;
	if (ctx && ctx.kind === "album" && Array.isArray(ctx.ids)) {
		const ids = new Set((ctx.ids as unknown[]).filter((x): x is string => typeof x === "string" && x !== ""));
		if (ids.has(vid(cur))) belongs = (r) => ids.has(vid(r));
	}
	if (!belongs) {
		const key = albumKey(cur);
		if (key) belongs = (r) => albumKey(r) === key;
	}
	if (!belongs) return p;
	let end = p;
	while (end + 1 < mix.length && belongs(mix[end + 1])) end++;
	return end;
}

/** When a timer of `kind`, started in `state`, stops playback. */
export function sleepDeadline(kind: SleepKind, state: SleepQueueState): SleepDeadline {
	const p = Math.max(0, Math.floor(Number(state.position) || 0));
	if (kind === "track") return { at: "trackEnd", stopAfter: p };
	if (kind === "album") return { at: "trackEnd", stopAfter: albumEndIndex({ ...state, position: p }) };
	if ("tracks" in kind) {
		const n = Math.max(1, Math.floor(Number(kind.tracks) || 1));
		return { at: "trackEnd", stopAfter: p + n - 1 };
	}
	const m = Math.max(0, Number(kind.minutes) || 0);
	return { at: "time", endsAt: state.now + m * 60_000 };
}

/**
 * "+10 min": a running minute deadline moves back by `minutes` (from now if
 * it already passed); otherwise (idle or track-end mode) a fresh minute timer.
 */
export function extendDeadline(current: SleepDeadline | null, minutes: number, now: number): SleepDeadline {
	const add = Math.max(0, Number(minutes) || 0) * 60_000;
	if (current && current.at === "time") return { at: "time", endsAt: Math.max(current.endsAt, now) + add };
	return { at: "time", endsAt: now + add };
}

/** Track-end check: playback stops when the track at `position` ends. */
export function stopsAt(deadline: SleepDeadline | null, position: number): boolean {
	if (!deadline || deadline.at !== "trackEnd") return false;
	return (Number(position) || 0) >= deadline.stopAfter;
}

/**
 * iOS ignores a programmatic media volume (it stays at 1). `ua` tells the
 * iPhone / iPad apart (iPadOS reports "Macintosh" with touch points); `probe`
 * writes 0.5 to a scratch media element and reads it back.
 */
export function detectVolumeReadOnly(
	ua: string,
	maxTouchPoints: number,
	probe?: (() => { volume: number }) | null,
): boolean {
	if (/iPad|iPhone|iPod/.test(ua)) return true;
	if (/Macintosh/.test(ua) && maxTouchPoints > 1) return true;
	if (!probe) return false;
	try {
		const el = probe();
		el.volume = 0.5;
		return Math.abs(el.volume - 0.5) > 0.01;
	} catch {
		return true;
	}
}

let readOnlyCache: boolean | null = null;
/** Cached detectVolumeReadOnly() for this browser (false outside a browser). */
export function volumeIsReadOnly(): boolean {
	if (readOnlyCache !== null) return readOnlyCache;
	if (!browser || typeof navigator === "undefined") return false;
	readOnlyCache = detectVolumeReadOnly(
		navigator.userAgent || "",
		navigator.maxTouchPoints || 0,
		typeof Audio === "function" ? () => new Audio() : null,
	);
	return readOnlyCache;
}

// ---------------------------------------------------------------------------
// Runtime

let interval: ReturnType<typeof setInterval> | null = null;
let deadline: SleepDeadline | null = null;
let fadeToken = 0;

function clearTick() {
	if (interval) {
		clearInterval(interval);
		interval = null;
	}
}

function tick() {
	if (!deadline || deadline.at !== "time") return clearTick();
	const left = Math.ceil((deadline.endsAt - Date.now()) / 1000);
	if (left <= 0) {
		clearTick();
		sleepRemaining.set(0);
		sleepCountdown.set(null);
		void expire();
		return;
	}
	sleepRemaining.set(left);
	sleepCountdown.set(left <= SLEEP_COUNTDOWN_S && volumeIsReadOnly() ? left : null);
}

function runMinutes(d: SleepDeadline & { at: "time" }, mode: number) {
	clearTick();
	deadline = d;
	sleepMode.set(mode);
	sleepCountdown.set(null);
	sleepRemaining.set(Math.max(0, Math.ceil((d.endsAt - Date.now()) / 1000)));
	interval = setInterval(tick, 1000);
}

/**
 * Start (or restart) the timer. Track-end modes read the queue from `queue`
 * (position, rows, playback context); without it they stop at the end of the
 * current track.
 */
export function startSleepTimer(mode: SleepMode, queue?: Omit<SleepQueueState, "now"> | null) {
	if (!browser) return;
	cancelSleepTimer(true);
	const state: SleepQueueState = { now: Date.now(), position: 0, ...(queue ?? {}) };
	if (mode === "track" || mode === "album" || mode === "tracks") {
		const kind: SleepKind = mode === "tracks" ? { tracks: SLEEP_TRACK_COUNT } : mode;
		deadline = queue ? sleepDeadline(kind, state) : { at: "trackEnd", stopAfter: -1 };
		sleepMode.set(mode);
		sleepRemaining.set(0);
		if (mode === "tracks" && deadline.at === "trackEnd") {
			sleepTracksLeft.set(Math.max(1, deadline.stopAfter - state.position + 1));
		}
		notify(
			mode === "track"
				? "Minuterie : pause à la fin du morceau"
				: mode === "album"
					? "Minuterie : pause à la fin de l'album"
					: `Minuterie : pause dans ${SLEEP_TRACK_COUNT} titres`,
			"success",
		);
		return;
	}
	const d = sleepDeadline({ minutes: mode }, state);
	if (d.at === "time") runMinutes(d, mode);
	notify(`Minuterie : pause dans ${mode} min`, "success");
}

/** "+10 min": extend a minute timer, or start one. */
export function extendSleepTimer(minutes = SLEEP_EXTEND_MIN) {
	if (!browser) return;
	const fading = get(sleepFading);
	const current = fading ? null : deadline;
	if (fading) cancelSleepTimer(true);
	const d = extendDeadline(current, minutes, Date.now());
	if (d.at !== "time") return;
	const prev = get(sleepMode);
	const total = typeof prev === "number" && current?.at === "time" ? prev + minutes : minutes;
	runMinutes(d, total);
	sleepTracksLeft.set(0);
	notify(`Minuterie : pause dans ${Math.ceil((d.endsAt - Date.now()) / 60_000)} min`, "success");
}

/** Cancel a running timer (also aborts a fade in progress and restores volume). */
export function cancelSleepTimer(silent = false) {
	const wasActive = get(sleepMode) !== null || get(sleepFading);
	clearTick();
	deadline = null;
	fadeToken += 1; // aborts an in-flight fade
	sleepMode.set(null);
	sleepRemaining.set(0);
	sleepFading.set(false);
	sleepCountdown.set(null);
	sleepTracksLeft.set(0);
	if (wasActive && !silent) notify("Minuterie de sommeil annulée", "success");
}

/**
 * player.ts end-of-track hook: true when the track at `position` must be the
 * last one. "track" mode stops at the end of whatever track is playing.
 */
export function shouldStopAtTrackEnd(position?: number): boolean {
	const mode = get(sleepMode);
	if (mode === "track") return true;
	if (mode !== "album" && mode !== "tracks") return false;
	if (typeof position !== "number" || !deadline || deadline.at !== "trackEnd") return true;
	if (stopsAt(deadline, position)) return true;
	if (mode === "tracks") sleepTracksLeft.set(Math.max(1, deadline.stopAfter - position));
	return false;
}

/** player.ts calls this once it has paused at the end of the track. */
export function trackEnded() {
	clearTick();
	deadline = null;
	sleepMode.set(null);
	sleepRemaining.set(0);
	sleepTracksLeft.set(0);
	notify("Minuterie de sommeil : lecture en pause", "success");
}

function sleep(ms: number) {
	return new Promise<void>((r) => setTimeout(r, ms));
}

async function expire() {
	const token = ++fadeToken;
	const fade = !volumeIsReadOnly();
	if (fade) sleepFading.set(true);
	try {
		const { AudioPlayer } = await import("$lib/player");
		if (!fade) {
			// Read-only volume (iOS): the countdown toast already ran, pause now.
			if (token !== fadeToken) return;
			AudioPlayer.pause();
			notify("Minuterie de sommeil : lecture en pause", "success");
			return;
		}
		const previous = AudioPlayer.volume.value;
		const playing = !get(AudioPlayer.paused);
		// The fade steps go through fadeTo(): media element only, so the volume
		// store (and localStorage.volume behind it) never records a fading
		// level (G11). The persisted level is written back once, at the end.
		const restore = () => {
			AudioPlayer.fadeTo(previous);
			AudioPlayer.setVolume(previous);
		};
		if (playing && previous > 0) {
			const step = FADE_MS / FADE_STEPS;
			for (let i = 1; i <= FADE_STEPS; i++) {
				await sleep(step);
				if (token !== fadeToken) {
					restore();
					return; // cancelled during the fade
				}
				AudioPlayer.fadeTo(previous * (1 - i / FADE_STEPS));
			}
		}
		if (token !== fadeToken) return;
		AudioPlayer.pause();
		restore();
		notify("Minuterie de sommeil : lecture en pause", "success");
	} catch {
		/* player unavailable: nothing to pause */
	} finally {
		if (token === fadeToken) {
			deadline = null;
			sleepFading.set(false);
			sleepCountdown.set(null);
			sleepMode.set(null);
			sleepRemaining.set(0);
		}
	}
}

/** Test hook: force the read-only volume detection (null = detect again). */
export function _setVolumeReadOnlyForTest(v: boolean | null) {
	readOnlyCache = v;
}

export const sleepTimer = {
	start: startSleepTimer,
	extend: extendSleepTimer,
	cancel: cancelSleepTimer,
	shouldStopAtTrackEnd,
	trackEnded,
	mode: sleepMode,
	remaining: sleepRemaining,
	countdown: sleepCountdown,
	label: sleepLabel,
};

export default sleepTimer;
