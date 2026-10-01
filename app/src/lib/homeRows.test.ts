import { describe, expect, it } from "vitest";
import {
	REDISCOVER_MIN,
	buildRediscoverRow,
	UNKNOWN_ARTIST,
	artistName,
	buildForYouRow,
	buildResumeRow,
	diversify,
	capItems,
	OFFLINE_TRACKS_KEY,
	readCachedTracks,
	hasCoverAndArtist,
	readLastTrack,
	rowItemRef,
	sanitizeCard,
	thumbnailUrl,
	isoWeekKey,
	shouldShowWeekCard,
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
		expect(buildResumeRow(last, recent, 10).map(rowItemRef)).toEqual(["last", "r1", "r2"]);
	});
	it("caps the history part to max, independent of the last track", () => {
		const recent = Array.from({ length: 15 }, (_, i) => song(`r${i}`));
		const row = buildResumeRow(song("last"), recent, 10);
		expect(row).toHaveLength(11);
		expect(rowItemRef(row[0])).toBe("last");
		expect(rowItemRef(row[10])).toBe("r9");
	});
	it("stays empty when history is empty: the current queue is not a resume (G17)", () => {
		expect(buildResumeRow(null, [], 10)).toEqual([]);
		expect(buildResumeRow(null, undefined, 10)).toEqual([]);
	});
	it("shows only the last track when history is empty", () => {
		expect(buildResumeRow(song("last"), [], 10).map(rowItemRef)).toEqual(["last"]);
	});
	it("is empty when nothing is known", () => {
		expect(buildResumeRow(null, undefined)).toEqual([]);
		expect(buildResumeRow(null, { items: [] })).toEqual([]);
	});
	it("falls back to the cached tracks when the history is empty (offline, H8)", () => {
		const cached = [song("c1"), song("last"), song("c2")];
		const row = buildResumeRow(song("last"), [], 10, () => cached);
		expect(row.map(rowItemRef)).toEqual(["last", "c1", "c2"]);
	});
	it("ignores the fallback when the history has items", () => {
		const row = buildResumeRow(null, [song("r1")], 10, () => [song("c1")]);
		expect(row.map(rowItemRef)).toEqual(["r1"]);
	});
	it("default fallback is empty outside an offline browser (G17 kept online)", () => {
		expect(buildResumeRow(null, [], 10)).toEqual([]);
	});
});

describe("readCachedTracks (H8)", () => {
	const store = (v: unknown) => ({ getItem: (k: string) => (k === OFFLINE_TRACKS_KEY ? JSON.stringify(v) : null) });
	it("keeps only entries the SW holds, most recently cached first", () => {
		const list = [
			{ ...song("old"), _cached: true, _at: 1 },
			{ ...song("pending"), _cached: false, _at: 5 },
			{ ...song("evicted"), _cached: true, _evicted: true, _at: 6 },
			{ ...song("new"), _cached: true, _at: 9 },
		];
		expect(readCachedTracks(store(list)).map(rowItemRef)).toEqual(["new", "old"]);
	});
	it("is empty on missing or corrupt storage", () => {
		expect(readCachedTracks(undefined)).toEqual([]);
		expect(readCachedTracks({ getItem: () => "{nope" })).toEqual([]);
		expect(readCachedTracks(store({ not: "a list" }))).toEqual([]);
	});
});

