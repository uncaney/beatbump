// HL5 Android "Partager vers" (manifest share_target, GET /share-target?title
// &text&url): turn whatever the sharing app handed over (a YouTube / YouTube
// Music link, a youtu.be short link, one of our own /listen or /watch links,
// or free text containing one) into an in-app route. Pure: the route page
// calls it and `goto`s the result, or shows "Lien non reconnu".
//
// UX10 (cycle 35): the start time of a link (`youtu.be/<id>?t=1m30s`, `&t=`,
// `start=`) goes through to `/listen?id=&t=<seconds>`; scheme-less links
// (`music.youtube.com/playlist?list=…`) are read too; a YouTube Music album
// (`browse/MPREb_…`) opens `/release?id=`, or its local twin when the
// library owns it (resolveShareHref + local/albums/match); a title shared
// with no YouTube link ("Artiste - Titre", or a Spotify / Deezer / Apple
// Music link whose readable part is known) opens `/search/<text>?filter=songs`.

export type SharedTarget =
	| { kind: "track"; id: string; list?: string; t?: number; href: string }
	| { kind: "playlist"; id: string; href: string }
	| { kind: "album"; id: string; href: string }
	| { kind: "search"; query: string; href: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const ALBUM_ID = /^MPREb_[A-Za-z0-9_-]{5,}$/;
/** L10-12: our own local album ids (shareLink "Partager" of a local album: /release?id=lb-…); same regex as og_preview.go. */
const LOCAL_ALBUM_ID = /^lb-[0-9a-f]{12}(\.[A-Za-z0-9_-]+)?$/;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
/** YouTube links shared without a scheme ("music.youtube.com/playlist?list=…"). */
const BARE_YT_RE = /(?:^|[\s(«"'])((?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>"'»)]+)/gi;
const TRAILING_PUNCT = /[.,;:!?)\]»]+$/;
/** Music services whose links never carry a YouTube id: the shared title is searched instead. */
const MUSIC_HOST = /(^|\.)(spotify\.com|spotify\.link|spoti\.fi|deezer\.com|deezer\.page\.link|dzr\.page\.link|music\.apple\.com|itunes\.apple\.com|tidal\.com|soundcloud\.com|qobuz\.com|bandcamp\.com|song\.link|album\.link|odesli\.co)$|(^|\.)music\.amazon\.[a-z.]+$/;
const SERVICES = "spotify|deezer|apple music|itunes|tidal|soundcloud|qobuz|amazon music|bandcamp|youtube music|youtube";
/** Longest search query built from a share. */
export const SHARE_QUERY_MAX = 120;

function clean(s: unknown): string {
	return typeof s === "string" ? s.trim() : "";
}

/** The first http(s) URL found in `s` (a shared text often wraps the link in a sentence). */
export function firstUrl(s: string): string {
	const m = clean(s).match(URL_RE);
	return m ? m[0].replace(/[.,;:)\]]+$/, "") : "";
}

/** Every link of `s`: http(s) URLs, then scheme-less YouTube links (prefixed with https://). */
export function urlsIn(s: string): string[] {
	const t = clean(s);
	const out: string[] = [];
	for (const m of t.match(URL_RE) || []) out.push(m.replace(TRAILING_PUNCT, ""));
	const noScheme = t.replace(URL_RE, " ");
	for (const m of noScheme.matchAll(BARE_YT_RE)) out.push("https://" + m[1].replace(TRAILING_PUNCT, ""));
	return out;
}

