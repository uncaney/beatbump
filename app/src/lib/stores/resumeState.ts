/**
 * C1 exact resume: the queue, cursor, mix type, playback position and context
 * (P2) are saved to localStorage every 5 s, on pause and when the page is
 * hidden; at startup (+layout, behind "Remember Last Track") and from the
 * home "Reprendre" button the queue comes back as it was, paused at the
 * saved position, without asking YouTube for a radio (`next.json`), so a
 * local queue also comes back offline.
 *
 * The top half is pure (unit-tested); the runtime half loads the player and
 * the session list lazily so this module stays free of side effects.
 */
import { normalizeContext, type PlaybackContext } from "./list/playbackContext";

export const RESUME_KEY = "resumeState";
/**
 * K8 (audit perf v2): the periodic save used to serialise the whole queue
 * (up to 500 rows, ~100 KB) every 5 s of playback. The queue is now written
 * under RESUME_KEY only when its signature changes; the playback position
 * goes to this small key (RESUME_POS_KEY) every 5 s and is merged back at read.
 */
export const RESUME_POS_KEY = "resumePos";
export const RESUME_VERSION = 1;
export const RESUME_MAX_ITEMS = 500;
export const RESUME_SAVE_INTERVAL_MS = 5000;
/** I7: a saved queue older than this is ignored at restore. */
export const RESUME_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** I7: periodic saves only when the position moved more than this (s). */
export const RESUME_MIN_TIME_DELTA = 2;
/** Rows kept before the cursor when a long queue is cut to RESUME_MAX_ITEMS. */
const RESUME_KEEP_BEFORE = 100;

export type ResumeMixType = "auto" | "playlist" | "local" | null;
type Row = Record<string, any>;

