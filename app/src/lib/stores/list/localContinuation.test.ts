import { describe, expect, it } from "vitest";
import { albumKey, parseContinueSetting, pickLocalContinuation, relatedQuery } from "./localContinuation";

const rel = (videoId: string, cover: string) => ({ videoId, title: "T" + videoId, thumbnails: [{ url: "/cover?lid=" + cover }] });

describe("pickLocalContinuation (C4)", () => {
	const queue = [{ videoId: "aaaaaaaaaaa" }, { videoId: "bbbbbbbbbbb" }];

	it("dedupes against the queue and itself, max 2 per album, max 10", () => {
		const candidates = [
			rel("aaaaaaaaaaa", "x"), // already queued
			rel("c1", "A"),
			rel("c2", "A"),
			rel("c3", "A"), // third of album A
			rel("c1", "B"), // duplicate id
			...Array.from({ length: 20 }, (_, i) => rel("d" + i, "alb" + i)),
		];
		const out = pickLocalContinuation(queue, candidates);
		expect(out).toHaveLength(10);
		expect(out.map((t) => t.videoId).slice(0, 3)).toEqual(["c1", "c2", "d0"]);
		expect(new Set(out.map((t) => t.videoId)).size).toBe(10);
	});

	it("tolerates garbage", () => {
		expect(pickLocalContinuation(queue, null)).toEqual([]);
		expect(pickLocalContinuation(queue, [null, 1, { title: "no id" }])).toEqual([]);
	});

	it("album key prefers album ids over the cover", () => {
		expect(albumKey({ album: { browseId: "MPRE1" }, thumbnails: [{ url: "u" }] })).toBe("a:MPRE1");
		expect(albumKey({ subtitle: [{ pageType: "MUSIC_PAGE_TYPE_ALBUM", text: "Discovery" }] })).toBe("a:Discovery");
		expect(albumKey({ thumbnails: [{ url: "/cover?lid=1" }] })).toBe("t:/cover?lid=1");
		expect(albumKey({})).toBe("");
	});
});

describe("relatedQuery", () => {
	it("seeds by lid, else by title + artist", () => {
		expect(relatedQuery({ videoId: "0123456789a" })).toBe("lid=0123456789a");
		expect(relatedQuery({ videoId: "dQw4w9WgXcQ", title: "Up & Down", artistInfo: { artist: [{ text: "R A" }] } })).toBe(
			"title=Up%20%26%20Down&artist=R%20A",
		);
		expect(relatedQuery({ videoId: "dQw4w9WgXcQ" })).toBe("");
		expect(relatedQuery(undefined)).toBe("");
	});
});

describe("setting", () => {
	it("is ON unless explicitly off", () => {
		expect(parseContinueSetting(null)).toBe(true);
		expect(parseContinueSetting("true")).toBe(true);
		expect(parseContinueSetting("false")).toBe(false);
	});
});
