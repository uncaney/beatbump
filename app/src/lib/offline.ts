// Offline downloads: resolve a track's playable audio URL, hand it to the service
// worker to cache (full response), and remember it in localStorage so it plays
// when the device is offline. Pairs with src/service-worker.ts (cache-audio msg).
import { APIClient } from "$lib/api";

const KEY = "ytm-offline-tracks";

function read(): any[] {
	try {
		return JSON.parse(localStorage.getItem(KEY) || "[]");
	} catch {
		return [];
	}
}
function write(list: any[]) {
	localStorage.setItem(KEY, JSON.stringify(list));
}

export function getOfflineTracks(): any[] {
	return read();
}
export function isDownloaded(videoId: string): boolean {
	return read().some((t) => t.videoId === videoId);
}

async function resolveAudioUrl(lid: string): Promise<string> {
	try {
		const p = await (await APIClient.fetch(`/api/v1/player.json?videoId=${lid}`)).json();
		const fmts = (p && p.streamingData && p.streamingData.adaptiveFormats) || [];
		const audio = fmts.find((f: any) => /audio/i.test(f.mimeType || "") && f.url) || fmts[0];
		return (audio && audio.url) || "";
	} catch {
		return "";
	}
}

export async function downloadForOffline(item: any): Promise<{ ok: boolean; reason?: string }> {
	const lid = item && item.videoId;
	if (!lid) return { ok: false, reason: "no id" };
	if (!("serviceWorker" in navigator)) return { ok: false, reason: "no service worker support" };
	const url = await resolveAudioUrl(lid);
	if (!url) return { ok: false, reason: "no stream url" };
	const reg = await navigator.serviceWorker.ready.catch(() => null);
	const ctrl = navigator.serviceWorker.controller || (reg && reg.active);
	if (!ctrl) return { ok: false, reason: "service worker not active yet" };
	ctrl.postMessage({ type: "cache-audio", url });
	const list = read().filter((t) => t.videoId !== lid);
	list.unshift({ ...item, _offlineUrl: url, _at: Date.now() });
	write(list);
	return { ok: true };
}

export function removeOffline(item: any) {
	const lid = item && item.videoId;
	const t = read().find((x) => x.videoId === lid);
	const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
	if (t && t._offlineUrl && ctrl) ctrl.postMessage({ type: "uncache-audio", url: t._offlineUrl });
	write(read().filter((x) => x.videoId !== lid));
}
