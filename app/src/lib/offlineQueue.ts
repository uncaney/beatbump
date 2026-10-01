/* eslint-disable @typescript-eslint/no-explicit-any */
// Offline queue helpers for the Offline library page.
//
// Pure functions over the cached-track list (localStorage `ytm-offline-tracks`,
// see $lib/offline: each entry is the Beatbump track item enriched with
// `_offlineUrl` (audio URL cached by the service worker) and `_at`; lane A2 may
// add `_cached` / `_bytes`, both optional) plus a `play()` that starts playback
// through the existing session list with `localUrl` set on every item, so the
// player (getSrc in $lib/player) never touches the network. Everything here
// works with `navigator.onLine === false`.

export type OfflineTrack = any;

export interface AlbumGroup {
	key: string;
	name: string;
	artist: string;
	artistKey: string;
	browseId?: string;
	thumbnail: string;
	tracks: OfflineTrack[];
	isSingles: boolean;
	bytes?: number;
}

export interface ArtistGroup {
	key: string;
	name: string;
	browseId?: string;
	thumbnail: string;
	tracks: OfflineTrack[];
	albums: AlbumGroup[];
	bytes?: number;
}

export interface MixtapeOptions {
	avoidSameArtistInARow?: boolean;
	maxPerArtist?: number;
	seed?: number;
}

const UNKNOWN_ARTIST = "Artiste inconnu";
const SINGLES = "Singles";
const ALBUM_ID_RE = /^(lb-|OLAK|MPRE|VL)/;

