/**
 * C2 multi-device resume: while something plays, this device pushes its C1
 * resume state (same slim builder as `resumeState.ts`) to `me/nowplaying`
 * every 15 s, on pause and when the page is hidden. Another device of the
 * same named profile reads it at startup and the home page offers
 * "Reprendre depuis <appareil>" when that state is newer than its own.
 *
 * Best-effort only: nothing is sent for an anonymous profile (whoami fails
 * or has no name) or offline, and a failed PUT is dropped (no outbox: the
 * next tick sends a fresher state anyway).
 *
 * The top half is pure (unit-tested); the runtime half loads the player,
 * the session list and the API client lazily.
 */
import { buildResumeState, parseResumeState, type ResumeState } from "./resumeState";

export const DEVICE_ID_KEY = "ytm-device-id";
export const REMOTE_CONSUMED_KEY = "ytm-remote-consumed";
export const NOWPLAYING_SYNC_MS = 15000;
/** The server state must be this much newer than the local one to be offered. */
export const REMOTE_NEWER_MS = 2 * 60 * 1000;
/** Server limit on the payload (413 above); a long queue is cut to fit. */
export const NOWPLAYING_MAX_BYTES = 64 * 1024;
/** keepalive fetches (page hidden) are capped by browsers around 64 KB in total. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** A short human name for this device, from its user agent. */
export function deviceNameFromUA(ua: string | null | undefined): string {
	const s = String(ua ?? "");
	if (/iPhone|iPod/i.test(s)) return "iPhone";
	if (/Android/i.test(s)) return "Android";
	if (/Windows/i.test(s)) return "Windows";
	if (/Macintosh|Mac OS X/i.test(s)) return "Mac";
	if (/Linux|X11/i.test(s)) return "Linux";
	return "Appareil";
}

