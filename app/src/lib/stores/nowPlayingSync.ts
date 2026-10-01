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
import { get } from "svelte/store";
import {
	RESUME_KEY,
	buildResumeState,
	parseResumeState,
	readResumeState,
	resumeSignature,
	shouldSaveResume,
	writeResumeState,
	type ResumeState,
} from "./resumeState";

export const DEVICE_ID_KEY = "ytm-device-id";
export const REMOTE_CONSUMED_KEY = "ytm-remote-consumed";
export const NOWPLAYING_SYNC_MS = 15000;
/**
 * J3: once device X's offer was taken here, X's next pushes stay hidden until
 * they are this much newer than the consumed one.
 */
export const REMOTE_NEWER_MS = 2 * 60 * 1000;
/** 40A: the server state must be this much newer than the local one to be offered. */
export const REMOTE_LIVE_NEWER_MS = 10 * 1000;
/** 40A: foreground / channel refreshes of the offer, at most once per this. */
export const REMOTE_REFRESH_THROTTLE_MS = 20 * 1000;
/** J6: between two pushes of the same queue, the position must move more than this (s). */
export const NOWPLAYING_MIN_TIME_DELTA = 10;
/** Server limit on the payload (413 above); a long queue is cut to fit. */
export const NOWPLAYING_MAX_BYTES = 64 * 1024;
/** keepalive fetches (page hidden) are capped by browsers around 64 KB in total. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

/** The minimal BroadcastChannel surface `wireProfileChannel` needs (testable without a real one). */
export interface ProfileChannelLike {
	onmessage: ((ev: MessageEvent) => void) | null;
	close(): void;
}

/**
 * L14 (audit v7, P3): `named` (whether this tab's current profile has a
 * name) used to be memoised for the page's whole lifetime once known
 * (K12), so a login that happens via the Account page UI - without a
 * reload - never pushed `me/nowplaying` until the next page load. me.ts's
 * login()/logout() now broadcast on the same channel (L13); any message
 * here means "the profile may have changed", so `onProfileChanged` must
 * re-ask `whoami()` next time, regardless of the message's own payload.
 * Pure/injectable so it's unit-testable without a real BroadcastChannel.
 */
