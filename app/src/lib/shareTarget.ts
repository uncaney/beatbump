// HL5 Android "Partager vers" (manifest share_target, GET /share-target?title
// &text&url): turn whatever the sharing app handed over (a YouTube / YouTube
// Music link, a youtu.be short link, one of our own /listen or /watch links,
// or free text containing one) into an in-app route. Pure: the route page
// calls it and `goto`s the result, or shows "Lien non reconnu".

export type SharedTarget = { kind: "track"; id: string; list?: string; href: string } | { kind: "playlist"; id: string; href: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function clean(s: unknown): string {
	return typeof s === "string" ? s.trim() : "";
}

/** The first http(s) URL found in `s` (a shared text often wraps the link in a sentence). */
export function firstUrl(s: string): string {
	const m = clean(s).match(URL_RE);
	return m ? m[0].replace(/[.,;:)\]]+$/, "") : "";
}

/** `v` / `list` ids out of one URL (watch?v=, youtu.be/<id>, /shorts/<id>, /listen?id=, playlist?list=). */
export function idsFromUrl(raw: string): { v?: string; list?: string } {
	const out: { v?: string; list?: string } = {};
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
	return out;
}

/**
 * The in-app route of a share: a track (`/listen?id=<v>[&list=…]`, the
 * existing preview page: no acquisition before "Écouter"), else a playlist
 * (`/playlist/<list>`), else null. `url` is tried first, then the URLs
 * found in `text`, then `title`.
 */
export function parseSharedLink(params: { title?: unknown; text?: unknown; url?: unknown }): SharedTarget | null {
	const candidates: string[] = [];
	const push = (s: string) => {
		if (s && !candidates.includes(s)) candidates.push(s);
	};
	push(firstUrl(clean(params.url)) || clean(params.url));
	for (const s of [clean(params.text), clean(params.title)]) {
		const found = s.match(URL_RE) || [];
		for (const f of found) push(f.replace(/[.,;:)\]]+$/, ""));
		push(s);
	}
	for (const c of candidates) {
		const { v, list } = idsFromUrl(c);
		if (v) return { kind: "track", id: v, list, href: `/listen?id=${encodeURIComponent(v)}${list ? `&list=${encodeURIComponent(list)}` : ""}` };
		if (list) return { kind: "playlist", id: list, href: `/playlist/${encodeURIComponent(list)}` };
	}
	// Bare ids ("dQw4w9WgXcQ" shared as text).
	for (const c of candidates) {
		if (VIDEO_ID.test(c)) return { kind: "track", id: c, href: `/listen?id=${encodeURIComponent(c)}` };
	}
	return null;
}