describe("diversify (audit UX v4 TOP 5)", () => {
	const card = (id: string, album: string, artist: string, cover: string) => ({
		videoId: id,
		title: id,
		album: { browseId: album },
		artistInfo: { artist: [{ browseId: artist }] },
		thumbnails: [{ url: cover }],
	});
	it("never shows the same cover twice and caps one card per album", () => {
		const items = [
			card("a1", "al1", "ar1", "https://x/c1=w60-h60"),
			card("a2", "al1", "ar1", "https://x/c1=w120-h120"),
			card("b1", "al2", "ar2", "https://x/c2"),
			card("b2", "al3", "ar2", "https://x/c2"),
			card("c1", "al4", "ar3", "https://x/c3"),
		];
		const out = diversify(items, 10, 1, 2);
		expect(out.map((i) => i.videoId)).toEqual(["a1", "b1", "c1"]);
	});
	it("fills a short row from the skipped items when the pool is small", () => {
		const items = [
			card("a1", "al1", "ar1", "https://x/c1"),
			card("a2", "al1", "ar1", "https://x/c2"),
			card("a3", "al1", "ar1", "https://x/c3"),
		];
		expect(diversify(items, 3, 1, 2).map((i) => i.videoId)).toEqual(["a1", "a2", "a3"]);
		expect(diversify(items, 2, 1, 2).map((i) => i.videoId)).toEqual(["a1", "a2"]);
	});
});

describe("ST1 week card", () => {
	it("computes the ISO week key (Monday-based, year of that week's Thursday)", () => {
		// 2026-01-01 is a Thursday -> ISO week 1 of 2026.
		expect(isoWeekKey(new Date(2026, 0, 1))).toBe("2026-W01");
		// 2025-12-29 (Monday) is still ISO week 1 of 2026 (shares the same Thursday).
		expect(isoWeekKey(new Date(2025, 11, 29))).toBe("2026-W01");
		// 2026-12-31 (Thursday) stays in 2026's last week.
		expect(isoWeekKey(new Date(2026, 11, 31))).toBe("2026-W53");
	});
	it("shows only on Monday, local time", () => {
		const monday = new Date(2026, 0, 5); // a Monday
		const tuesday = new Date(2026, 0, 6);
		expect(monday.getDay()).toBe(1);
		expect(shouldShowWeekCard(monday, null)).toBe(true);
		expect(shouldShowWeekCard(tuesday, null)).toBe(false);
	});
	it("stays hidden once dismissed for THAT week, but returns the next Monday", () => {
		const monday = new Date(2026, 0, 5);
		const nextMonday = new Date(2026, 0, 12);
		const thisWeek = isoWeekKey(monday);
		expect(shouldShowWeekCard(monday, thisWeek)).toBe(false);
		expect(shouldShowWeekCard(monday, "2025-W52")).toBe(true);
		expect(shouldShowWeekCard(nextMonday, thisWeek)).toBe(true);
		expect(shouldShowWeekCard(monday, null)).toBe(true);
		expect(shouldShowWeekCard(monday, undefined)).toBe(true);
	});
});

describe("Redécouvrir row (c29b D3)", () => {
	it("hides the row under the minimum and keeps it otherwise", () => {
		const five = ["a", "b", "c", "d", "e"].map((id) => song(id));
		expect(buildRediscoverRow(five)).toEqual([]);
		const six = [...five, song("f")];
		expect(buildRediscoverRow(six).map((r) => r.videoId)).toEqual(["a", "b", "c", "d", "e", "f"]);
		expect(REDISCOVER_MIN).toBe(6);
	});
	it("dedupes, drops unrenderable rows and caps before applying the minimum", () => {
		const items = [song("a"), song("a"), { title: "no ref" }, null, ...["b", "c", "d", "e", "f", "g", "h"].map((id) => song(id))];
		expect(buildRediscoverRow(items, 6).map((r) => r.videoId)).toEqual(["a", "b", "c", "d", "e", "f"]);
		expect(buildRediscoverRow(items, 5)).toEqual([]);
		expect(buildRediscoverRow(undefined)).toEqual([]);
		expect(buildRediscoverRow("nope")).toEqual([]);
	});
	it("sanitizes subtitles", () => {
		const items = ["a", "b", "c", "d", "e", "f"].map((id) => ({ ...song(id), subtitle: [{ text: undefined }] }));
		const row = buildRediscoverRow(items);
		expect(row[0].subtitle).toEqual([{ text: UNKNOWN_ARTIST }]);
	});
});
