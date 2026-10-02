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
// - Track-end modes ("track", "album", "tracks"): player.ts asks
//   `shouldStopAtTrackEnd(position, queue)` on its end-of-track path and calls
//   `trackEnded()` after pausing (the auto-advance is skipped for that one
//   track only; repeat / shuffle semantics are untouched). "tracks" counts
//   track ends and (L13-3) user "next" presses (`sleepTrackSkipped()` from
//   player.ts `skipNext`), "album" stops when the next row leaves the
//   starting album (L12-1); player.ts forwards queue changes to
//   `sleepQueueChanged()`, which cancels an "album" timer (with a toast)
//   once another album plays.
// - "+10 min" (`extendSleepTimer`) pushes a minute deadline back, or starts a
//   10 min timer when none (or a track-end one) is running.
// - L12-16: the deadline is absolute (`Date.now()`); the 1 s interval only
//   drives the countdown. A background tab throttles that interval and a
//   locked iPhone suspends it, so player.ts also calls `sleepTimeUpdate()`
//   from the media element's `timeupdate` (which keeps firing while audio
//   plays) and the store re-checks on `visibilitychange`.
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
//
// L12-1 (audit logic v12): track-end modes no longer freeze a queue INDEX at
// the start (wrong as soon as the queue is replaced, shuffled or gets a
// "Lire ensuite" row). "tracks" counts track ENDS; "album" remembers the
// album of the track playing at the start and stops at the end of a track
// whose NEXT row is from another album (or when the queue ends).

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
	/** Stop at the end of whatever track is playing. */
	| { at: "trackEnd"; mode: "track" }
	/** `left` track ends to go (the current track counts as one). */
	| { at: "trackEnd"; mode: "tracks"; left: number; lastEnd: string; lastAt: number }
	/** Album of the starting track: `key` (albumKey) and/or the album context ids. */
	| { at: "trackEnd"; mode: "album"; key: string; ids: string[] };

/** Same track end reported twice within this window counts once. */
export const TRACK_END_DEDUPE_MS = 5000;

const rowVid = (r: QueueRow) => (r && typeof r.videoId === "string" ? r.videoId : "");

export function albumKey(row: QueueRow): string {
	const al = row && row.album && typeof row.album === "object" ? (row.album as Record<string, unknown>) : null;
	if (!al) return "";
	const id = typeof al.browseId === "string" ? al.browseId.trim() : "";
	if (id) return `id:${id}`;
	const t = typeof al.title === "string" ? al.title : typeof al.text === "string" ? al.text : "";
	return t.trim() ? `t:${t.trim().toLowerCase()}` : "";
}

function clampPos(position: unknown): number {
	return Math.max(0, Math.floor(Number(position) || 0));
}

/** True when `row` belongs to the album an "album" deadline remembers. */
export function inSleepAlbum(d: { key: string; ids: string[] }, row: QueueRow): boolean {
	if (!row) return false;
	const vid = rowVid(row);
	if (vid && d.ids.includes(vid)) return true;
	return d.key !== "" && albumKey(row) === d.key;
}

/** When a timer of `kind`, started in `state`, stops playback. */
export function sleepDeadline(kind: SleepKind, state: SleepQueueState): SleepDeadline {
	if (kind === "track") return { at: "trackEnd", mode: "track" };
	if (kind === "album") {
		const mix = Array.isArray(state.mix) ? state.mix : [];
		const cur = mix[clampPos(state.position)];
		const ctx = state.context;
		let ids: string[] = [];
		if (cur && ctx && ctx.kind === "album" && Array.isArray(ctx.ids)) {
			const all = (ctx.ids as unknown[]).filter((x): x is string => typeof x === "string" && x !== "");
			if (all.includes(rowVid(cur))) ids = all;
		}
		const key = albumKey(cur);
		// No album information at all: behave like "end of this track".
		if (!key && ids.length === 0) return { at: "trackEnd", mode: "track" };
		return { at: "trackEnd", mode: "album", key, ids };
	}
	if ("tracks" in kind) {
		const n = Math.max(1, Math.floor(Number(kind.tracks) || 1));
		return { at: "trackEnd", mode: "tracks", left: n, lastEnd: "", lastAt: 0 };
	}
	const m = Math.max(0, Number(kind.minutes) || 0);
	return { at: "time", endsAt: state.now + m * 60_000 };
}

export interface TrackEndEvent {
	position: number;
	mix?: ReadonlyArray<QueueRow>;
	now: number;
	/** L13-3: a user "next" on that track (a distinct action: never deduped against an end). */
	skip?: boolean;
}

/**
 * A track just ended at `ev.position`: stop now, or the updated deadline.
 * - "tracks": one end consumed (the same position + track reported again
 *   within TRACK_END_DEDUPE_MS is the same end, not a new one); L13-3: a
 *   user "next" (`ev.skip`) consumes one too ("Dans 3 titres" then two
 *   skips = one title left);
 * - "album": stop when the next row is missing or from another album.
 */
export function trackEndStep(d: SleepDeadline | null, ev: TrackEndEvent): { stop: boolean; next: SleepDeadline | null } {
	if (!d || d.at !== "trackEnd") return { stop: false, next: d };
	if (d.mode === "track") return { stop: true, next: null };
	const mix = Array.isArray(ev.mix) ? ev.mix : [];
	const p = clampPos(ev.position);
	if (d.mode === "tracks") {
		const endKey = `${p}:${rowVid(mix[p])}`;
		if (!ev.skip && endKey === d.lastEnd && ev.now - d.lastAt < TRACK_END_DEDUPE_MS) return { stop: false, next: d };
		if (d.left <= 1) return { stop: true, next: null };
		return { stop: false, next: { ...d, left: d.left - 1, lastEnd: endKey, lastAt: ev.now } };
	}
	if (!Array.isArray(ev.mix)) return { stop: true, next: null };
	const nxt = mix[p + 1];
	if (!nxt || !inSleepAlbum(d, nxt)) return { stop: true, next: null };
	return { stop: false, next: d };
}

