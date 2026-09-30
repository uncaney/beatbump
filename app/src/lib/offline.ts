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

export function isIOS(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent || "";
	// iPhone/iPod, plus iPadOS which now reports as Mac but has touch
	return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
}

export async function downloadForOffline(item: any): Promise<{ ok: boolean; reason?: string; fellBack?: boolean }> {
	const lid = item && item.videoId;
	if (!lid) return { ok: false, reason: "no id" };

	const url = await resolveAudioUrl(lid);
	if (!url) return { ok: false, reason: "no stream url" };
	const isLocal = /\/localf\b/.test(url);

	// Service-worker offline cache (works on macOS/Chrome/Android). iOS Safari/Brave
	// in private mode or an in-app webview exposes no serviceWorker → degrade.
	const swReady =
		"serviceWorker" in navigator
			? await navigator.serviceWorker.ready.then((r) => navigator.serviceWorker.controller || (r && r.active)).catch(() => null)
			: null;

	if (swReady) {
		swReady.postMessage({ type: "cache-audio", url });
		const list = read().filter((t) => t.videoId !== lid);
		list.unshift({ ...item, _offlineUrl: url, _at: Date.now() });
		write(list);
		return { ok: true };
	}

	// No usable service worker. If we own the file locally, save it straight to the
	// device (Fichiers on iOS) — that survives offline without the SW. Otherwise be honest.
	if (isLocal) {
		const r = await downloadToDevice(item);
		if (r.ok) return { ok: true, fellBack: true };
		return r;
	}
	if (isIOS()) {
		return {
			ok: false,
			reason:
				"Sauvegarde hors-ligne indisponible ici (Safari/Brave privé ou navigateur intégré). Ajoute music.ekaii.fr à l'écran d'accueil et ouvre-la depuis l'app, ou suis l'artiste pour l'acquérir en local.",
		};
	}
	return { ok: false, reason: "service worker indisponible — recharge la page ou ajoute le site à l'écran d'accueil" };
}

function sanitizeName(s: string): string {
	return (s || "").replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}
function trackFilename(item: any, url: string): string {
	const title = sanitizeName(item && item.title);
	const artist = sanitizeName((item && item.artistInfo && item.artistInfo.artist && item.artistInfo.artist[0] && item.artistInfo.artist[0].text) || (item && item.artist) || "");
	const base = artist && title ? artist + " - " + title : title || (item && item.videoId) || "track";
	const m = /\.(opus|webm|m4a|mp3|ogg)(\b|$)/i.exec(url);
	const ext = m ? m[1].toLowerCase() : "opus";
	return base + "." + ext;
}
function triggerAnchor(href: string, name: string) {
	const a = document.createElement("a");
	a.href = href;
	a.download = name;
	a.rel = "noopener";
	document.body.appendChild(a);
	a.click();
	a.remove();
}

// Real on-device download: saves the actual audio file to the device.
// Owned/local tracks use the bridge's dl=1 (Content-Disposition) fast path.
// A track not yet in the library resolves to a residential-proxied /vp stream
// (CORS-enabled) which we fetch as a blob and save anyway — never a dead-end.
// resolveAudioUrl() above already nudged yubal to acquire a tagged copy so a
// later download hits the fast /localf path.
export async function downloadToDevice(item: any): Promise<{ ok: boolean; reason?: string; fellBack?: boolean }> {
	const lid = item && item.videoId;
	if (!lid) return { ok: false, reason: "no id" };
	const url = await resolveAudioUrl(lid);
	if (!url) return { ok: false, reason: "no stream url" };

	// Local library file -> bridge force-download (fast, correct filename).
	if (/\/localf\b/.test(url)) {
		const dlUrl = url + (url.includes("?") ? "&" : "?") + "dl=1";
		triggerAnchor(dlUrl, "");
		return { ok: true };
	}

	// Not local yet -> fetch the /vp stream as a blob and save it, so the button
	// still produces a real, offline-playable file on the device.
	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error("stream " + res.status);
		const blob = await res.blob();
		if (!blob || blob.size === 0) throw new Error("empty");
		const objUrl = URL.createObjectURL(blob);
		triggerAnchor(objUrl, trackFilename(item, url));
		setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
		return { ok: true, fellBack: true };
	} catch {
		// Couldn't stream it right now — it's being acquired to the library
		// (player resolution enqueues it); ask the user to retry shortly.
		return { ok: false, reason: "acquisition en cours — réessaie dans un instant" };
	}
}

export function removeOffline(item: any) {
	const lid = item && item.videoId;
	const t = read().find((x) => x.videoId === lid);
	const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
	if (t && t._offlineUrl && ctrl) ctrl.postMessage({ type: "uncache-audio", url: t._offlineUrl });
	write(read().filter((x) => x.videoId !== lid));
}
