// Client helpers for the server-side profile state (favorites / follows / playlists).
// The bbp profile cookie is set + carried automatically (credentials:'same-origin').
import { APIClient } from "$lib/api";
import { clearHomeCache } from "$lib/homeCache";
import { parseMigrated, rememberMigration, type MigratedCounts } from "$lib/identity";
import { enqueuePlay, flushOutbox, installHistoryOutbox, readOutbox, statusResult, type SendResult } from "$lib/historyOutbox";
import { isSkipItem, skipBody, skipItem, type SkipSource } from "$lib/skips";

function itemRef(item: any): string {
	return item?.videoId || item?.endpoint?.browseId || item?.browseId || "";
}

// ---- account (named profiles) ----
// K12 (audit perf v2): whoami is memoised 5 min per tab in sessionStorage
// (37 GETs per anonymous home session before: every nowPlayingSync focus,
// every home); login / logout refresh it. An anonymous profile is
// {id, name: ""}; `isAnonymousProfile` lets callers skip the profile-scoped
// GETs that can only answer 404 for it (me/nowplaying).
const WHOAMI_KEY = "ytm-whoami";
const WHOAMI_TTL_MS = 5 * 60 * 1000;
// L13 (audit v7, P3): a login/logout in another tab (or on this tab's
// Account page) left every OTHER tab's `ytm-whoami` memo (sessionStorage,
// per-tab) stale for up to WHOAMI_TTL_MS: nowPlayingSync and the account UI
// kept answering with the old profile. Two complementary fixes: login()/
// logout() now broadcast on a shared channel so any tab sharing it drops its
// memo immediately (forgetWhoami); and, as a safety net for a tab that
// missed the broadcast (opened before this build, channel unsupported), a
// `visibilitychange` back to visible re-fetches fresh when the memo is
// older than WHOAMI_VISIBLE_REFRESH_MS.
export const PROFILE_CHANNEL_NAME = "ytm-profile";
const WHOAMI_VISIBLE_REFRESH_MS = 60 * 1000;
type Who = { id: string; name: string };
// PF3-6: getRecent memo (declared before anything that may call forgetWhoami).
type RecentMemo = { at: number; limit: number; promise: Promise<{ items: any[] }> };
let recentMemo: RecentMemo | null = null;
function readWhoamiMemo(): Who | null {
	try {
		const raw = sessionStorage.getItem(WHOAMI_KEY);
		if (!raw) return null;
		const j = JSON.parse(raw);
		if (!j || typeof j !== "object" || typeof j.at !== "number" || Date.now() - j.at > WHOAMI_TTL_MS) return null;
		if (typeof j.id !== "string") return null;
		return { id: j.id, name: typeof j.name === "string" ? j.name : "" };
	} catch {
		return null;
	}
}
function whoamiMemoAgeMs(): number | null {
	try {
		const raw = sessionStorage.getItem(WHOAMI_KEY);
		if (!raw) return null;
		const j = JSON.parse(raw);
		if (!j || typeof j.at !== "number") return null;
		return Date.now() - j.at;
	} catch {
		return null;
	}
}
function writeWhoamiMemo(w: Who | null): void {
	try {
		if (!w) sessionStorage.removeItem(WHOAMI_KEY);
		else sessionStorage.setItem(WHOAMI_KEY, JSON.stringify({ id: w.id, name: w.name, at: Date.now() }));
	} catch {
		/* private mode / no sessionStorage: no memo */
	}
}
// PF4-4 (audit perf v4): the memo above only holds a SETTLED answer, so the
// parallel callers of a cold home (_PersonalRows x4, _FirstRun,
// nowPlayingSync) each sent their own GET me/whoami (4 in 160 ms). The
// pending request is shared instead; forgetWhoami (login / logout / another
// tab) drops it and bumps the generation so an answer for the previous
// profile is neither shared nor memoised.
let whoamiInflight: Promise<Who> | null = null;
let whoamiGen = 0;
/** Drop the memoised whoami (next call asks the server). */
export function forgetWhoami(): void {
	whoamiGen++;
	whoamiInflight = null;
	writeWhoamiMemo(null);
	forgetRecent(); // another profile: its history is not this one's
}

