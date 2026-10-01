import { describe, expect, it } from "vitest";
import { albumInfoFromBrowse, firstUrl, idsFromUrl, listenStartTime, parseSharedLink, parseStartTime, readableShareText, resolveShareHref, urlsIn } from "./shareTarget";

describe("idsFromUrl", () => {
	it("reads v= / list= from watch, music and playlist URLs", () => {
		expect(idsFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ v: "dQw4w9WgXcQ" });
		expect(idsFromUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ")).toEqual({ v: "dQw4w9WgXcQ", list: "RDAMVMdQw4w9WgXcQ" });
		expect(idsFromUrl("https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")).toEqual({ list: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" });
	});
	it("reads youtu.be, shorts and our own /listen links", () => {
		expect(idsFromUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")).toEqual({ v: "dQw4w9WgXcQ" });
		expect(idsFromUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toEqual({ v: "dQw4w9WgXcQ" });
		expect(idsFromUrl("https://music.ekaii.fr/listen?id=dQw4w9WgXcQ&list=OLAK5uy_abc")).toEqual({ v: "dQw4w9WgXcQ", list: "OLAK5uy_abc" });
	});
	it("ignores malformed ids and non-URLs", () => {
		expect(idsFromUrl("https://www.youtube.com/watch?v=short")).toEqual({});
		expect(idsFromUrl("not a url")).toEqual({});
		expect(idsFromUrl("")).toEqual({});
	});
});

describe("firstUrl", () => {
	it("finds the link inside shared text and strips trailing punctuation", () => {
		expect(firstUrl("Écoute ça : https://youtu.be/dQw4w9WgXcQ.")).toBe("https://youtu.be/dQw4w9WgXcQ");
		expect(firstUrl("rien ici")).toBe("");
	});
});

describe("parseSharedLink", () => {
	it("routes a video to /listen?id= (with its list) and a playlist to /playlist/<list>", () => {
		expect(parseSharedLink({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).toEqual({ kind: "track", id: "dQw4w9WgXcQ", list: undefined, href: "/listen?id=dQw4w9WgXcQ" });
		expect(parseSharedLink({ text: "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ" })).toEqual({
			kind: "track",
			id: "dQw4w9WgXcQ",
			list: "RDAMVMdQw4w9WgXcQ",
			href: "/listen?id=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ",
		});
		expect(parseSharedLink({ text: "https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })).toEqual({
			kind: "playlist",
			id: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
			href: "/playlist/PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
		});
	});
	it("prefers url over text, finds the link inside a sentence (Android puts it in text), accepts a bare id", () => {
		expect(parseSharedLink({ url: "https://youtu.be/aaaaaaaaaaa", text: "https://youtu.be/bbbbbbbbbbb" })).toMatchObject({ kind: "track", id: "aaaaaaaaaaa" });
		expect(parseSharedLink({ title: "Never Gonna Give You Up", text: "Regarde « Never Gonna Give You Up » sur YouTube https://youtu.be/dQw4w9WgXcQ?si=x" })?.href).toBe("/listen?id=dQw4w9WgXcQ");
		expect(parseSharedLink({ text: "dQw4w9WgXcQ" })?.href).toBe("/listen?id=dQw4w9WgXcQ");
	});
	it("returns null for anything else", () => {
		expect(parseSharedLink({})).toBeNull();
		expect(parseSharedLink({ title: "hello", text: "https://example.com/page" })).toBeNull();
		expect(parseSharedLink({ url: "https://www.youtube.com/" })).toBeNull();
		expect(parseSharedLink({ text: 42 })).toBeNull();
	});
});

describe("UX10 start time", () => {
	it("parses seconds and h/m/s forms", () => {
		expect(parseStartTime("90")).toBe(90);
		expect(parseStartTime("90s")).toBe(90);
		expect(parseStartTime("1m30s")).toBe(90);
		expect(parseStartTime("1h2m3s")).toBe(3723);
		expect(parseStartTime("2m")).toBe(120);
		expect(parseStartTime("0")).toBeUndefined();
		expect(parseStartTime("abc")).toBeUndefined();
		expect(parseStartTime(null)).toBeUndefined();
	});
	it("passes youtu.be ?t= / watch &t= / #t= through to /listen?id=&t=", () => {
		expect(parseSharedLink({ url: "https://youtu.be/dQw4w9WgXcQ?t=42" })).toEqual({ kind: "track", id: "dQw4w9WgXcQ", list: undefined, t: 42, href: "/listen?id=dQw4w9WgXcQ&t=42" });
		expect(parseSharedLink({ text: "https://youtu.be/dQw4w9WgXcQ?si=abc&t=1m5s" })?.href).toBe("/listen?id=dQw4w9WgXcQ&t=65");
		expect(parseSharedLink({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&t=10s" })?.href).toBe(
			"/listen?id=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&t=10",
		);
		expect(parseSharedLink({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30" })?.href).toBe("/listen?id=dQw4w9WgXcQ&t=30");
		expect(parseSharedLink({ url: "https://youtu.be/dQw4w9WgXcQ?t=0" })?.href).toBe("/listen?id=dQw4w9WgXcQ");
	});
});

describe("UX10 playlists and albums in url", () => {
	it("reads a playlist given in url, with or without a scheme", () => {
		expect(parseSharedLink({ url: "https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&si=zz" })?.href).toBe("/playlist/PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG");
		expect(parseSharedLink({ url: "music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })?.href).toBe("/playlist/PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG");
		expect(parseSharedLink({ text: "Ma playlist : youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG." })?.kind).toBe("playlist");
		expect(urlsIn("voir music.youtube.com/watch?v=dQw4w9WgXcQ)")).toEqual(["https://music.youtube.com/watch?v=dQw4w9WgXcQ"]);
	});
	it("routes a YouTube Music album (browse/MPREb_) to /release?id=", () => {
		expect(idsFromUrl("https://music.youtube.com/browse/MPREb_4pL8gzRtw1p?si=abc")).toEqual({ album: "MPREb_4pL8gzRtw1p" });
		expect(parseSharedLink({ url: "https://music.youtube.com/browse/MPREb_4pL8gzRtw1p" })).toEqual({ kind: "album", id: "MPREb_4pL8gzRtw1p", href: "/release?id=MPREb_4pL8gzRtw1p" });
		expect(parseSharedLink({ text: "https://music.ekaii.fr/release?id=MPREb_4pL8gzRtw1p" })?.kind).toBe("album");
		expect(idsFromUrl("https://music.youtube.com/browse/UCabcdefghijk")).toEqual({});
	});
});

describe("UX10 shared titles", () => {
	it("extracts the readable part of service share texts", () => {
		expect(readableShareText("Da Funk - song and lyrics by Daft Punk | Spotify")).toBe("Daft Punk - Da Funk");
		expect(readableShareText("Écoute Da Funk de Daft Punk sur Deezer https://dzr.page.link/abc")).toBe("Daft Punk - Da Funk");
		expect(readableShareText("Listen to One More Time by Daft Punk on Spotify")).toBe("Daft Punk - One More Time");
		expect(readableShareText("« Daft Punk - Da Funk »")).toBe("Daft Punk - Da Funk");
		expect(readableShareText("https://open.spotify.com/track/abc")).toBe("");
		expect(readableShareText(42)).toBe("");
	});
	it("searches the title of a Spotify / Deezer link", () => {
		expect(parseSharedLink({ title: "Daft Punk - Da Funk", text: "https://open.spotify.com/track/2cGxRwrMyEAp8dEbuZaVv6?si=x" })).toEqual({
			kind: "search",
			query: "Daft Punk - Da Funk",
			href: "/search/Daft%20Punk%20-%20Da%20Funk?filter=songs",
		});
		expect(parseSharedLink({ text: "Écoute Da Funk de Daft Punk sur Deezer https://deezer.page.link/xyz" })?.href).toBe("/search/Daft%20Punk%20-%20Da%20Funk?filter=songs");
		expect(parseSharedLink({ url: "https://open.spotify.com/track/2cGxRwrMyEAp8dEbuZaVv6" })).toBeNull();
	});
	it("searches a plain 'Artiste - Titre' text, never a lone word or an unknown site", () => {
		expect(parseSharedLink({ text: "Daft Punk – Around the World" })?.href).toBe("/search/Daft%20Punk%20%E2%80%93%20Around%20the%20World?filter=songs");
		expect(parseSharedLink({ text: "hello" })).toBeNull();
		expect(parseSharedLink({ title: "Daft Punk - Da Funk", text: "https://example.com/page" })).toBeNull();
	});
});

describe("UX10 owned album", () => {
	const album = { kind: "album", id: "MPREb_4pL8gzRtw1p", href: "/release?id=MPREb_4pL8gzRtw1p" } as const;
	const info = async () => ({ artist: "Daft Punk", title: "Discovery" });
	it("reads artist + title from the browse answer", () => {
		expect(albumInfoFromBrowse({ items: { releaseInfo: { title: "Discovery", artist: [{ name: "Daft Punk" }] } } })).toEqual({ artist: "Daft Punk", title: "Discovery" });
		expect(albumInfoFromBrowse({ items: {} })).toBeNull();
		expect(albumInfoFromBrowse(null)).toBeNull();
	});
	it("opens the local twin when the library owns the album", async () => {
		const seen: string[] = [];
		const r = await resolveShareHref(album, { albumInfo: info, findOwned: async (a, t) => (seen.push(`${a}/${t}`), { href: "/release?id=lb-42" }) });
		expect(r).toEqual({ href: "/release?id=lb-42", owned: true });
		expect(seen).toEqual(["Daft Punk/Discovery"]);
	});
	it("keeps the YouTube page on no match, error or timeout, and skips non-albums", async () => {
		expect(await resolveShareHref(album, { albumInfo: info, findOwned: async () => null })).toEqual({ href: album.href, owned: false });
		expect(await resolveShareHref(album, { albumInfo: async () => { throw new Error("x"); }, findOwned: async () => null })).toEqual({ href: album.href, owned: false });
		expect(await resolveShareHref(album, { albumInfo: () => new Promise(() => {}), findOwned: async () => null, timeoutMs: 5 })).toEqual({ href: album.href, owned: false });
		let called = false;
		const track = { kind: "track", id: "dQw4w9WgXcQ", href: "/listen?id=dQw4w9WgXcQ" } as const;
		expect(await resolveShareHref(track, { albumInfo: async () => ((called = true), null), findOwned: async () => null })).toEqual({ href: track.href, owned: false });
		expect(called).toBe(false);
	});
});

describe("L10-2 listenStartTime (/listen?id=&t=)", () => {
	const q = (s: string) => new URLSearchParams(s);
	it("reads the seconds the share target writes, and the YouTube forms", () => {
		expect(listenStartTime(q("id=dQw4w9WgXcQ&t=90"))).toBe(90);
		expect(listenStartTime(q("id=dQw4w9WgXcQ&t=1m30s"))).toBe(90);
		expect(listenStartTime(q("id=dQw4w9WgXcQ&start=30"))).toBe(30);
	});
	it("starts at 0 when absent, invalid, zero, negative or beyond 12 h", () => {
		expect(listenStartTime(q("id=dQw4w9WgXcQ"))).toBeUndefined();
		expect(listenStartTime(q("t=abc"))).toBeUndefined();
		expect(listenStartTime(q("t=0"))).toBeUndefined();
		expect(listenStartTime(q("t=-5"))).toBeUndefined();
		expect(listenStartTime(q("t=43201"))).toBeUndefined();
		expect(listenStartTime(q("t=43200"))).toBe(43200);
	});
});

describe("L10-12 our own local album links", () => {
	it("routes /release?id=lb-… (with or without the hint) to the local album page", () => {
		expect(parseSharedLink({ url: "https://music.ekaii.fr/release?id=lb-0123456789ab" })).toEqual({ kind: "album", id: "lb-0123456789ab", href: "/release?id=lb-0123456789ab" });
		expect(parseSharedLink({ text: "Écoute ça https://music.ekaii.fr/release?id=lb-0123456789ab.RGFmdA" })?.href).toBe("/release?id=lb-0123456789ab.RGFmdA");
	});
	it("rejects malformed local ids and lb- outside /release", () => {
		expect(parseSharedLink({ url: "https://music.ekaii.fr/release?id=lb-x/../keys" })).toBeNull();
		expect(parseSharedLink({ url: "https://music.ekaii.fr/release?id=lb-0123456789AB" })).toBeNull();
		expect(idsFromUrl("https://music.youtube.com/browse/lb-0123456789ab").album).toBeUndefined();
	});
	it("a local album is never looked up again, and a // href is refused", async () => {
		let asked = 0;
		const deps = { albumInfo: async () => (asked++, { artist: "A", title: "T" }), findOwned: async () => ({ href: "//evil.example/x" }) };
		const local = { kind: "album", id: "lb-0123456789ab", href: "/release?id=lb-0123456789ab" } as const;
		expect(await resolveShareHref(local, deps)).toEqual({ href: local.href, owned: false });
		expect(asked).toBe(0);
		const yt = { kind: "album", id: "MPREb_4pL8gzRtw1p", href: "/release?id=MPREb_4pL8gzRtw1p" } as const;
		expect(await resolveShareHref(yt, deps)).toEqual({ href: yt.href, owned: false });
	});
});
