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
export const RESUME_VERSION = 1;
export const RESUME_MAX_ITEMS = 500;
export const RESUME_SAVE_INTERVAL_MS = 5000;
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

/** Validate a persisted state; null when absent / corrupt / empty. */
export function parseResumeState(raw: string | null | undefined): ResumeState | null {
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
	return {
		v: RESUME_VERSION,
		savedAt: finite(j.savedAt),
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

export function readResumeState(storage: Pick<StorageLike, "getItem"> | undefined): ResumeState | null {
	try {
		return parseResumeState(storage?.getItem(RESUME_KEY));
	} catch {
		return null;
	}
}

export function writeResumeState(storage: StorageLike | undefined, state: ResumeState | null): boolean {
	if (!storage || !state) return false;
	try {
		storage.setItem(RESUME_KEY, JSON.stringify(state));
		return true;
	} catch {
		return false; // quota / private mode: resume is best-effort
	}
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
	settings: { playback?: Record<string, unknown> } | null | undefined,
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
export async function restoreResumeState(opts: { autoplay?: boolean } = {}): Promise<boolean> {
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
	AudioPlayer.primeResume(resumeSeekTime(state), state.duration, !!opts.autoplay);
	await getSrc(track.videoId, track.playlistId, undefined, true);
	return true;
}

/**
 * Home "Reprendre": play the saved queue. When startup already restored it
 * (same track under the cursor), only start playback.
 */
export async function resumePlayback(): Promise<boolean> {
	const state = readResumeState(browserStorage());
	if (!state) return false;
	const { SessionListService, AudioPlayer } = await loadRuntime();
	const cur = SessionListService.value.mix[SessionListService.value.position];
	if (cur && cur.videoId === state.mix[state.position]?.videoId) {
		AudioPlayer.play();
		return true;
	}
	return restoreResumeState({ autoplay: true });
}

/**
 * Save every RESUME_SAVE_INTERVAL_MS, on pause, when the page is hidden and
 * on pagehide, while `enabled()` (the "Remember Last Track" setting). An
 * empty queue never overwrites a saved one. Returns the cleanup.
 */
export function startResumePersistence(enabled: () => boolean): () => void {
	if (typeof window === "undefined") return () => {};
	let stopped = false;
	const cleanups: Array<() => void> = [];
	void loadRuntime().then(({ SessionListService, AudioPlayer }) => {
		if (stopped) return;
		const save = () => {
			try {
				if (!enabled()) return;
				const state = buildResumeState(
					SessionListService.value,
					AudioPlayer.currentTime,
					AudioPlayer.duration,
				);
				if (state) writeResumeState(browserStorage(), state);
			} catch {
				/* best-effort */
			}
		};
		const timer = setInterval(save, RESUME_SAVE_INTERVAL_MS);
		cleanups.push(() => clearInterval(timer));
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
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", save);
		cleanups.push(() => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", save);
		});
	});
	return () => {
		stopped = true;
		while (cleanups.length) cleanups.pop()?.();
	};
}