export function wireProfileChannel(channel: ProfileChannelLike, onProfileChanged: () => void): () => void {
	channel.onmessage = () => onProfileChanged();
	return () => {
		channel.onmessage = null;
		channel.close();
	};
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

/** Row keys that only mean something on the device that wrote them (J1). */
const DEVICE_ROW_KEYS = ["localUrl", "_offlineUrl"] as const;

/**
 * J1: the queue sent to `me/nowplaying` must not carry this device's cache
 * URLs (`localUrl` / `_offlineUrl`: `/aud/<id>`, `/localf?...`, a signed
 * `/vp?u=`); the other device resolves each row by `videoId` (offlineFormats,
 * then player.json). The local C1 state keeps them. Same object back when
 * nothing had to be removed.
 */
export function stripDeviceUrls(state: ResumeState | null): ResumeState | null {
	if (!state) return null;
	let changed = false;
	const mix = state.mix.map((row) => {
		if (!row || typeof row !== "object" || !DEVICE_ROW_KEYS.some((k) => k in row)) return row;
		changed = true;
		const out = { ...row };
		for (const k of DEVICE_ROW_KEYS) delete out[k];
		return out;
	});
	return changed ? { ...state, mix } : state;
}

/**
 * The resume state as sent to the server: device URLs removed (J1), then
 * cut around the cursor until its JSON fits `maxBytes` (the server refuses
 * more). null when even the current track alone does not fit or the queue
 * is empty.
 */
export function fitResumeState(input: ResumeState | null, maxBytes = NOWPLAYING_MAX_BYTES): ResumeState | null {
	const state = stripDeviceUrls(input);
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
	/** 40A: the device that took the playback over ("Continuer ici"). */
	takenBy?: string;
	takenAt?: number;
}

/** 40A: a take older than this no longer pauses anyone (server guard: 10 min). */
export const TAKE_GUARD_MS = 10 * 60 * 1000;

/** The device that holds the playback away from `localDeviceId`, from a GET row; else null. */
export function takenAway(
	row: RemoteNowPlaying | null | undefined,
	localDeviceId: string,
	now: number,
): { deviceId: string; deviceName: string } | null {
	if (!row || typeof row !== "object" || !row.takenBy || row.takenBy === localDeviceId) return null;
	const at = Number(row.takenAt);
	if (!isFinite(at) || at <= 0 || now - at > TAKE_GUARD_MS) return null;
	return { deviceId: row.takenBy, deviceName: row.deviceId === row.takenBy ? row.deviceName : "" };
}

/** The toast on the device that lost the playback. */
export function takenToast(deviceName: string | null | undefined): string {
	const n = String(deviceName ?? "").trim();
	return `Lecture reprise sur ${n || "un autre appareil"}`;
}

/** J3: the `ytm-remote-consumed` value, per device: "<deviceId>|<updatedAt>". */
export function consumedMarker(deviceId: string, updatedAt: number): string {
	return `${deviceId}|${updatedAt}`;
}

/** Parse a consumed marker; a legacy value is the bare updatedAt (no device). */
function parseConsumed(raw: string | null | undefined): { deviceId: string | null; at: number } | null {
	if (!raw) return null;
	const i = raw.lastIndexOf("|");
	const at = Number(i >= 0 ? raw.slice(i + 1) : raw);
	if (!isFinite(at) || at <= 0) return null;
	return { deviceId: i > 0 ? raw.slice(0, i) : null, at };
}

/** What this device knows about its own resume state, for `shouldOfferRemote`. */
export interface LocalResumeView {
	deviceId: string;
	/** The live local C1 `savedAt` (null / 0 when nothing is saved). */
	savedAt: number | null | undefined;
	/** The `ytm-remote-consumed` marker (J3). */
	consumed?: string | null;
	/** Something plays here right now: the local state is "now". */
	playing?: boolean;
}

/**
 * 40A, the card rule (pure): offer the server state when it comes from
 * ANOTHER device, is more than REMOTE_LIVE_NEWER_MS newer than the local
 * resume state (its `savedAt`, or `now` while this device plays: with I7 the
 * local state only moves when playback moves, so a device that is listening
 * never sees the card) and was not consumed on this device: after a click on
 * device X's offer, X's next pushes are ignored until they are REMOTE_NEWER_MS
 * past the consumed one (J3). The payload is checked by `remoteResumeOffer`.
 */
export function shouldOfferRemote(
	local: LocalResumeView,
	remote: RemoteNowPlaying | null | undefined,
	now: number,
): boolean {
	if (!remote || typeof remote !== "object") return false;
	if (!remote.deviceId || remote.deviceId === local.deviceId) return false;
	const at = Number(remote.updatedAt);
	if (!isFinite(at) || at <= 0) return false;
	const c = parseConsumed(local.consumed);
	if (c) {
		if (c.deviceId === null ? c.at === at : c.deviceId === remote.deviceId && at - c.at < REMOTE_NEWER_MS) return false;
	}
	const saved = typeof local.savedAt === "number" && isFinite(local.savedAt) ? local.savedAt : 0;
	const localAt = local.playing ? Math.max(saved, now) : saved;
	return at - localAt > REMOTE_LIVE_NEWER_MS;
}

/**
 * The offer itself: `shouldOfferRemote` plus a playable queue. Returns the
 * parsed state (server position applied), else null.
 */
export function remoteResumeOffer(
	remote: RemoteNowPlaying | null | undefined,
	localDeviceId: string,
	localSavedAt: number | null | undefined,
	consumed: string | null | undefined,
	now: number = Date.now(),
): ResumeState | null {
	if (!remote || !shouldOfferRemote({ deviceId: localDeviceId, savedAt: localSavedAt, consumed }, remote, now)) return null;
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

/**
 * 40A: the foreground refresh of the offer (visibilitychange visible, focus,
 * pageshow, the `ytm-profile` channel), throttled to one run per
 * REMOTE_REFRESH_THROTTLE_MS; `force` (a profile change) skips the throttle.
 * One run at a time. Resolves whether `load` ran.
 */
export function makeRemoteRefresher(deps: {
	load: () => Promise<unknown>;
	now?: () => number;
	throttleMs?: number;
}): (force?: boolean) => Promise<boolean> {
	const now = deps.now ?? Date.now;
	const gap = deps.throttleMs ?? REMOTE_REFRESH_THROTTLE_MS;
	let last = -Infinity;
	let running = false;
	return async (force = false) => {
		if (running) return false;
		const t = now();
		if (!force && t - last < gap) return false;
		last = t;
		running = true;
		try {
			await deps.load();
		} catch {
			/* best-effort */
		} finally {
			running = false;
		}
		return true;
	};
}

/**
 * Wire `refresh` to the foreground events; returns the cleanup. Only the
 * visible side of `visibilitychange` counts.
 */
export function wireForegroundRefresh(refresh: () => void, target: { win: Window; doc: Document } | null = null): () => void {
	const win = target?.win ?? (typeof window === "undefined" ? undefined : window);
	const doc = target?.doc ?? (typeof document === "undefined" ? undefined : document);
	if (!win || !doc) return () => {};
	const onVisible = () => {
		if (doc.visibilityState === "visible") refresh();
	};
	doc.addEventListener("visibilitychange", onVisible);
	win.addEventListener("focus", refresh);
	win.addEventListener("pageshow", refresh);
	return () => {
		doc.removeEventListener("visibilitychange", onVisible);
		win.removeEventListener("focus", refresh);
		win.removeEventListener("pageshow", refresh);
	};
}

export interface NowPlayingBody {
	deviceId: string;
	deviceName: string;
	position: number;
	payload: ResumeState;
	/** 40A: this device takes the playback over (always its own deviceId). */
	takenBy?: string;
	takenAt?: number;
}

/** The PUT answer: 409 carries the device that holds the row (40A). */
export interface NowPlayingPutResult {
	status: number;
	takenBy?: string;
	deviceName?: string;
}

type DeviceInfo = { deviceId: string; deviceName: string };

export interface NowPlayingPusherDeps {
	/** Read at each push (the name may be edited meanwhile, 40A item 3). */
	device: DeviceInfo | (() => DeviceInfo);
	/** The session list and player time, read at each push. */
	snapshot: () => { list: Parameters<typeof buildResumeState>[0]; currentTime: number; duration: number };
	loggedIn: () => Promise<boolean>;
	/** The PUT; resolves the HTTP status (0 = network error) or the full answer. */
	put: (body: NowPlayingBody, keepalive: boolean) => Promise<number | NowPlayingPutResult>;
	online?: () => boolean;
	/** 40A: another device took the playback over (409): pause here, toast. */
	onTaken?: (by: DeviceInfo) => void;
	now?: () => number;
}

export type NowPlayingPusher = ((hidden?: boolean) => Promise<"sent" | "skipped" | "taken">) & {
	/** 40A: the next push takes the row (the user pressed play here again). */
	claim(): void;
	/** The device that took the playback away from this one, until `claim`. */
	lostTo(): DeviceInfo | null;
	/** Mark the playback as lost without a PUT (seen on a GET). */
	markLost(by: DeviceInfo): void;
	/** This device took the row by itself ("Continuer ici"): not lost any more. */
	markOwner(): void;
}

/**
 * J6: the push used by startNowPlayingSync, as a pure factory. A PUT only
 * goes out when the queue signature (rows, cursor, type, context:
 * `resumeSignature`) or the position (more than NOWPLAYING_MIN_TIME_DELTA s)
 * changed since the last PUT that succeeded; a paused or stalled player
 * stops rewriting the same row every 15 s. A failed PUT keeps the last
 * sent snapshot so the next tick retries. One push in flight at a time.
 *
 * 40A: a 409 means another device took the playback over: `onTaken` runs
 * once and nothing more is sent (the row is not ours to overwrite) until
 * `claim()` (the user pressed play here), whose push carries `takenBy` and
 * takes the row back, even without progress.
 */
export function makeNowPlayingPusher(deps: NowPlayingPusherDeps): NowPlayingPusher {
	let inflight = false;
	let last: { sig: string; t: number } | null = null;
	let lost: DeviceInfo | null = null;
	let claiming = false;
	const device = () => (typeof deps.device === "function" ? deps.device() : deps.device);
	const push = async (hidden = false): Promise<"sent" | "skipped" | "taken"> => {
		if (inflight) return "skipped";
		if (lost && !claiming) return "skipped";
		if (deps.online && !deps.online()) return "skipped";
		inflight = true;
		try {
			const { list, currentTime, duration } = deps.snapshot();
			const sig = resumeSignature(list);
			if (!claiming && !shouldSaveResume(last, sig, currentTime, NOWPLAYING_MIN_TIME_DELTA)) return "skipped";
			if (!(await deps.loggedIn())) return "skipped";
			const state = fitResumeState(buildResumeState(list, currentTime, duration));
			if (!state) return "skipped";
			const me = device();
			const body: NowPlayingBody = { ...me, position: state.currentTime, payload: state };
			const take = claiming;
			if (take) {
				body.takenBy = me.deviceId;
				body.takenAt = (deps.now ?? Date.now)();
			}
			const keepalive = hidden && JSON.stringify(body).length <= KEEPALIVE_MAX_BYTES;
			const res = await deps.put(body, keepalive);
			const r: NowPlayingPutResult = typeof res === "number" ? { status: res } : res;
			if (r.status === 409 && !take) {
				lost = { deviceId: String(r.takenBy ?? ""), deviceName: String(r.deviceName ?? "") };
				try {
					deps.onTaken?.(lost);
				} catch {
					/* best-effort */
				}
				return "taken";
			}
			if (r.status < 200 || r.status >= 300) return "skipped";
			if (take) {
				claiming = false;
				lost = null;
			}
			last = { sig, t: state.currentTime };
			return "sent";
		} catch {
			return "skipped"; // best-effort, nothing queued
		} finally {
			inflight = false;
		}
	};
	return Object.assign(push, {
		claim: () => {
			claiming = true;
		},
		lostTo: () => lost,
		markLost: (by: DeviceInfo) => {
			if (lost) return;
			lost = by;
			try {
				deps.onTaken?.(by);
			} catch {
				/* best-effort */
			}
		},
		markOwner: () => {
			lost = null;
			claiming = false;
		},
	});
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

/** J3: the local C1 savedAt as it is NOW (null when nothing is saved). */
export function localSavedAt(): number | null {
	return readResumeState(browserStorage())?.savedAt ?? null;
}

const loadRuntime = () =>
	Promise.all([import("$lib/stores/list/sessionList"), import("$lib/player"), import("$lib/me")]).then(
		([list, player, me]) => ({ SessionListService: list.SessionListService, AudioPlayer: player.AudioPlayer, me }),
	);

/** The running pusher (startNowPlayingSync), for "Continuer ici". */
let activePusher: NowPlayingPusher | null = null;

/**
 * Push the resume state every NOWPLAYING_SYNC_MS while playing, on pause
 * and when the page is hidden; only for a named profile, only online.
 * Returns the cleanup.
 */
export function startNowPlayingSync(): () => void {
	if (typeof window === "undefined") return () => {};
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
		const pusher = makeNowPlayingPusher({
			device: localDevice,
			snapshot: () => ({
				list: SessionListService.value,
				currentTime: AudioPlayer.currentTime,
				duration: AudioPlayer.duration,
			}),
			loggedIn,
			put: (body, keepalive) => me.putNowPlaying(body, keepalive),
			online: () => typeof navigator === "undefined" || navigator.onLine !== false,
			// 40A: another device pressed "Continuer ici": pause here, no auto-resume.
			onTaken: (by) => {
				if (!get(AudioPlayer.paused)) AudioPlayer.pause();
				void import("$lib/utils").then((u) => u.notify(takenToast(by.deviceName), "success"));
			},
		});
		activePusher = pusher;
		cleanups.push(() => {
			if (activePusher === pusher) activePusher = null;
		});
		const push = async (hidden = false) => {
			if (!stopped) await pusher(hidden);
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
				if (paused) {
					void push();
					return;
				}
				// 40A: play pressed here after a take elsewhere: take it back now.
				if (pusher.lostTo()) {
					pusher.claim();
					void push();
				}
			}),
		);
		// 40A: on the ytm-profile channel, a playing device checks at once
		// whether another one took the playback over (else: next push, 15 s).
		const checkTaken = async () => {
			if (stopped || !playing || pusher.lostTo() || !(await loggedIn())) return;
			const by = takenAway(await me.getNowPlaying(), localDevice().deviceId, Date.now());
			if (by && playing) pusher.markLost(by);
		};
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
		// L14: the shared profile channel (me.ts, L13) catches it immediately -
		// another tab, or this tab's own Account-page login without a reload -
		// instead of waiting for this tab to regain focus.
		const reset = () => {
			named = null;
		};
		window.addEventListener("focus", reset);
		cleanups.push(() => window.removeEventListener("focus", reset));
		if (typeof BroadcastChannel !== "undefined") {
			const channel = new BroadcastChannel(me.PROFILE_CHANNEL_NAME);
			cleanups.push(
				wireProfileChannel(channel, () => {
					reset();
					void checkTaken();
				}),
			);
		}
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
export async function fetchRemoteResume(): Promise<{
	state: ResumeState;
	deviceId: string;
	deviceName: string;
	updatedAt: number;
} | null> {
	if (typeof window === "undefined") return null;
	if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
	try {
		const me = await import("$lib/me");
		// K12: an anonymous profile has no server state (me/nowplaying answers
		// 404): skip the GET (whoami is memoised 5 min, see $lib/me).
		if (await me.isAnonymousProfile()) return null;
		const row = await me.getNowPlaying();
		let consumed: string | null = null;
		try {
			consumed = browserStorage()?.getItem(REMOTE_CONSUMED_KEY) ?? null;
		} catch {
			consumed = null;
		}
		const state = remoteResumeOffer(row, localDevice().deviceId, localSavedAt(), consumed);
		if (!state || !row) return null;
		return {
			state,
			deviceId: String(row.deviceId),
			deviceName: row.deviceName || "Appareil",
			updatedAt: Number(row.updatedAt),
		};
	} catch {
		return null;
	}
}

/** What `restoreRemoteResume` needs from the runtime (injected by the tests). */
export interface RestoreRemoteDeps {
	storage: StorageLike | undefined;
	restoreInFlight: () => Promise<boolean> | null;
	restoreResumeState: (opts: { autoplay?: boolean }) => Promise<boolean>;
	notify: (msg: string, type: "success" | "error") => void;
	now?: () => number;
}

const runtimeRestoreDeps = async (): Promise<RestoreRemoteDeps> => {
	const [rs, utils] = await Promise.all([import("./resumeState"), import("$lib/utils")]);
	return {
		storage: browserStorage(),
		restoreInFlight: rs.restoreInFlight,
		restoreResumeState: rs.restoreResumeState,
		notify: utils.notify,
	};
};

/**
 * Click on the card: the remote state becomes the local C1 state and goes
 * through the C1 restoration (restoreSession + primed PAUSED at the
 * position, never auto-plays). J2: a startup restoration still in flight
 * would be shared and bring back the OLD local state, so it is awaited
 * first, then ours runs exactly once. On failure the local state is put
 * back as it was, a toast says so and the offer is NOT consumed (the card
 * stays for a retry).
 */
export async function restoreRemoteResume(
	offer: { state: ResumeState; deviceId: string; updatedAt: number; deviceName?: string },
	deps?: RestoreRemoteDeps,
	opts: { autoplay?: boolean } = {},
): Promise<boolean> {
	const d = deps ?? (await runtimeRestoreDeps());
	const inflight = d.restoreInFlight();
	if (inflight) await inflight.catch(() => false);
	const storage = d.storage;
	let previous: string | null = null;
	try {
		previous = storage?.getItem(RESUME_KEY) ?? null;
	} catch {
		previous = null;
	}
	const fail = () => {
		try {
			if (previous === null) storage?.removeItem?.(RESUME_KEY);
			else storage?.setItem(RESUME_KEY, previous);
		} catch {
			/* best-effort */
		}
		d.notify(`Reprise depuis ${offer.deviceName || "l'autre appareil"} impossible`, "error");
		return false;
	};
	const state: ResumeState = { ...offer.state, savedAt: (d.now ?? Date.now)() };
	if (!writeResumeState(storage, state)) return fail();
	let ok = false;
	try {
		ok = await d.restoreResumeState({ autoplay: !!opts.autoplay });
	} catch {
		ok = false;
	}
	if (!ok) return fail();
	try {
		storage?.setItem(REMOTE_CONSUMED_KEY, consumedMarker(offer.deviceId, offer.updatedAt));
	} catch {
		/* best-effort */
	}
	return true;
}

/** What `takeRemoteResume` needs from the runtime (injected by the tests). */
export interface TakeRemoteDeps {
	restore: (opts: { autoplay: boolean }) => Promise<boolean>;
	device: () => DeviceInfo;
	put: (body: NowPlayingBody) => Promise<number | NowPlayingPutResult>;
	/** The running pusher: this device owns the row now. */
	markOwner?: () => void;
	now?: () => number;
}

/**
 * 40A "Continuer ici": restore the remote queue at its position and PLAY
 * here (a), then mark the server row as taken by this device (b) so the
 * other one pauses on its next push (c). The take PUT carries the offer's
 * own state (the local player may not have reached the position yet).
 * Resolves false when the restoration failed (toast by restoreRemoteResume,
 * nothing taken); a failed take PUT is best-effort (playback stays here).
 */
export async function takeRemoteResume(
	offer: { state: ResumeState; deviceId: string; updatedAt: number; deviceName?: string },
	deps?: TakeRemoteDeps,
): Promise<boolean> {
	const d: TakeRemoteDeps = deps ?? {
		restore: (o) => restoreRemoteResume(offer, undefined, o),
		device: localDevice,
		put: async (body) => (await import("$lib/me")).putNowPlaying(body),
		markOwner: () => activePusher?.markOwner(),
	};
	if (!(await d.restore({ autoplay: true }))) return false;
	d.markOwner?.();
	const payload = fitResumeState(offer.state);
	if (!payload) return true;
	const me = d.device();
	try {
		await d.put({
			...me,
			position: payload.currentTime,
			payload,
			takenBy: me.deviceId,
			takenAt: (d.now ?? Date.now)(),
		});
	} catch {
		/* best-effort: the next push of this device writes the row anyway */
	}
	return true;
}