let profileChannel: BroadcastChannel | undefined;
function getProfileChannel(): BroadcastChannel | undefined {
	if (profileChannel || typeof BroadcastChannel === "undefined") return profileChannel;
	profileChannel = new BroadcastChannel(PROFILE_CHANNEL_NAME);
	// Another tab logged in/out: this tab's memo no longer describes who it
	// is talking to. nowPlayingSync listens on the same channel for its own
	// `named` flag (L14).
	profileChannel.onmessage = () => forgetWhoami();
	return profileChannel;
}
function announceProfileChange(): void {
	try {
		getProfileChannel()?.postMessage({ at: Date.now() });
	} catch {
		/* best-effort */
	}
}

let visibilityRefreshWired = false;
function wireWhoamiVisibilityRefresh(): void {
	if (visibilityRefreshWired || typeof document === "undefined") return;
	visibilityRefreshWired = true;
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		const age = whoamiMemoAgeMs();
		if (age !== null && age > WHOAMI_VISIBLE_REFRESH_MS) void whoami({ fresh: true }).catch(() => {});
	});
}
if (typeof document !== "undefined") {
	wireWhoamiVisibilityRefresh();
	getProfileChannel(); // start listening even before any login()/logout() in THIS tab
}

export async function whoami(opts: { fresh?: boolean } = {}): Promise<Who> {
	if (!opts.fresh) {
		const memo = readWhoamiMemo();
		if (memo) return memo;
	}
	// A request already on the wire answers fresh callers too: it started
	// after the memo was found missing or stale.
	if (whoamiInflight) return whoamiInflight;
	const gen = whoamiGen;
	const p: Promise<Who> = (async () => {
		const w = await (await APIClient.fetch(`/api/v1/me/whoami`)).json();
		if (gen === whoamiGen && w && typeof w === "object" && typeof w.id === "string") {
			writeWhoamiMemo({ id: w.id, name: typeof w.name === "string" ? w.name : "" });
		}
		return w;
	})();
	whoamiInflight = p;
	const settle = () => {
		if (whoamiInflight === p) whoamiInflight = null;
	};
	p.then(settle, settle);
	return p;
}
/** true when the profile is known to be anonymous (no name); false when named or when whoami fails. */
export async function isAnonymousProfile(): Promise<boolean> {
	try {
		const w = await whoami();
		return !(w && typeof w.name === "string" && w.name.trim());
	} catch {
		return false;
	}
}
// ---- c45b B7-17 (L12-8): clean login ----
// A write (play, skip, favourite, follow, playlist, now_playing) that leaves
// while POST me/login is on the wire still carries the anonymous cookie: it
// lands on the abandoned anonymous profile after the merge (orphaned; the
// server also redirects it for a while, profile_merge.go). Every write path
// below first awaits `loginSettled()`: during a login it is held, and sent
// with the named cookie once the server answered (success or failure). The
// anonymous id of the previous login is kept in localStorage (`ytm-prev-anon`)
// and sent as `prevAnon`: the server re-adopts what still landed on it, and
// only for the same name. Logout forgets it (a new person on the device).
export const PREV_ANON_KEY = "ytm-prev-anon";
/**
 * L13-5: the longest a write waits for a login on the wire. A mobile network
 * that blackholes the POST me/login would otherwise hold every write of the
 * tab for minutes (the browser's TCP timeout); past this the write goes out
 * with the current cookie (the server redirects the adopted cookie for a
 * while anyway, profile_merge.go).
 */
export const LOGIN_GATE_MAX_MS = 8_000;
let loginGate: Promise<void> | null = null;
/**
 * Resolves when no login is in progress (immediately outside a login), or
 * after `maxWaitMs` at the latest (L13-5).
 */
export function loginSettled(maxWaitMs = LOGIN_GATE_MAX_MS): Promise<void> {
	const gate = loginGate;
	if (!gate) return Promise.resolve();
	if (!(maxWaitMs > 0) || !Number.isFinite(maxWaitMs)) return gate;
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, maxWaitMs);
		void gate.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}
/** true while POST me/login is on the wire. */
export function loginInProgress(): boolean {
	return loginGate !== null;
}
function readPrevAnon(): string {
	try {
		const v = localStorage.getItem(PREV_ANON_KEY);
		return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : "";
	} catch {
		return "";
	}
}
function writePrevAnon(id: string): void {
	try {
		if (id) localStorage.setItem(PREV_ANON_KEY, id);
		else localStorage.removeItem(PREV_ANON_KEY);
	} catch {
		/* private mode */
	}
}
/**
 * 39A: the server moves this device's anonymous history onto the named
 * profile; `migrated` says what moved (null when nothing was eligible: no
 * anonymous profile, or switching between two named profiles; c45b: or
 * nothing left to move, e.g. a second login racing the first). The last
 * non-empty migration is kept for the Compte page.
 */