/**
 * The queue changed (replaced, shuffled, "Lire ensuite", jump): "keep" the
 * deadline or "cancel" it. Counters ("tracks") do not depend on the queue;
 * an "album" timer is cancelled once the row playing is from another album
 * (a row without any album information is not taken as "another album").
 */
export function sleepQueueAction(
	d: SleepDeadline | null,
	state: Pick<SleepQueueState, "position" | "mix">,
): "keep" | "cancel" {
	if (!d || d.at !== "trackEnd" || d.mode !== "album") return "keep";
	const mix = Array.isArray(state.mix) ? state.mix : [];
	const cur = mix[clampPos(state.position)];
	if (!cur) return "keep";
	if (inSleepAlbum(d, cur)) return "keep";
	if (!albumKey(cur)) return "keep";
	return "cancel";
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
let onVisible: (() => void) | null = null;

function clearTick() {
	if (interval) {
		clearInterval(interval);
		interval = null;
	}
	if (onVisible && typeof document !== "undefined") {
		document.removeEventListener("visibilitychange", onVisible);
	}
	onVisible = null;
}

/** L12-16: a tab coming back to the foreground re-checks the deadline at once. */
function watchVisibility() {
	if (onVisible || typeof document === "undefined") return;
	onVisible = () => {
		if (!document.hidden) sleepTimeUpdate();
	};
	document.addEventListener("visibilitychange", onVisible);
}

function tick() {
	if (!deadline || deadline.at !== "time") return clearTick();
	const left = Math.ceil((deadline.endsAt - Date.now()) / 1000);
	if (left <= 0) {
		clearTick();
		// The deadline is consumed here: a late interval tick, a timeupdate or
		// a visibility change arriving during the fade must not expire twice.
		deadline = null;
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
	watchVisibility();
}

/**
 * L12-16: player.ts calls this from the media element's `timeupdate`. The
 * 1 s interval is throttled by a background tab and suspended by a locked
 * iPhone while the deadline is absolute (`Date.now()`); re-checking it on
 * every `timeupdate` (about 4 a second while audio plays, screen locked
 * included) lands the pause on time even when no interval tick ran. Cheap
 * when idle or in a track-end mode.
 */
export function sleepTimeUpdate() {
	if (!deadline || deadline.at !== "time") return;
	tick();
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
		deadline = queue || kind !== "album" ? sleepDeadline(kind, state) : { at: "trackEnd", mode: "track" };
		sleepMode.set(mode);
		sleepRemaining.set(0);
		if (deadline.at === "trackEnd" && deadline.mode === "tracks") sleepTracksLeft.set(deadline.left);
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
 * last one. "track" mode stops at the end of whatever track is playing;
 * "tracks" consumes one track end; "album" looks at the next row of `queue`.
 */
export function shouldStopAtTrackEnd(
	position?: number,
	queue?: { mix?: ReadonlyArray<QueueRow> } | null,
): boolean {
	const mode = get(sleepMode);
	if (mode === "track") return true;
	if (mode !== "album" && mode !== "tracks") return false;
	if (typeof position !== "number" || !deadline || deadline.at !== "trackEnd") return true;
	const step = trackEndStep(deadline, { position, mix: queue?.mix, now: Date.now() });
	if (step.stop) return true;
	deadline = step.next;
	if (deadline && deadline.at === "trackEnd" && deadline.mode === "tracks") sleepTracksLeft.set(deadline.left);
	return false;
}

/**
 * L13-3: player.ts `skipNext` hook, a USER "next" (player / fullscreen
 * buttons, keyboard, lock screen) on the track at `position`. "tracks"
 * counts it as one title consumed, like a track end; true when that was the
 * last counted one: the player then pauses in place instead of advancing
 * (the same hold as the track-end path, `trackEnded()` follows). The other
 * modes wait for the end of a track / the album: false, nothing changes.
 */
export function sleepTrackSkipped(
	position?: number,
	queue?: { mix?: ReadonlyArray<QueueRow> } | null,
): boolean {
	if (get(sleepMode) !== "tracks") return false;
	if (typeof position !== "number" || !deadline || deadline.at !== "trackEnd" || deadline.mode !== "tracks") return false;
	const step = trackEndStep(deadline, { position, mix: queue?.mix, now: Date.now(), skip: true });
	if (step.stop) return true;
	deadline = step.next;
	if (deadline && deadline.at === "trackEnd" && deadline.mode === "tracks") sleepTracksLeft.set(deadline.left);
	return false;
}

/**
 * player.ts forwards every queue update here. An "album" timer whose album
 * no longer plays (queue replaced, other track picked) is cancelled with a
 * toast; "tracks" keeps counting track ends whatever the queue.
 */
export function sleepQueueChanged(state: { position?: unknown; mix?: ReadonlyArray<QueueRow> } | null | undefined) {
	if (!deadline || deadline.at !== "trackEnd" || deadline.mode !== "album" || !state) return;
	if (sleepQueueAction(deadline, { position: Number(state.position) || 0, mix: state.mix }) !== "cancel") return;
	cancelSleepTimer(true);
	notify("Minuterie « Fin de l'album » annulée : un autre album joue", "success");
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
	timeUpdate: sleepTimeUpdate,
	shouldStopAtTrackEnd,
	queueChanged: sleepQueueChanged,
	trackEnded,
	mode: sleepMode,
	remaining: sleepRemaining,
	countdown: sleepCountdown,
	label: sleepLabel,
};

export default sleepTimer;