function randomId(): string {
	try {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	} catch {
		/* fall through */
	}
	return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The stable per-browser device id (created once in `ytm-device-id`). */
export function getDeviceId(storage: StorageLike | undefined, make: () => string = randomId): string {
	try {
		const cur = storage?.getItem(DEVICE_ID_KEY);
		if (cur) return cur;
		const id = make();
		storage?.setItem(DEVICE_ID_KEY, id);
		return id;
	} catch {
		return make(); // private mode: an id for this page only
	}
}

/**
 * The resume state, cut around the cursor until its JSON fits `maxBytes`
 * (the server refuses more). null when even the current track alone does
 * not fit or the queue is empty.
 */
export function fitResumeState(state: ResumeState | null, maxBytes = NOWPLAYING_MAX_BYTES): ResumeState | null {
	if (!state || !state.mix.length) return null;
	const size = (s: ResumeState) => new TextEncoder().encode(JSON.stringify(s)).length;
	if (size(state) <= maxBytes) return state;
	let keep = state.mix.length;
	while (keep > 1) {
		keep = Math.max(1, Math.floor(keep / 2));
		const before = Math.min(state.position, Math.floor(keep / 5));
		const start = Math.max(0, Math.min(state.position - before, state.mix.length - keep));
		const cut: ResumeState = { ...state, mix: state.mix.slice(start, start + keep), position: state.position - start };
		if (size(cut) <= maxBytes) return cut;
	}
	return null;
}

export interface RemoteNowPlaying {
	deviceId: string;
	deviceName: string;
	position: number;
	payload: unknown;
	updatedAt: number;
}

/**
 * The card rule: offer the server state when it comes from ANOTHER device,
 * is more than REMOTE_NEWER_MS newer than the local `resumeState.savedAt`
 * (0 when there is none), carries a playable queue and was not already
 * consumed on this device. Returns the parsed state (position applied), else null.
 */
export function remoteResumeOffer(
	remote: RemoteNowPlaying | null | undefined,
	localDeviceId: string,
	localSavedAt: number | null | undefined,
	consumed: string | null | undefined,
): ResumeState | null {
	if (!remote || typeof remote !== "object") return null;
	if (!remote.deviceId || remote.deviceId === localDeviceId) return null;
	const at = Number(remote.updatedAt);
	if (!isFinite(at) || at <= 0) return null;
	if (consumed && consumed === String(at)) return null;
	const local = typeof localSavedAt === "number" && isFinite(localSavedAt) ? localSavedAt : 0;
	if (at - local <= REMOTE_NEWER_MS) return null;
	let state: ResumeState | null;
	try {
		state = parseResumeState(typeof remote.payload === "string" ? remote.payload : JSON.stringify(remote.payload));
	} catch {
		state = null;
	}
	if (!state) return null;
	const pos = Number(remote.position);
	if (isFinite(pos) && pos >= 0) state.currentTime = pos;
	return state;
}

/** "m:ss" for the card. */
export function clockLabel(s: number): string {
	const t = Math.max(0, Math.floor(isFinite(s) ? s : 0));
	return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/* ---------------------------- runtime (browser) --------------------------- */

const browserStorage = (): StorageLike | undefined => {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
};

/** This browser's device id / name (stable across tabs and reloads). */
export function localDevice(): { deviceId: string; deviceName: string } {
	return {
		deviceId: getDeviceId(browserStorage()),
		deviceName: deviceNameFromUA(typeof navigator === "undefined" ? "" : navigator.userAgent),
	};
}

// The local resumeState.savedAt as it was when the app started, before the
// C1 persistence (which rewrites savedAt every 5 s, even paused) bumps it.
let startupSavedAt: number | null | undefined;
function snapshotStartupSavedAt() {
	if (startupSavedAt !== undefined) return;
	try {
		const raw = browserStorage()?.getItem("resumeState");
		startupSavedAt = parseResumeState(raw)?.savedAt ?? null;
	} catch {
		startupSavedAt = null;
	}
}
/** The local C1 savedAt at startup (null when there was no saved state). */
export function localStartupSavedAt(): number | null {
	snapshotStartupSavedAt();
	return startupSavedAt ?? null;
}

const loadRuntime = () =>
	Promise.all([import("$lib/stores/list/sessionList"), import("$lib/player"), import("$lib/me")]).then(
		([list, player, me]) => ({ SessionListService: list.SessionListService, AudioPlayer: player.AudioPlayer, me }),
	);

/**
 * Push the resume state every NOWPLAYING_SYNC_MS while playing, on pause
 * and when the page is hidden; only for a named profile, only online.
 * Returns the cleanup.
 */
export function startNowPlayingSync(): () => void {
	if (typeof window === "undefined") return () => {};
	snapshotStartupSavedAt();
	let stopped = false;
	const cleanups: Array<() => void> = [];
	void loadRuntime().then(async ({ SessionListService, AudioPlayer, me }) => {
		if (stopped) return;
		let named: boolean | null = null; // null: unknown yet / to retry
		const loggedIn = async () => {
			if (named !== null) return named;
			try {
				const w = await me.whoami();
				named = !!(w && typeof w.name === "string" && w.name.trim());
			} catch {
				named = null; // whoami failed: skip now, ask again next time
				return false;
			}
			return named;
		};
		const { deviceId, deviceName } = localDevice();
		let inflight = false;
		const push = async (hidden = false) => {
			if (stopped || inflight) return;
			if (typeof navigator !== "undefined" && navigator.onLine === false) return;
			inflight = true;
			try {
				if (!(await loggedIn())) return;
				const state = fitResumeState(
					buildResumeState(SessionListService.value, AudioPlayer.currentTime, AudioPlayer.duration),
				);
				if (!state) return;
				const body = { deviceId, deviceName, position: state.currentTime, payload: state };
				const keepalive = hidden && JSON.stringify(body).length <= KEEPALIVE_MAX_BYTES;
				await me.putNowPlaying(body, keepalive);
			} catch {
				/* best-effort, nothing queued */
			} finally {
				inflight = false;
			}
		};
		let playing = false;
		let first = true;
		cleanups.push(
			AudioPlayer.paused.subscribe((paused) => {
				playing = !paused;
				if (first) {
					first = false;
					return;
				}
				if (paused) void push();
			}),
		);
		const timer = setInterval(() => {
			if (playing) void push();
		}, NOWPLAYING_SYNC_MS);
		cleanups.push(() => clearInterval(timer));
		const onVisibility = () => {
			if (document.visibilityState === "hidden") void push(true);
		};
		document.addEventListener("visibilitychange", onVisibility);
		cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
		// A login / logout changes who the state belongs to: ask whoami again.
		const reset = () => (named = null);
		window.addEventListener("focus", reset);
		cleanups.push(() => window.removeEventListener("focus", reset));
	});
	return () => {
		stopped = true;
		while (cleanups.length) cleanups.pop()?.();
	};
}

/**
 * The remote state to offer on the home page, or null (see remoteResumeOffer).
 * Only online; never throws.
 */
export async function fetchRemoteResume(): Promise<{ state: ResumeState; deviceName: string; updatedAt: number } | null> {
	if (typeof window === "undefined") return null;
	if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
	try {
		const me = await import("$lib/me");
		const row = await me.getNowPlaying();
		let consumed: string | null = null;
		try {
			consumed = browserStorage()?.getItem(REMOTE_CONSUMED_KEY) ?? null;
		} catch {
			consumed = null;
		}
		const state = remoteResumeOffer(row, localDevice().deviceId, localStartupSavedAt(), consumed);
		if (!state || !row) return null;
		return { state, deviceName: row.deviceName || "Appareil", updatedAt: Number(row.updatedAt) };
	} catch {
		return null;
	}
}

/**
 * Click on the card: the remote state becomes the local C1 state and goes
 * through the C1 restoration (restoreSession + primed PAUSED at the
 * position, never auto-plays); the offer is marked consumed.
 */
export async function restoreRemoteResume(offer: { state: ResumeState; updatedAt: number }): Promise<boolean> {
	const storage = browserStorage();
	try {
		storage?.setItem(REMOTE_CONSUMED_KEY, String(offer.updatedAt));
	} catch {
		/* best-effort */
	}
	const rs = await import("./resumeState");
	const state: ResumeState = { ...offer.state, savedAt: Date.now() };
	if (!rs.writeResumeState(storage, state)) return false;
	let ok = await rs.restoreResumeState({ autoplay: false });
	// A startup restoration still in flight was shared and restored the OLD
	// local state: run ours once it is done.
	const { SessionListService } = await import("$lib/stores/list/sessionList");
	const cur = SessionListService.value.mix[SessionListService.value.position];
	if (cur?.videoId !== state.mix[state.position]?.videoId) {
		rs.writeResumeState(storage, state);
		ok = await rs.restoreResumeState({ autoplay: false });
	}
	return ok;
}
