import { describe, expect, it } from "vitest";
import { buildResumeRow, capItems, readLastTrack, rowItemRef } from "./homeRows";

const song = (id: string, title = id) => ({ videoId: id, title, thumbnails: [] });
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