export interface ResumeState {
	v: 1;
	savedAt: number;
	type: ResumeMixType;
	position: number;
	currentTime: number;
	duration: number;
	mix: Row[];
	context: PlaybackContext | null;
	currentMixId: string;
	visitorData: string;
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

// Enough to show the row and play it again (getSrc: videoId / playlistId /
// localUrl); loggingContext, click tracking, menus... are dropped.
const KEEP_KEYS = [
	"videoId",
	"playlistId",
	"title",
	"length",
	"index",
	"album",
	"autoMixList",
	"playerParams",
	"playlistSetVideoId",
	"localUrl",
	"IS_LOCAL",
	"explicit",
	"aspectRatio",
	"musicVideoType",
] as const;

/** A queue row reduced to what the player needs (null when it has no videoId). */
export function slimQueueItem(item: unknown): Row | null {
	if (!item || typeof item !== "object") return null;
	const it = item as Row;
	if (typeof it.videoId !== "string" || !it.videoId) return null;
	const out: Row = {};
	for (const k of KEEP_KEYS) {
		const v = it[k];
		if (v !== undefined && v !== null && typeof v !== "function") out[k] = v;
	}
	if (Array.isArray(it.thumbnails)) {
		out.thumbnails = it.thumbnails
			.filter((t: any) => t && typeof t.url === "string")
			.slice(-2)
			.map((t: any) => ({ url: t.url, width: t.width, height: t.height }));
	}
	const artists = it.artistInfo?.artist;
	if (Array.isArray(artists)) {
		out.artistInfo = {
			artist: artists.slice(0, 3).map((a: any) => ({ text: a?.text, browseId: a?.browseId, pageType: a?.pageType })),
		};
	}
	if (Array.isArray(it.subtitle)) {
		out.subtitle = it.subtitle
			.slice(0, 4)
			.map((s: any) => ({ text: s?.text, browseId: s?.browseId, pageType: s?.pageType }));
	}
	return out;
}

/**
 * PF3-12: the `lastTrack` entry (+layout, Remember Last Track) used to be the
 * whole current track (loggingContext, menus, every thumbnail size: several
 * KB per track change). It is the slim queue row with one thumbnail, the
 * first one, which is the one the home cards read (CarouselItem upsizes it).
 */
export function slimLastTrack(item: unknown): Row | null {
	const out = slimQueueItem(item);
	if (!out) return null;
	const first = Array.isArray((item as Row).thumbnails)
		? (item as Row).thumbnails.find((t: any) => t && typeof t.url === "string")
		: undefined;
	if (first) out.thumbnails = [{ url: first.url, width: first.width, height: first.height }];
	return out;
}

const finite = (n: unknown, fallback = 0) => (typeof n === "number" && isFinite(n) ? n : fallback);
const asType = (t: unknown): ResumeMixType => (t === "auto" || t === "playlist" || t === "local" ? t : null);

/**
 * Snapshot of the session list (+ player time). A queue longer than
 * RESUME_MAX_ITEMS keeps a window around the cursor. null for an empty queue.
 */
export function buildResumeState(
	list: {
		mix: unknown[];
		position: number;
		currentMixType?: unknown;
		context?: PlaybackContext | null;
		currentMixId?: string | null;
		visitorData?: string | null;
	},
	currentTime: number,
	duration: number,
	now = Date.now(),
): ResumeState | null {
	const raw = Array.isArray(list?.mix) ? list.mix : [];
	if (!raw.length) return null;
	let position = Math.min(Math.max(0, finite(list.position) | 0), raw.length - 1);
	let start = 0;
	if (raw.length > RESUME_MAX_ITEMS) {
		start = Math.min(Math.max(0, position - RESUME_KEEP_BEFORE), raw.length - RESUME_MAX_ITEMS);
	}
	const window = raw.slice(start, start + RESUME_MAX_ITEMS);
	position -= start;
	const mix: Row[] = [];
	let cursor = -1;
	window.forEach((item, i) => {
		const slim = slimQueueItem(item);
		if (!slim) return;
		if (i === position) cursor = mix.length;
		mix.push(slim);
	});
	if (!mix.length) return null;
	if (cursor < 0) cursor = Math.min(position, mix.length - 1);
	return {
		v: RESUME_VERSION,
		savedAt: now,
		type: asType(list.currentMixType),
		position: cursor,
		currentTime: Math.max(0, finite(currentTime)),
		duration: Math.max(0, finite(duration)),
		mix,
		context: normalizeContext(list.context ?? null),
		currentMixId: typeof list.currentMixId === "string" ? list.currentMixId : "",
		visitorData: typeof list.visitorData === "string" ? list.visitorData : "",
	};
}

/**
 * Validate a persisted state; null when absent / corrupt / empty, or (I7,
 * when `now` is given) saved more than RESUME_MAX_AGE_MS before `now`.
 */
export function parseResumeState(raw: string | null | undefined, now?: number): ResumeState | null {
	if (!raw) return null;
	let j: any;
	try {
		j = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!j || typeof j !== "object" || j.v !== RESUME_VERSION || !Array.isArray(j.mix)) return null;
	const mix = j.mix
		.slice(0, RESUME_MAX_ITEMS)
		.filter((t: any) => t && typeof t === "object" && typeof t.videoId === "string" && t.videoId);
	if (!mix.length) return null;
	const savedAt = finite(j.savedAt);
	if (typeof now === "number" && savedAt > 0 && now - savedAt > RESUME_MAX_AGE_MS) return null;
	return {
		v: RESUME_VERSION,
		savedAt,
		type: asType(j.type),
		position: Math.min(Math.max(0, finite(j.position) | 0), mix.length - 1),
		currentTime: Math.max(0, finite(j.currentTime)),
		duration: Math.max(0, finite(j.duration)),
		mix,
		context: normalizeContext(j.context),
		currentMixId: typeof j.currentMixId === "string" ? j.currentMixId : "",
		visitorData: typeof j.visitorData === "string" ? j.visitorData : "",
	};
}

/** Where playback resumes: the saved time, or 0 when the track was (nearly) over. */
export function resumeSeekTime(state: Pick<ResumeState, "currentTime" | "duration">): number {
	const t = Math.max(0, finite(state.currentTime));
	const d = finite(state.duration);
	if (d > 0 && t >= d - 3) return 0;
	return t;
}

/**
 * K8: the playback position saved apart from the queue. `base` is the
 * `savedAt` of the full state it belongs to and `videoId` the row under the
 * cursor: a position only applies to the queue it was taken on (a remote
 * restore or a newer full write has another `savedAt`, so a stale position
 * is ignored at read).
 */
export interface ResumePos {
	v: 1;
	base: number;
	videoId: string;
	currentTime: number;
	duration: number;
	savedAt: number;
}

export function parseResumePos(raw: string | null | undefined): ResumePos | null {
	if (!raw) return null;
	let j: any;
	try {
		j = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!j || typeof j !== "object" || j.v !== RESUME_VERSION || typeof j.videoId !== "string" || !j.videoId) return null;
	const base = finite(j.base);
	if (!(base > 0)) return null;
	return {
		v: RESUME_VERSION,
		base,
		videoId: j.videoId,
		currentTime: Math.max(0, finite(j.currentTime)),
		duration: Math.max(0, finite(j.duration)),
		savedAt: finite(j.savedAt),
	};
}

/** K8: `state` with the position of `pos` applied when it belongs to it. */
export function mergeResumePos(state: ResumeState | null, pos: ResumePos | null): ResumeState | null {
	if (!state || !pos) return state;
	if (pos.base !== state.savedAt || pos.savedAt < state.savedAt) return state;
	if (state.mix[state.position]?.videoId !== pos.videoId) return state;
	return { ...state, currentTime: pos.currentTime, duration: pos.duration || state.duration, savedAt: pos.savedAt };
}

/** The position record for `state` at `currentTime` (null for an empty queue). */
export function buildResumePos(state: ResumeState, currentTime: number, duration: number, now = Date.now()): ResumePos | null {
	const videoId = state.mix[state.position]?.videoId;
	if (typeof videoId !== "string" || !videoId) return null;
	return {
		v: RESUME_VERSION,
		base: state.savedAt,
		videoId,
		currentTime: Math.max(0, finite(currentTime)),
		duration: Math.max(0, finite(duration)),
		savedAt: now,
	};
}

export function readResumeState(
	storage: Pick<StorageLike, "getItem"> | undefined,
	now = Date.now(),
): ResumeState | null {
	try {
		const state = parseResumeState(storage?.getItem(RESUME_KEY), now);
		if (!state) return null;
		let pos: ResumePos | null = null;
		try {
			pos = parseResumePos(storage?.getItem(RESUME_POS_KEY));
		} catch {
			pos = null;
		}
		const merged = mergeResumePos(state, pos);
		// I7 max age applies to the merged savedAt too (the position is newer).
		return merged;
	} catch {
		return null;
	}
}

// L10 (audit v7, P2): bumped by every successful writeResumeState call in
// this tab. The periodic save loop (startResumePersistence) remembers the
// value right after ITS OWN writes; when it differs on the next tick, some
// other code in the same tab (restoreRemoteResume, a remote-resume restore)
// rewrote RESUME_KEY without going through the loop, so its in-memory
// `lastQueue` is stale and must be resynced before a "pos"-only write can be
// trusted (see resyncResumeTracking + startResumePersistence below). A
// second tab rewriting the same key is covered separately by a `storage`
// event (storage events don't fire in the writing tab itself).
let resumeWriteSeq = 0;
export function resumeWriteSequence(): number {
	return resumeWriteSeq;
}

export function writeResumeState(storage: StorageLike | undefined, state: ResumeState | null): boolean {
	if (!storage || !state) return false;
	try {
		storage.setItem(RESUME_KEY, JSON.stringify(state));
		resumeWriteSeq++;
		return true;
	} catch {
		return false; // quota / private mode: resume is best-effort
	}
}

/**
 * L10: rebuild the periodic save loop's `lastQueue` / `last` tracking from a
 * state actually read off storage (or from a `storage` event's `newValue`),
 * so the next save decides "queue" vs "pos" against what is really on disk
 * instead of a stale in-memory copy. Pure so the resync decision is testable
 * without DOM timers.
 */
export function resyncResumeTracking(disk: ResumeState | null): {
	lastQueue: ResumeState | null;
	last: { sig: string; t: number } | null;
} {
	if (!disk) return { lastQueue: null, last: null };
	const sig = resumeSignature({
		mix: disk.mix,
		position: disk.position,
		currentMixType: disk.type,
		context: disk.context,
		currentMixId: disk.currentMixId,
	});
	return { lastQueue: disk, last: { sig, t: disk.currentTime } };
}

/** K8: the small periodic write (position only). */
export function writeResumePos(storage: StorageLike | undefined, pos: ResumePos | null): boolean {
	if (!storage || !pos) return false;
	try {
		storage.setItem(RESUME_POS_KEY, JSON.stringify(pos));
		return true;
	} catch {
		return false;
	}
}

/** I7: drop the saved queue (and the legacy `lastTrack`) from this device. */
export function clearResumeState(storage: StorageLike | undefined): void {
	try {
		storage?.removeItem?.(RESUME_KEY);
		storage?.removeItem?.(RESUME_POS_KEY);
		storage?.removeItem?.("lastTrack");
	} catch {
		/* best-effort */
	}
}

/**
 * I7: what identifies the saved queue apart from the playback time: cursor,
 * type, mix id, context and the ordered ids of every row. Two snapshots with
 * the same signature differ only by time.
 */
export function resumeSignature(list: {
	mix: unknown[];
	position: number;
	currentMixType?: unknown;
	context?: PlaybackContext | null;
	currentMixId?: string | null;
}): string {
	const mix = Array.isArray(list?.mix) ? list.mix : [];
	const ids = mix.map((r: any) => (r && typeof r.videoId === "string" ? r.videoId : "")).join(",");
	const ctx = list?.context ? `${list.context.kind}:${list.context.title}:${list.context.ids?.length ?? 0}` : "";
	return [finite(list?.position) | 0, String(list?.currentMixType ?? ""), list?.currentMixId ?? "", ctx, ids].join("|");
}

/**
 * I7: whether to write a snapshot. Always when nothing was written yet or the
 * queue / cursor / context changed. Otherwise only when the time moved more
 * than `minDelta` seconds: RESUME_MIN_TIME_DELTA for the periodic save (so a
 * paused or idle tab stops rewriting the same state), ~0 for the pause /
 * hide events (exact position, but a second pause write of the same state is
 * skipped).
 */
export function shouldSaveResume(
	last: { sig: string; t: number } | null,
	sig: string,
	t: number,
	minDelta = RESUME_MIN_TIME_DELTA,
): boolean {
	if (!last || last.sig !== sig) return true;
	return Math.abs(finite(t) - last.t) > minDelta;
}

/**
 * K8: what a save writes. "queue" (the full state + position) when nothing
 * was written yet or the signature changed; "pos" (the small position key)
 * when only the time moved more than `minDelta`; "none" otherwise.
 */
export function resumeSavePlan(
	last: { sig: string; t: number } | null,
	sig: string,
	t: number,
	minDelta = RESUME_MIN_TIME_DELTA,
): "queue" | "pos" | "none" {
	if (!last || last.sig !== sig) return "queue";
	return Math.abs(finite(t) - last.t) > minDelta ? "pos" : "none";
}

/**
 * I2: whether a pending restore (primed for `resume.videoId`) still applies
 * when a source for `loadingVideoId` loads. Another track drops it, so it
 * starts at 0 and plays; an unknown id (same-track media retry) keeps it.
 */
export function resumeKeptFor(
	resume: { videoId?: string } | null | undefined,
	loadingVideoId: string | null | undefined,
): boolean {
	if (!resume) return false;
	if (!resume.videoId || !loadingVideoId) return true;
	return resume.videoId === loadingVideoId;
}

/**
 * I1: "Remember Last Track" used to default to `false` with its switch
 * hidden, so a stored `false` was never a choice. Once per device (flag
 * REMEMBER_MIGRATED_KEY), a stored `false` becomes `true`; after the flag
 * is set, any later explicit choice is kept. Returns true when `settings`
 * was changed (the caller persists it).
 */
export const REMEMBER_MIGRATED_KEY = "ytm-remember-migrated";
export function migrateRememberLastTrack(
	settings: { playback?: { "Remember Last Track"?: boolean } } | null | undefined,
	storage: StorageLike | undefined,
): boolean {
	if (!storage) return false;
	try {
		if (storage.getItem(REMEMBER_MIGRATED_KEY) === "1") return false;
		let changed = false;
		const pb = settings?.playback;
		if (pb && typeof pb === "object" && pb["Remember Last Track"] !== true) {
			pb["Remember Last Track"] = true;
			changed = true;
		}
		storage.setItem(REMEMBER_MIGRATED_KEY, "1");
		return changed;
	} catch {
		return false;
	}
}

/* ---------------------------- runtime (browser) --------------------------- */

const browserStorage = (): StorageLike | undefined => {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
};

const loadRuntime = () =>
	Promise.all([import("$lib/stores/list/sessionList"), import("$lib/player")]).then(
		([list, player]) => ({ SessionListService: list.SessionListService, AudioPlayer: player.AudioPlayer, getSrc: player.getSrc }),
	);

/**
 * Restore the saved queue: same rows, cursor, type and context, the player
 * loaded on the saved track and seeked to the saved time, paused unless
 * `autoplay`. Resolves false when nothing was saved (the caller may fall
 * back to `lastTrack`).
 */
export function restoreResumeState(opts: { autoplay?: boolean } = {}): Promise<boolean> {
	// I3: one restoration at a time. The layout (startup) and the home
	// shortcut / button share the in-flight one instead of racing.
	if (restoring) return restoring;
	const p = doRestore(opts).finally(() => {
		if (restoring === p) restoring = null;
	});
	restoring = p;
	return p;
}
let restoring: Promise<boolean> | null = null;

/** J2: the restoration in flight (startup or home button), or null. */
export function restoreInFlight(): Promise<boolean> | null {
	return restoring;
}

async function doRestore(opts: { autoplay?: boolean }): Promise<boolean> {
	const state = readResumeState(browserStorage());
	if (!state) return false;
	const { SessionListService, AudioPlayer, getSrc } = await loadRuntime();
	const position = await SessionListService.restoreSession({
		mix: state.mix as any[],
		position: state.position,
		type: state.type,
		context: state.context,
		currentMixId: state.currentMixId,
		visitorData: state.visitorData,
	});
	const track = SessionListService.value.mix[position];
	if (!track) return false;
	AudioPlayer.primeResume(resumeSeekTime(state), state.duration, !!opts.autoplay, track.videoId);
	let res: Awaited<ReturnType<typeof getSrc>> | undefined;
	try {
		// I5: a paused startup restore loads in prefetch mode (no server
		// acquisition, no SW caching) until the first play.
		res = await getSrc(
			track.videoId,
			track.playlistId,
			undefined,
			true,
			opts.autoplay ? undefined : { prefetch: true, deferToPlay: true },
		);
	} catch {
		res = undefined;
	}
	// I2: a failed restore must not leak its seek/pause into the next source.
	// The queue itself is restored (true: no lastTrack fallback over it); the
	// home "Reprendre la file" button retries the source (I4).
	if (!res || res.error || !res.body) AudioPlayer.clearResume();
	return true;
}

/**
 * I3/I4: what "Reprendre" does given the current queue row, the saved state
 * and whether the player holds a usable source. "play" only when startup
 * already restored this track AND its source loaded; otherwise the
 * restoration runs (again).
 */
export function resumeAction(
	current: { videoId?: string } | null | undefined,
	state: Pick<ResumeState, "mix" | "position">,
	hasSource: boolean,
): "play" | "restore" {
	const saved = state.mix[state.position]?.videoId;
	return current && saved && current.videoId === saved && hasSource ? "play" : "restore";
}

/**
 * Home "Reprendre" button and the `/home?resume=1` shortcut: bring the
 * saved queue back (shared with an in-flight startup restoration). When it
 * is already restored with a source, only start playback (unless
 * `autoplay: false`). Resolves false when nothing was saved.
 */
export async function resumePlayback(opts: { autoplay?: boolean } = {}): Promise<boolean> {
	const autoplay = opts.autoplay !== false;
	if (restoring) await restoring.catch(() => false);
	const state = readResumeState(browserStorage());
	if (!state) return false;
	const { SessionListService, AudioPlayer } = await loadRuntime();
	if (restoring) await restoring.catch(() => false);
	const cur = SessionListService.value.mix[SessionListService.value.position];
	if (resumeAction(cur, state, AudioPlayer.hasSource()) === "play") {
		if (autoplay) AudioPlayer.play();
		return true;
	}
	return restoreResumeState({ autoplay });
}

/**
 * I3: the `/home?resume=1` shortcut owns the startup resume; the layout then
 * skips its `lastTrack` fallback (which would rewrite the queue).
 */
let shortcutClaimed = false;
export function claimResumeShortcut(): void {
	shortcutClaimed = true;
}
export function resumeShortcutClaimed(): boolean {
	return shortcutClaimed;
}

/**
 * Save every RESUME_SAVE_INTERVAL_MS, on pause, when the page is hidden and
 * on pagehide, while `enabled()` (the "Remember Last Track" setting), and
 * only when something changed (I7, shouldSaveResume). An empty queue never
 * overwrites a saved one. When `enabled()` is false the saved queue is
 * purged (I7). Returns the cleanup.
 */
export function startResumePersistence(enabled: () => boolean): () => void {
	if (typeof window === "undefined") return () => {};
	let stopped = false;
	const cleanups: Array<() => void> = [];
	void loadRuntime().then(({ SessionListService, AudioPlayer }) => {
		if (stopped) return;
		let last: { sig: string; t: number } | null = null;
		// K8: the full state last written (its savedAt anchors the position key).
		let lastQueue: ResumeState | null = null;
		let purged = false;
		// L10: the write-sequence value right after this loop's own last write;
		// a mismatch on the next tick means someone else (same tab) rewrote
		// RESUME_KEY in between (e.g. restoreRemoteResume).
		let knownWriteSeq = resumeWriteSequence();
		const save = (minDelta = 0.25) => {
			try {
				const storage = browserStorage();
				if (!enabled()) {
					// I7: turning the setting off removes the saved queue.
					if (!purged) clearResumeState(storage);
					purged = true;
					last = null;
					lastQueue = null;
					knownWriteSeq = resumeWriteSequence();
					return;
				}
				purged = false;
				if (lastQueue && resumeWriteSequence() !== knownWriteSeq) {
					const fresh = parseResumeState(storage?.getItem(RESUME_KEY));
					({ lastQueue, last } = resyncResumeTracking(fresh));
					knownWriteSeq = resumeWriteSequence();
				}
				const list = SessionListService.value;
				const t = AudioPlayer.currentTime;
				const sig = resumeSignature(list);
				const plan = resumeSavePlan(last, sig, t, minDelta);
				if (plan === "none") return;
				if (plan === "pos" && lastQueue) {
					// K8: only the position moved: a ~100-byte write, not the queue.
					const pos = buildResumePos(lastQueue, t, AudioPlayer.duration);
					if (pos && writeResumePos(storage, pos)) last = { sig, t: pos.currentTime };
					return;
				}
				const state = buildResumeState(list, t, AudioPlayer.duration);
				if (state && writeResumeState(storage, state)) {
					knownWriteSeq = resumeWriteSequence();
					last = { sig, t: state.currentTime };
					lastQueue = state;
					// The position key belongs to the previous queue: refresh it.
					writeResumePos(storage, buildResumePos(state, state.currentTime, state.duration, state.savedAt));
				}
			} catch {
				/* best-effort */
			}
		};
		const timer = setInterval(() => save(RESUME_MIN_TIME_DELTA), RESUME_SAVE_INTERVAL_MS);
		cleanups.push(() => clearInterval(timer));
		// L10: a second tab rewriting RESUME_KEY (another device's state pulled
		// in, or its own periodic save) doesn't bump this tab's write sequence
		// (storage events never fire in the writing document), so resync
		// directly from the event instead of waiting for the next tick.
		const onStorage = (e: StorageEvent) => {
			if (e.key !== RESUME_KEY) return;
			({ lastQueue, last } = resyncResumeTracking(parseResumeState(e.newValue)));
			knownWriteSeq = resumeWriteSequence();
		};
		window.addEventListener("storage", onStorage);
		cleanups.push(() => window.removeEventListener("storage", onStorage));
		let first = true;
		cleanups.push(
			AudioPlayer.paused.subscribe((paused) => {
				if (first) {
					first = false;
					return;
				}
				if (paused) save();
			}),
		);
		const onVisibility = () => {
			if (document.visibilityState === "hidden") save();
		};
		const onPageHide = () => save();
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onPageHide);
		cleanups.push(() => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onPageHide);
		});
	});
	return () => {
		stopped = true;
		while (cleanups.length) cleanups.pop()?.();
	};
}