export async function login(name: string): Promise<{ id: string; name: string; migrated: MigratedCounts | null }> {
	// The anonymous id this device used until now (memo; no request when it
	// is missing: the cookie is what the server merges anyway).
	const before = readWhoamiMemo();
	const anonBefore = before && !before.name && !/^u-/.test(before.id) ? before.id : "";
	const prevAnon = readPrevAnon();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	loginGate = gate;
	try {
		const res = await APIClient.post(`/api/v1/me/login`, prevAnon ? { name, prevAnon } : { name });
		if (res && typeof res.ok === "boolean" && !res.ok) throw new Error(`login ${res.status}`);
		// L13-16: only once the server accepted the login (a 400 empty name or a
		// 500 used to leave the home cache empty and the whoami memo lost while
		// the profile had not changed). The gate above already holds the writes.
		forgetWhoami();
		// L8-5: the instant-home cache belongs to the previous profile; drop it so the
		// next /home never paints another profile's rows (listener lives on /home only).
		clearHomeCache(typeof localStorage === "undefined" ? undefined : localStorage);
		const r = await res.json();
		if (r && typeof r === "object" && typeof r.id === "string") writeWhoamiMemo({ id: r.id, name: typeof r.name === "string" ? r.name : "" });
		const migrated = parseMigrated(r?.migrated);
		if (r && typeof r.name === "string") rememberMigration(r.name, migrated);
		if (anonBefore) writePrevAnon(anonBefore);
		announceProfileChange();
		return { ...r, migrated };
	} finally {
		if (loginGate === gate) loginGate = null;
		release();
	}
}
/**
 * L10-8: the server call first, then the local purge and the announcement to
 * the other tabs (they reload their rows: with the old cookie still set they
 * repainted the old profile). A failure (network, non-2xx) throws and keeps
 * the session as it was; the caller tells the user.
 */
export async function logout(): Promise<Response> {
	await loginSettled();
	const r: Response = await APIClient.post(`/api/v1/me/logout`, {});
	if (!r || !r.ok) throw new Error(`logout ${r ? r.status : "failed"}`);
	forgetWhoami();
	writePrevAnon(""); // c45b: the next name on this device is someone else
	clearHomeCache(typeof localStorage === "undefined" ? undefined : localStorage);
	announceProfileChange();
	return r;
}

// ---- favorites ----
export async function getFavorites(kind?: string): Promise<{ favorites: any[]; items: any[] }> {
	const res = await APIClient.fetch(`/api/v1/me/favorites${kind ? `?kind=${kind}` : ""}`);
	return res.json();
}
export async function addFavorite(item: any) {
	await loginSettled();
	return APIClient.post(`/api/v1/me/favorites`, item);
}
export async function removeFavoriteItem(item: any) {
	const ref = itemRef(item);
	if (!ref) return;
	await loginSettled();
	return APIClient.del(`/api/v1/me/favorites?ref=${encodeURIComponent(ref)}`);
}

// ---- follows ----
export async function getFollows(): Promise<{ follows: any[] }> {
	const res = await APIClient.fetch(`/api/v1/me/follows`);
	return res.json();
}
export async function isFollowing(artistId: string): Promise<boolean> {
	try {
		const res = await APIClient.fetch(`/api/v1/me/follows?artistId=${encodeURIComponent(artistId)}`);
		return (await res.json()).following === true;
	} catch {
		return false;
	}
}
export async function follow(artistId: string, name = "", thumbnail = "") {
	await loginSettled();
	return APIClient.post(`/api/v1/me/follows`, { artistId, name, thumbnail });
}
export async function unfollow(artistId: string) {
	await loginSettled();
	return APIClient.del(`/api/v1/me/follows?artistId=${encodeURIComponent(artistId)}`);
}