/** Seconds of a YouTube start time: "90", "90s", "1m30s", "1h2m3s"; undefined when absent / invalid / 0. */
export function parseStartTime(raw: string | null | undefined): number | undefined {
	const s = clean(raw).toLowerCase();
	if (!s) return undefined;
	let n: number;
	if (/^\d+s?$/.test(s)) n = parseInt(s, 10);
	else {
		const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(s);
		if (!m || !(m[1] || m[2] || m[3])) return undefined;
		n = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
	}
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Longest start offset honoured on /listen (12 h); beyond, the link starts at 0. */
export const LISTEN_START_MAX = 12 * 3600;

/**
 * L10-2: start offset of a `/listen?id=…&t=…` page (the share target writes
 * seconds; "1m30s" and `start=` are read too). undefined = start at 0. The
 * player clamps again against the real duration (resume seek: `t < duration - 2`).
 */
export function listenStartTime(q: URLSearchParams): number | undefined {
	const t = parseStartTime(q.get("t") ?? q.get("start"));
	return t !== undefined && t <= LISTEN_START_MAX ? Math.floor(t) : undefined;
}

/** `v` / `list` / album / start-time out of one URL (watch?v=, youtu.be/<id>, /shorts/<id>, /listen?id=, playlist?list=, browse/MPREb_…). */
export function idsFromUrl(raw: string): { v?: string; list?: string; album?: string; t?: number } {
	const out: { v?: string; list?: string; album?: string; t?: number } = {};
	let u: URL;
	try {
		u = new URL(clean(raw));
	} catch {
		return out;
	}
	const q = u.searchParams;
	const v = q.get("v") || q.get("id") || q.get("videoId") || "";
	if (VIDEO_ID.test(v)) out.v = v;
	const list = q.get("list") || q.get("playlistId") || "";
	if (LIST_ID.test(list)) out.list = list;
	const host = u.hostname.toLowerCase();
	const segs = u.pathname.split("/").filter(Boolean);
	if (!out.v) {
		if (/(^|\.)youtu\.be$/.test(host) && segs[0] && VIDEO_ID.test(segs[0])) out.v = segs[0];
		else if (segs.length >= 2 && /^(shorts|embed|v|live)$/.test(segs[0]) && VIDEO_ID.test(segs[1])) out.v = segs[1];
	}
	if (!out.list && segs[0] === "playlist" && segs[1] && LIST_ID.test(segs[1])) out.list = segs[1];
	// Album: music.youtube.com/browse/MPREb_…, or our own /release?id=MPREb_….
	const browse = segs[0] === "browse" && segs[1] ? segs[1] : segs[0] === "release" ? q.get("id") || "" : "";
	if (ALBUM_ID.test(browse)) out.album = browse;
	else if (segs[0] === "release" && LOCAL_ALBUM_ID.test(browse)) out.album = browse;
	if (out.v) {
		const hashT = /(?:^#|&)t=([^&]+)/.exec(u.hash)?.[1];
		const t = parseStartTime(q.get("t") || q.get("start") || hashT);
		if (t) out.t = t;
	}
	return out;
}

function isMusicServiceUrl(raw: string): boolean {
	try {
		return MUSIC_HOST.test(new URL(raw).hostname.toLowerCase());
	} catch {
		return false;
	}
}

const TRACK_BY = /^(.+?)\s+[-–—]\s+(?:song(?:\s+and\s+lyrics)?|single|album|ep|titre|chanson)\s+(?:by|de|par)\s+(.+)$/i;

/**
 * The readable part of a shared text: links, the service boilerplate
 * ("Écoute … sur Deezer", "… | Spotify", "Listen to … on Spotify") and quotes
 * removed; "Titre - song by Artiste" / "Écoute Titre de Artiste" become
 * "Artiste - Titre". "" when nothing readable is left.
 */
export function readableShareText(raw: unknown): string {
	let s = clean(raw).replace(URL_RE, " ").replace(BARE_YT_RE, " ");
	s = s.replace(/[«»"“”„]/g, " ").replace(/\s+/g, " ").trim();
	// Trailing service name: "| Spotify", "- Deezer", "on Spotify", "sur Deezer".
	const tail = new RegExp(`\\s*(?:[|\\-–—·]\\s*|\\b(?:on|sur|via)\\s+)(?:${SERVICES})\\s*[.!:]*\\s*$`, "i");
	for (let i = 0; i < 2 && tail.test(s); i++) s = s.replace(tail, "").trim();
	// Leading invitation: "Écoute", "Listen to", "Regarde", "Check out", "Découvre".
	const lead = /^(?:[ée]coute[sz]?|listen to|regarde[sz]?|watch|check out|d[ée]couvre[sz]?)\s*:?\s+/i;
	const invited = lead.test(s);
	s = s.replace(lead, "").trim();
	const by = TRACK_BY.exec(s);
	if (by) s = `${by[2].trim()} - ${by[1].trim()}`;
	else if (invited) {
		const m = /^(.+)\s+(?:by|de|par)\s+(.+)$/i.exec(s);
		if (m) s = `${m[2].trim()} - ${m[1].trim()}`;
	}
	s = s.replace(/^[\s:,;\-–—|]+|[\s:,;\-–—|.!]+$/g, "").trim();
	if (!/\p{L}|\d/u.test(s)) return "";
	return s.length > SHARE_QUERY_MAX ? s.slice(0, SHARE_QUERY_MAX).replace(/\s+\S*$/, "") : s;
}

/** Whether `s` reads like "Artiste - Titre". */
function looksLikeArtistTitle(s: string): boolean {
	return /\p{L}.*\s[-–—]\s.*\p{L}/u.test(s);
}

function trackHref(v: string, list?: string, t?: number): string {
	return `/listen?id=${encodeURIComponent(v)}${list ? `&list=${encodeURIComponent(list)}` : ""}${t ? `&t=${t}` : ""}`;
}

/** The search route of a shared title. */
export function searchHref(query: string): string {
	return `/search/${encodeURIComponent(query)}?filter=songs`;
}

/**
 * The in-app route of a share: a track (`/listen?id=<v>[&list=…][&t=…]`, the
 * existing preview page: no acquisition before "Écouter"), else an album
 * (`/release?id=MPREb_…`), else a playlist (`/playlist/<list>`), else a
 * search on the shared title (music-service link, or "Artiste - Titre" with
 * no link at all), else null. `url` is tried first, then the links found in
 * `text`, then `title`.
 */
export function parseSharedLink(params: { title?: unknown; text?: unknown; url?: unknown }): SharedTarget | null {
	const candidates: string[] = [];
	const push = (s: string) => {
		if (s && !candidates.includes(s)) candidates.push(s);
	};
	const url = clean(params.url);
	for (const f of urlsIn(url)) push(f);
	push(url);
	for (const s of [clean(params.text), clean(params.title)]) {
		for (const f of urlsIn(s)) push(f);
		push(s);
	}
	for (const c of candidates) {
		const { v, list, album, t } = idsFromUrl(c);
		if (v) return { kind: "track", id: v, list, ...(t ? { t } : {}), href: trackHref(v, list, t) };
		if (album) return { kind: "album", id: album, href: `/release?id=${encodeURIComponent(album)}` };
		if (list) return { kind: "playlist", id: list, href: `/playlist/${encodeURIComponent(list)}` };
	}
	// Bare ids ("dQw4w9WgXcQ" shared as text).
	for (const c of candidates) {
		if (VIDEO_ID.test(c)) return { kind: "track", id: c, href: trackHref(c) };
	}
	// No YouTube id: search the shared title.
	const links = [url, clean(params.text), clean(params.title)].flatMap(urlsIn);
	const readable = readableShareText(params.title) || readableShareText(params.text) || readableShareText(url);
	if (!readable) return null;
	const fromService = links.some(isMusicServiceUrl);
	if (fromService || (!links.length && looksLikeArtistTitle(readable))) {
		return { kind: "search", query: readable, href: searchHref(readable) };
	}
	return null;
}

/** Artist + title of a YouTube album out of /api/v1/main.json?endpoint=browse (items.releaseInfo). */
export function albumInfoFromBrowse(body: unknown): { artist: string; title: string } | null {
	const ri = (body as { items?: { releaseInfo?: any } } | null)?.items?.releaseInfo;
	if (!ri || typeof ri !== "object") return null;
	const title = typeof ri.title === "string" ? ri.title.trim() : "";
	const a = Array.isArray(ri.artist) ? ri.artist[0]?.name : ri.artist;
	const artist = typeof a === "string" ? a.trim() : "";
	return title && artist ? { artist, title } : null;
}

export type ShareResolveDeps = {
	/** Artist + title of a YouTube album id (null when unknown). */
	albumInfo: (id: string) => Promise<{ artist: string; title: string } | null>;
	/** The local twin (local/albums/match), null when not owned. */
	findOwned: (artist: string, title: string) => Promise<{ href: string } | null>;
	timeoutMs?: number;
};

/**
 * The final route of a share: a YouTube album the library owns opens its
 * local /release?id=lb-… page; anything else (or any error / timeout) keeps
 * `target.href`. Never throws.
 */
export async function resolveShareHref(target: SharedTarget, deps: ShareResolveDeps): Promise<{ href: string; owned: boolean }> {
	const fallback = { href: target.href, owned: false };
	// A local album id (lb-…) is already the library page: nothing to look up.
	if (target.kind !== "album" || target.id.startsWith("lb-")) return fallback;
	const lookup = (async () => {
		const info = await deps.albumInfo(target.id);
		if (!info) return fallback;
		const owned = await deps.findOwned(info.artist, info.title);
		return owned && typeof owned.href === "string" && owned.href.startsWith("/") && !owned.href.startsWith("//") ? { href: owned.href, owned: true } : fallback;
	})().catch(() => fallback);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof fallback>((r) => (timer = setTimeout(() => r(fallback), deps.timeoutMs ?? 4000)));
	try {
		return await Promise.race([lookup, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