function norm(s: unknown): string {
	return String(s ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.join(" ");
}

function firstString(...vals: unknown[]): string {
	for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
	return "";
}

// ---- metadata accessors (tolerant to every item shape we have seen) ----

export function artistName(t: OfflineTrack): string {
	const sub = Array.isArray(t?.subtitle) ? t.subtitle : [];
	const subArtist = sub.find((s: any) => s && /ARTIST/.test(s.pageType || "") && s.text);
	return (
		firstString(
			t?.artistInfo?.artist?.[0]?.text,
			subArtist?.text,
			typeof t?.artist === "string" ? t.artist : "",
			t?.artist?.text,
			t?.albumArtist,
			sub.find((s: any) => s && s.text && !s.pageType)?.text,
		) || UNKNOWN_ARTIST
	);
}

export function artistId(t: OfflineTrack): string | undefined {
	const sub = Array.isArray(t?.subtitle) ? t.subtitle : [];
	return (
		t?.artistInfo?.artist?.[0]?.browseId ||
		t?.artistInfo?.browseId ||
		sub.find((s: any) => s && /ARTIST/.test(s.pageType || "") && s.browseId)?.browseId ||
		undefined
	);
}

/** Album metadata if the item carries any; null means "no album known". */
export function albumInfo(t: OfflineTrack): { name: string; browseId?: string } | null {
	const a = t?.album;
	if (a && typeof a === "object") {
		const name = firstString(a.text, a.title, a.name);
		const id = firstString(a.browseId, a.id);
		if (name || id) return { name, browseId: id || undefined };
	}
	const strName = firstString(typeof a === "string" ? a : "", t?.albumName, t?._album, t?.albumTitle);
	if (strName) return { name: strName, browseId: firstString(t?.albumId, t?._albumId) || undefined };
	const sub = Array.isArray(t?.subtitle) ? t.subtitle : [];
	const run = sub.find((s: any) => s && /ALBUM/.test(s.pageType || "") && (s.text || s.browseId));
	if (run) return { name: firstString(run.text), browseId: firstString(run.browseId) || undefined };
	const pid = typeof t?.playlistId === "string" ? t.playlistId : "";
	if (pid && ALBUM_ID_RE.test(pid)) return { name: "", browseId: pid };
	return null;
}

export function thumbnailOf(t: OfflineTrack): string {
	const th = Array.isArray(t?.thumbnails) ? t.thumbnails : [];
	const first = th.find((x: any) => x && typeof x.url === "string" && x.url);
	return first ? first.url : "";
}

export function bytesOf(t: OfflineTrack): number | undefined {
	const b = t?._bytes;
	return typeof b === "number" && Number.isFinite(b) && b >= 0 ? b : undefined;
}

/** Sum of `_bytes`; undefined when no track carries a size (lane A2 field). */
export function totalBytes(tracks: OfflineTrack[]): number | undefined {
	let sum = 0;
	let seen = false;
	for (const t of tracks || []) {
		const b = bytesOf(t);
		if (b !== undefined) {
			sum += b;
			seen = true;
		}
	}
	return seen ? sum : undefined;
}

export function formatBytes(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "";
	const units = ["o", "Ko", "Mo", "Go", "To"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
	return `${v.toFixed(digits).replace(".", ",")} ${units[i]}`;
}

function trackNumber(t: OfflineTrack): number {
	const n = Number(t?.index);
	return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

function cachedAt(t: OfflineTrack): number {
	const n = Number(t?._at);
	return Number.isFinite(n) ? n : 0;
}

// ---- grouping ----

/**
 * Group tracks by album. Key = album browseId, else normalised album name +
 * artist, else the artist's "Singles" bucket. Album tracks are ordered by track
 * number when known, singles newest-cached first. Albums are ordered by most
 * recently cached track.
 */
/** Canonical album key: local album refs may carry a ".<hint>" suffix (see
 *  backend localAlbumRef); the group key ignores it so old and new cached tracks merge. */
function albumKeyOf(browseId: string): string {
	return browseId.startsWith("lb-") ? browseId.split(".")[0] : browseId;
}

export function groupByAlbum(tracks: OfflineTrack[]): AlbumGroup[] {
	const map = new Map<string, AlbumGroup>();
	for (const t of tracks || []) {
		if (!t) continue;
		const artist = artistName(t);
		const artistKey = artistId(t) || "name:" + norm(artist);
		const info = albumInfo(t);
		let key: string;
		let name: string;
		let isSingles = false;
		if (info && info.browseId) {
			key = "id:" + albumKeyOf(info.browseId);
			name = info.name || "Album";
		} else if (info && info.name) {
			key = "name:" + norm(info.name) + "|" + norm(artist);
			name = info.name;
		} else {
			key = "singles:" + artistKey;
			name = SINGLES;
			isSingles = true;
		}
		let g = map.get(key);
		if (!g) {
			g = {
				key,
				name,
				artist,
				artistKey,
				browseId: info?.browseId,
				thumbnail: thumbnailOf(t),
				tracks: [],
				isSingles,
			};
			map.set(key, g);
		} else {
			if (!g.thumbnail) g.thumbnail = thumbnailOf(t);
			if (g.name === "Album" && info?.name) g.name = info.name;
		}
		g.tracks.push(t);
	}
	const groups = [...map.values()];
	for (const g of groups) {
		g.tracks = g.isSingles
			? g.tracks.slice().sort((a, b) => cachedAt(b) - cachedAt(a))
			: g.tracks.slice().sort((a, b) => trackNumber(a) - trackNumber(b) || cachedAt(b) - cachedAt(a));
		g.bytes = totalBytes(g.tracks);
	}
	const latest = (g: AlbumGroup) => Math.max(0, ...g.tracks.map(cachedAt));
	groups.sort((a, b) => latest(b) - latest(a));
	return groups;
}

/** Group tracks by artist (with their albums nested), most recently cached first. */
export function groupByArtist(tracks: OfflineTrack[]): ArtistGroup[] {
	const map = new Map<string, ArtistGroup>();
	for (const t of tracks || []) {
		if (!t) continue;
		const name = artistName(t);
		const key = artistId(t) || "name:" + norm(name);
		let g = map.get(key);
		if (!g) {
			g = { key, name, browseId: artistId(t), thumbnail: thumbnailOf(t), tracks: [], albums: [] };
			map.set(key, g);
		} else if (!g.thumbnail) g.thumbnail = thumbnailOf(t);
		g.tracks.push(t);
	}
	const groups = [...map.values()];
	for (const g of groups) {
		g.tracks = g.tracks.slice().sort((a, b) => cachedAt(b) - cachedAt(a));
		g.albums = groupByAlbum(g.tracks);
		g.bytes = totalBytes(g.tracks);
	}
	const latest = (g: ArtistGroup) => Math.max(0, ...g.tracks.map(cachedAt));
	groups.sort((a, b) => latest(b) - latest(a));
	return groups;
}

// ---- ordering ----

function rng(seed?: number): () => number {
	if (typeof seed !== "number" || !Number.isFinite(seed)) return Math.random;
	// mulberry32: small, deterministic, good enough for a shuffle
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher-Yates shuffle into a NEW array; deterministic when `seed` is given. */
export function shuffle<T>(tracks: T[], seed?: number): T[] {
	const out = (tracks || []).slice();
	const rand = rng(seed);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

/**
 * Mixtape: shuffle, cap tracks per artist, and interleave artists so the same
 * artist is not played twice in a row whenever the pool allows it.
 */
export function mixtape(tracks: OfflineTrack[], opts: MixtapeOptions = {}): OfflineTrack[] {
	const { avoidSameArtistInARow = true, maxPerArtist, seed } = opts;
	const rand = rng(seed);
	const seedFor = (i: number) => (typeof seed === "number" ? seed + i + 1 : undefined);

	const buckets = new Map<string, OfflineTrack[]>();
	for (const t of tracks || []) {
		if (!t) continue;
		const k = artistId(t) || "name:" + norm(artistName(t));
		const b = buckets.get(k);
		if (b) b.push(t);
		else buckets.set(k, [t]);
	}
	let pools = [...buckets.entries()].map(([k, list], i) => {
		let l = shuffle(list, seedFor(i));
		if (typeof maxPerArtist === "number" && maxPerArtist > 0) l = l.slice(0, maxPerArtist);
		return { k, list: l };
	});
	pools = shuffle(pools, seedFor(pools.length));

	if (!avoidSameArtistInARow) return shuffle(pools.flatMap((p) => p.list), seedFor(pools.length + 1));

	const out: OfflineTrack[] = [];
	let last = "";
	while (pools.some((p) => p.list.length)) {
		const candidates = pools.filter((p) => p.list.length && p.k !== last);
		const source = candidates.length ? candidates : pools.filter((p) => p.list.length);
		const max = Math.max(...source.map((p) => p.list.length));
		const top = source.filter((p) => p.list.length === max);
		const pick = top[Math.floor(rand() * top.length)];
		out.push(pick.list.shift());
		last = pick.k;
	}
	return out;
}

/** The `n` most recently cached tracks (by `_at`). */
export function recentlyCached(tracks: OfflineTrack[], n: number): OfflineTrack[] {
	const sorted = (tracks || []).filter(Boolean).slice().sort((a, b) => cachedAt(b) - cachedAt(a));
	return n >= 0 ? sorted.slice(0, n) : sorted;
}

// ---- playback ----

/**
 * Clone every item with `localUrl` = its cached audio URL so getSrc() plays it
 * without any request. Only tracks that are really cached are kept: `_cached
 * === true`, or confirmed by the service worker (`confirmed`: videoId -> cached
 * URL, from `list-audio`). A `/vp` (signed, expiring) URL that is not cached is
 * never handed to the player. Returns [] when nothing is playable (never throws).
 */
export function toPlayableItems(tracks: OfflineTrack[], confirmed?: Map<string, string> | Set<string>): OfflineTrack[] {
	const out: OfflineTrack[] = [];
	for (const t of tracks || []) {
		if (!t || !t.videoId) continue;
		let url = firstString(t._offlineUrl, t.localUrl);
		let ok = t._cached === true;
		if (confirmed) {
			if (confirmed instanceof Map) {
				const u = confirmed.get(t.videoId);
				if (u !== undefined) {
					ok = true;
					if (u) url = u;
				}
			} else if (confirmed.has(t.videoId)) ok = true;
		}
		if (!ok || !url) continue;
		out.push({ ...t, localUrl: url });
	}
	return out;
}

/**
 * Start playback of `items` at `startIndex` through the app's session list:
 * SessionListService.setMix(items, "local") + updatePosition + getSrc, i.e. the
 * same "local" path the store already supports (next()/previous() then stay on
 * localUrl, no continuation fetch). With `shuffle`, the clicked track plays
 * first and the rest is shuffled. Returns false when nothing is playable (the
 * page then shows its empty state; nothing is thrown).
 * Cached-ness is confirmed with the service worker (`list-audio`) when it
 * answers; otherwise `_cached === true` from the list is trusted.
 */
export async function play(
	items: OfflineTrack[],
	startIndex = 0,
	opts: { shuffle?: boolean; confirmed?: Map<string, string> } = {},
): Promise<boolean> {
	let confirmed = opts.confirmed;
	if (!confirmed) {
		try {
			const { listCachedAudio } = await import("$lib/offline");
			const l = await listCachedAudio();
			if (l && Array.isArray(l.entries)) {
				confirmed = new Map<string, string>();
				for (const e of l.entries) if (e.videoId) confirmed.set(e.videoId, e.url || "");
			}
		} catch {
			confirmed = undefined;
		}
	}
	let list = toPlayableItems(items, confirmed);
	if (!list.length) return false;
	// The clicked track must stay the start; map startIndex through the filter.
	const wanted = items?.[startIndex]?.videoId;
	const mapped = wanted ? list.findIndex((t) => t.videoId === wanted) : -1;
	let idx = mapped >= 0 ? mapped : Math.min(Math.max(0, startIndex | 0), list.length - 1);
	if (opts.shuffle) {
		const first = list[idx];
		list = [first, ...shuffle(list.filter((_, i) => i !== idx))];
		idx = 0;
	}
	// Dynamic imports keep this module free of player/DOM side effects for tests.
	const [{ default: SessionListService }, { getSrc }] = await Promise.all([
		import("$lib/stores/list"),
		import("$lib/player"),
	]);
	await SessionListService.setMix(list, "local");
	await SessionListService.updatePosition(idx);
	const t = list[idx];
	await getSrc(t.videoId, t.playlistId, undefined, true);
	return true;
}