// ---- play history + stats ----
// O9: one POST; a failure (network, 5xx) queues the play in the outbox
// ($lib/historyOutbox) with the client playedAt (ms), replayed on `online`
// and at startup. Offline the POST is not even tried.
// I11: a direct (online) POST carries NO playedAt, the server dates it; only
// an outbox replay sends the stored playedAt (+ clientSentAt, historyOutbox).
// c40b B6-10: the outbox also carries skips (skips.ts SKIP_MARK), sent to
// POST me/skips with their press time `at`.
async function postPlay(item: any, playedAt?: number): Promise<SendResult> {
	try {
		await loginSettled(); // c45b: never with the cookie a login is replacing
		if (isSkipItem(item)) {
			const r = await APIClient.post(`/api/v1/me/skips`, skipBody(item as any, playedAt));
			return statusResult(Number(r?.status) || 0);
		}
		const body = typeof playedAt === "number" && Number.isFinite(playedAt) ? { ...item, playedAt } : { ...item };
		const r = await APIClient.post(`/api/v1/me/history`, body);
		return statusResult(Number(r?.status) || 0);
	} catch {
		return "retry";
	}
}
export function recordHistory(item: any) {
	if (!item || !itemRef(item)) return;
	forgetRecent();
	const playedAt = Date.now();
	if (typeof navigator !== "undefined" && navigator.onLine === false) {
		enqueuePlay(item, playedAt);
		return Promise.resolve();
	}
	return postPlay(item).then((r) => {
		if (r === "retry") enqueuePlay(item, playedAt);
		else if (r === "ok" && readOutbox().length) void flushOutbox(postPlay);
	});
}
/**
 * c40b B6-10: a user "next" press on `track` at `position` / `duration`
 * (seconds). Early presses (skips.ts isSkip) are queued like plays: POST
 * me/skips now, the outbox when offline or failing. Late presses: nothing.
 */
export function recordSkip(track: any, position: number, duration: number, source: SkipSource): boolean {
	const item = skipItem(track, position, duration, source);
	if (!item) return false;
	const at = Date.now();
	if (typeof navigator !== "undefined" && navigator.onLine === false) {
		enqueuePlay(item, at);
		return true;
	}
	void postPlay(item, at).then((r) => {
		if (r === "retry") enqueuePlay(item, at);
	});
	return true;
}
if (typeof window !== "undefined") installHistoryOutbox(postPlay);
// PF3-6 (audit perf v3): a cold /home asked me/stats/recent twice
// (FirstRun limit 1, PersonalRows limit 30), three times with the search
// overlay. One request is shared for RECENT_MEMO_MS by every caller whose
// limit fits; small limits are fetched as RECENT_MIN_FETCH so the first
// caller's request also serves the bigger ones. recordHistory and a profile
// change drop the memo.
export const RECENT_MEMO_MS = 5000;
export const RECENT_MIN_FETCH = 30;
export function forgetRecent(): void {
	recentMemo = null;
}
export async function getRecent(limit = 50): Promise<{ items: any[] }> {
	const now = Date.now();
	let memo = recentMemo;
	if (!memo || now - memo.at > RECENT_MEMO_MS || memo.limit < limit) {
		const fetchLimit = Math.max(limit, RECENT_MIN_FETCH);
		const promise: Promise<{ items: any[] }> = APIClient.fetch(`/api/v1/me/stats/recent?limit=${fetchLimit}`).then((r) => r.json());
		const mine: RecentMemo = { at: now, limit: fetchLimit, promise };
		memo = mine;
		recentMemo = mine;
		promise.catch(() => {
			if (recentMemo === mine) recentMemo = null; // never memoise a failure
		});
	}
	const r = await memo.promise;
	if (r && Array.isArray(r.items) && r.items.length > limit) return { ...r, items: r.items.slice(0, limit) };
	return r;
}
export async function getTop(limit = 50): Promise<{ items: any[]; counts: any[] }> {
	return (await APIClient.fetch(`/api/v1/me/stats/top?limit=${limit}`)).json();
}

// ---- S1 "Ton mois" ----
export type TopBy = "tracks" | "artists" | "albums";
export interface TopRow {
	key: string;
	title: string;
	artist?: string;
	artistId?: string;
	count: number;
	item?: any; // tracks only: the stored item, renderable with <Listing>
}
export interface StatsSummary {
	days: number;
	plays: number;
	minutes: number;
	estimated: boolean;
	distinctTracks: number;
	distinctArtists: number;
	topHour: number; // -1 when there are no plays
	local: number;
	youtube: number;
	hours: number[]; // 24 buckets, viewer's local time
}
/** Top tracks / artists / albums over the last `days` days (0 = all time). */
export async function getTopBy(by: TopBy, days = 30, limit = 20): Promise<{ by: TopBy; days: number; rows: TopRow[] }> {
	return (await APIClient.fetch(`/api/v1/me/stats/top?by=${by}&days=${days}&limit=${limit}`)).json();
}
/** Listening summary over the last `days` days; the hour histogram is in the viewer's local time. */
export async function getStatsSummary(days = 30): Promise<StatsSummary> {
	const tz = -new Date().getTimezoneOffset();
	return (await APIClient.fetch(`/api/v1/me/stats/summary?days=${days}&tz=${tz}`)).json();
}
export async function getMix(): Promise<{ items: any[]; seeds: number }> {
	return (await APIClient.fetch(`/api/v1/me/mix`)).json();
}

