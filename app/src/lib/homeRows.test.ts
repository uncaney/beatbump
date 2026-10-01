import { describe, expect, it } from "vitest";
import {
	UNKNOWN_ARTIST,
	artistName,
	buildForYouRow,
	buildResumeRow,
	capItems,
	hasCoverAndArtist,
	readLastTrack,
	rowItemRef,
	sanitizeCard,
	thumbnailUrl,
} from "./homeRows";

const song = (id: string, title = id) => ({ videoId: id, title, thumbnails: [] });
const card = (id: string, extra: Record<string, any> = {}): Record<string, any> => ({
	videoId: id,
	title: `Title ${id}`,
	thumbnails: [{ url: `https://img/${id}.jpg`, width: 240, height: 240 }],
	artistInfo: { artist: [{ text: `Artist ${id}`, browseId: `la-${id}` }] },
	...extra,
});

describe("Pour toi guards (audit v3 1.1)", () => {
	it("reads the cover url and the artist name from the known shapes", () => {
		expect(thumbnailUrl(card("a"))).toBe("https://img/a.jpg");
		expect(thumbnailUrl(song("a"))).toBe("");
		expect(thumbnailUrl({ thumbnails: [{ url: "   " }] })).toBe("");
		expect(artistName(card("a"))).toBe("Artist a");
		expect(artistName({ artist: "Daft Punk" })).toBe("Daft Punk");
		expect(artistName({ artist: { name: "Justice" } })).toBe("Justice");
		expect(artistName({ subtitle: [{ text: "Song" }, { text: "Air", pageType: "MUSIC_PAGE_TYPE_ARTIST" }] })).toBe("Air");
		expect(artistName({ artistInfo: { artist: [{ browseId: "x" }] } })).toBe("");
		expect(artistName(null)).toBe("");
	});
	it("drops cards without a cover or without an artist", () => {
		expect(hasCoverAndArtist(card("ok"))).toBe(true);
		expect(hasCoverAndArtist(card("nocover", { thumbnails: [] }))).toBe(false);
		expect(hasCoverAndArtist(card("nocover2", { thumbnails: undefined }))).toBe(false);
		expect(hasCoverAndArtist(card("noartist", { artistInfo: undefined }))).toBe(false);
		expect(hasCoverAndArtist(card("noartist2", { artistInfo: { artist: [{ browseId: "la-1" }] } }))).toBe(false);
		expect(hasCoverAndArtist(card("nonvalid", { title: "" }))).toBe(false);
		const items = [card("a"), card("b", { thumbnails: [] }), card("c", { artistInfo: undefined, artist: undefined }), card("d")];
		expect(buildForYouRow(items, 20).map(rowItemRef)).toEqual(["a", "d"]);
		expect(buildForYouRow(undefined, 20)).toEqual([]);
	});
	it("never lets the string 'undefined' reach the subtitle line", () => {
		const bad = card("u", { subtitle: [{ browseId: "la-u" }, { text: undefined }, { text: "" }] });
		const out = sanitizeCard(bad);
		expect(out.subtitle).toEqual([{ text: "Artist u" }]);
		expect(JSON.stringify(out.subtitle)).not.toContain("undefined");
		expect(bad.subtitle).toHaveLength(3); // input not mutated
		const noArtist = sanitizeCard({ videoId: "n", title: "N", subtitle: [{ text: undefined }] });
		expect(noArtist.subtitle).toEqual([{ text: UNKNOWN_ARTIST }]);
		const good = sanitizeCard(card("g", { subtitle: [{ text: "Artist g", browseId: "la-g" }, { text: "Album" }] }));
		expect(good.subtitle.map((s: any) => s.text)).toEqual(["Artist g", "Album"]);
		const none = { videoId: "k", title: "K" };
		expect(sanitizeCard(none)).toBe(none); // no subtitle: nothing invented
		expect(sanitizeCard({ ...none, subtitle: [] }).subtitle).toEqual([]);
		const row = buildForYouRow([card("r", { subtitle: [{ browseId: "la-r" }] })], 20);
		expect(row[0].subtitle).toEqual([{ text: "Artist r" }]);
	});
});
const album = (id: string, title = id) => ({ title, endpoint: { browseId: id, pageType: "MUSIC_PAGE_TYPE_ALBUM" } });

describe("rowItemRef", () => {
	it("prefers videoId, then endpoint.browseId, then browseId", () => {
		expect(rowItemRef(song("a1"))).toBe("a1");
		expect(rowItemRef(album("lb-x"))).toBe("lb-x");
		expect(rowItemRef({ title: "t", browseId: "la-y" })).toBe("la-y");
		expect(rowItemRef(null)).toBe("");
		expect(rowItemRef({ title: "no ref" })).toBe("");
	});
});

describe("capItems", () => {
	it("drops junk, dedupes by ref and caps", () => {
		const items = [song("a"), null, { title: "" }, song("a", "dup"), { videoId: "b" }, song("c"), song("d")];
		expect(capItems(items, 2).map(rowItemRef)).toEqual(["a", "c"]);
		expect(capItems("nope", 5)).toEqual([]);
	});
});

describe("readLastTrack", () => {
	it("parses a renderable item and ignores garbage", () => {
		const store = (v: string | null) => ({ getItem: () => v });
		expect(readLastTrack(store(JSON.stringify(song("z", "Zed"))))?.title).toBe("Zed");
		expect(readLastTrack(store("{not json"))).toBeNull();
		expect(readLastTrack(store(JSON.stringify({ foo: 1 })))).toBeNull();
		expect(readLastTrack(store(null))).toBeNull();
		expect(readLastTrack(undefined)).toBeNull();
	});
});

describe("buildResumeRow", () => {
	it("puts the last track first and never repeats it", () => {
		const last = song("last");
		const recent = [song("last"), song("r1"), song("r2")];
		expect(buildResumeRow(last, recent, [], 10).map(rowItemRef)).toEqual(["last", "r1", "r2"]);
	});
	it("caps the history part to max, independent of the last track", () => {
		const recent = Array.from({ length: 15 }, (_, i) => song(`r${i}`));
		const row = buildResumeRow(song("last"), recent, [], 10);
		expect(row).toHaveLength(11);
		expect(rowItemRef(row[0])).toBe("last");
		expect(rowItemRef(row[10])).toBe("r9");
	});
	it("falls back to the session queue when history is empty", () => {
		const row = buildResumeRow(null, [], [song("q1"), song("q2"), song("q1")], 10);
		expect(row.map(rowItemRef)).toEqual(["q1", "q2"]);
	});
	it("ignores the queue when history has items", () => {
		expect(buildResumeRow(null, [song("h")], [song("q")], 10).map(rowItemRef)).toEqual(["h"]);
	});
	it("is empty when nothing is known", () => {
		expect(buildResumeRow(null, undefined, undefined)).toEqual([]);
		expect(buildResumeRow(null, { items: [] }, "x")).toEqual([]);
	});
});
