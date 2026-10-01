// Client helpers for the server-side profile state (favorites / follows / playlists).
// The bbp profile cookie is set + carried automatically (credentials:'same-origin').
import { APIClient } from "$lib/api";

function itemRef(item: any): string {
	return item?.videoId || item?.endpoint?.browseId || item?.browseId || "";
}

// ---- account (named profiles) ----
export async function whoami(): Promise<{ id: string; name: string }> {
	return (await APIClient.fetch(`/api/v1/me/whoami`)).json();
}
export async function login(name: string): Promise<{ id: string; name: string }> {
	return (await APIClient.post(`/api/v1/me/login`, { name })).json();
}
export async function logout() {
	return APIClient.post(`/api/v1/me/logout`, {});
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
export function recordHistory(item: any) {
	if (!item || !itemRef(item)) return;
	return APIClient.post(`/api/v1/me/history`, item).catch(() => {});
}
export async function getRecent(limit = 50): Promise<{ items: any[] }> {
	return (await APIClient.fetch(`/api/v1/me/stats/recent?limit=${limit}`)).json();
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