// ---- playlists ----
export async function getPlaylists(): Promise<{ playlists: any[] }> {
	return (await APIClient.fetch(`/api/v1/me/playlists`)).json();
}
export async function createPlaylist(name: string, description = "") {
	await loginSettled();
	return (await APIClient.post(`/api/v1/me/playlists`, { name, description })).json();
}
export async function getPlaylist(id: number | string): Promise<{ playlist: any; tracks: any[] }> {
	return (await APIClient.fetch(`/api/v1/me/playlists/${id}`)).json();
}
export async function addToPlaylist(id: number | string, item: any) {
	await loginSettled();
	return APIClient.post(`/api/v1/me/playlists/${id}/items`, item);
}
export async function deletePlaylist(id: number | string) {
	await loginSettled();
	return APIClient.del(`/api/v1/me/playlists/${id}`);
}
export async function removeFromPlaylist(id: number | string, item: any) {
	const ref = itemRef(item);
	if (!ref) return;
	await loginSettled();
	return APIClient.del(`/api/v1/me/playlists/${id}/items?ref=${encodeURIComponent(ref)}`);
}

// ---- C2 multi-device resume (me/nowplaying) ----
export interface NowPlayingRow {
	deviceId: string;
	deviceName: string;
	position: number; // seconds
	payload: any; // C1 resume state (slim)
	updatedAt: number; // unix ms (server clock)
	takenBy?: string; // 40A: device that pressed "Continuer ici"
	takenAt?: number; // unix ms (server clock)
	/** L12-9: the server clock at the answer (unix ms), the reference for takenAt / updatedAt. */
	now?: number;
}
/**
 * Upsert this device's resume state; resolves the HTTP status (0 = network
 * error). 40A: `takenBy` (= deviceId) takes the playback over; a 409 answer
 * carries the device that holds it (`takenBy`, `deviceName`).
 */
export async function putNowPlaying(
	body: { deviceId: string; deviceName: string; position: number; payload: unknown; takenBy?: string; takenAt?: number },
	keepalive = false,
): Promise<{ status: number; takenBy?: string; deviceName?: string }> {
	try {
		// c45b: the resume state follows the named profile. L13-5: not the
		// keepalive push (pagehide: the page is going away, there is no time
		// to wait; the server redirects an adopted cookie for a while).
		if (!keepalive) await loginSettled();
		const r = await APIClient.fetch(`/api/v1/me/nowplaying`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			keepalive,
		});
		const status = Number(r?.status) || 0;
		if (status !== 409) return { status };
		const j = await r.json().catch(() => null);
		return {
			status,
			takenBy: typeof j?.takenBy === "string" ? j.takenBy : undefined,
			deviceName: typeof j?.deviceName === "string" ? j.deviceName : undefined,
		};
	} catch {
		return { status: 0 };
	}
}
/** The profile's last resume state from any device; null when none (404) or on error. */
export async function getNowPlaying(): Promise<NowPlayingRow | null> {
	try {
		// 40A: re-read on every foreground refresh, never from the HTTP cache.
		const r = await APIClient.fetch(`/api/v1/me/nowplaying`, { cache: "no-store" });
		if (!r?.ok) return null;
		const j = await r.json();
		if (!j || typeof j !== "object" || !j.payload) return null;
		const row = j as NowPlayingRow;
		// L12-9: the server clock comes with the row (`now`); an older server
		// gives at least its `Date` header. Without either, the caller falls
		// back to the local clock.
		if (typeof row.now !== "number" || !isFinite(row.now) || row.now <= 0) {
			const d = Date.parse(r.headers?.get?.("Date") ?? "");
			if (isFinite(d) && d > 0) row.now = d;
			else delete row.now;
		}
		return row;
	} catch {
		return null;
	}
}
