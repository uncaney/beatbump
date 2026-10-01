// Client helpers for the server-side profile state (favorites / follows / playlists).
// The bbp profile cookie is set + carried automatically (credentials:'same-origin').
import { APIClient } from "$lib/api";
import { clearHomeCache } from "$lib/homeCache";
import { enqueuePlay, flushOutbox, installHistoryOutbox, readOutbox, statusResult, type SendResult } from "$lib/historyOutbox";

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
/** Drop the memoised whoami (next call asks the server). */
export function forgetWhoami(): void {
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
	const w = await (await APIClient.fetch(`/api/v1/me/whoami`)).json();
	if (w && typeof w === "object" && typeof w.id === "string") {
		writeWhoamiMemo({ id: w.id, name: typeof w.name === "string" ? w.name : "" });
	}
	return w;
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
export async function login(name: string): Promise<{ id: string; name: string }> {
	forgetWhoami();
	// L8-5: the instant-home cache belongs to the previous profile; drop it so the
	// next /home never paints another profile's rows (listener lives on /home only).
	clearHomeCache(typeof localStorage === "undefined" ? undefined : localStorage);
	const r = await (await APIClient.post(`/api/v1/me/login`, { name })).json();
	if (r && typeof r === "object" && typeof r.id === "string") writeWhoamiMemo({ id: r.id, name: typeof r.name === "string" ? r.name : "" });
	announceProfileChange();
	return r;
}
/**
 * L10-8: the server call first, then the local purge and the announcement to
 * the other tabs (they reload their rows: with the old cookie still set they
 * repainted the old profile). A failure (network, non-2xx) throws and keeps
 * the session as it was; the caller tells the user.
 */
export async function logout(): Promise<Response> {
	const r: Response = await APIClient.post(`/api/v1/me/logout`, {});
	if (!r || !r.ok) throw new Error(`logout ${r ? r.status : "failed"}`);
	forgetWhoami();
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
	return APIClient.post(`/api/v1/me/favorites`, item);
}
export async function removeFavoriteItem(item: any) {
	const ref = itemRef(item);
	if (!ref) return;
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
	return APIClient.post(`/api/v1/me/follows`, { artistId, name, thumbnail });
}
export async function unfollow(artistId: string) {
	return APIClient.del(`/api/v1/me/follows?artistId=${encodeURIComponent(artistId)}`);
}

// ---- play history + stats ----
// O9: one POST; a failure (network, 5xx) queues the play in the outbox
// ($lib/historyOutbox) with the client playedAt (ms), replayed on `online`
// and at startup. Offline the POST is not even tried.
// I11: a direct (online) POST carries NO playedAt, the server dates it; only
// an outbox replay sends the stored playedAt (+ clientSentAt, historyOutbox).
async function postPlay(item: any, playedAt?: number): Promise<SendResult> {
	try {
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
	return (await APIClient.post(`/api/v1/me/playlists`, { name, description })).json();
}
export async function getPlaylist(id: number | string): Promise<{ playlist: any; tracks: any[] }> {
	return (await APIClient.fetch(`/api/v1/me/playlists/${id}`)).json();
}
export async function addToPlaylist(id: number | string, item: any) {
	return APIClient.post(`/api/v1/me/playlists/${id}/items`, item);
}
export async function deletePlaylist(id: number | string) {
	return APIClient.del(`/api/v1/me/playlists/${id}`);
}
export async function removeFromPlaylist(id: number | string, item: any) {
	const ref = itemRef(item);
	if (!ref) return;
	return APIClient.del(`/api/v1/me/playlists/${id}/items?ref=${encodeURIComponent(ref)}`);
}

// ---- C2 multi-device resume (me/nowplaying) ----
export interface NowPlayingRow {
	deviceId: string;
	deviceName: string;
	position: number; // seconds
	payload: any; // C1 resume state (slim)
	updatedAt: number; // unix ms (server clock)
}
/** Upsert this device's resume state; resolves the HTTP status (0 = network error). */
export async function putNowPlaying(
	body: { deviceId: string; deviceName: string; position: number; payload: unknown },
	keepalive = false,
): Promise<number> {
	try {
		const r = await APIClient.fetch(`/api/v1/me/nowplaying`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			keepalive,
		});
		return Number(r?.status) || 0;
	} catch {
		return 0;
	}
}
/** The profile's last resume state from any device; null when none (404) or on error. */
export async function getNowPlaying(): Promise<NowPlayingRow | null> {
	try {
		const r = await APIClient.fetch(`/api/v1/me/nowplaying`);
		if (!r?.ok) return null;
		const j = await r.json();
		return j && typeof j === "object" && j.payload ? (j as NowPlayingRow) : null;
	} catch {
		return null;
	}
}
