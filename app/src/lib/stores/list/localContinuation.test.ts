import { describe, expect, it } from "vitest";
import {
	albumKey,
	continuationExclude,
	CONTINUATION_EXCLUDE_MAX,
	nextContinuationRequest,
	parseContinueSetting,
	pickLocalContinuation,
	relatedQuery,
} from "./localContinuation";
import { makeContext, type PlaybackContext } from "./playbackContext";

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

describe("c40b B6-10: next continuation request", () => {
	const lid = (n: number) => n.toString(16).padStart(11, "0");
	const queue = [{ videoId: lid(1) }, { videoId: "dQw4w9WgXcQ", title: "YT" }, { videoId: lid(2) }, { videoId: lid(1) }];
	const ctx = (kind: any, title: string, mix?: string): PlaybackContext =>
		makeContext({ kind, title, href: "/library/mixes", ...(mix ? { mix } : {}) }, queue)!;
	const params = (url: string) => new URL(url, "http://x").searchParams;

	it("a decade mix continues with the same mix filter, minus what was just played", () => {
		const r = nextContinuationRequest(ctx("decade", "Années 1990", "decade=1990"), queue)!;
		expect(r.keepContext).toBe(true);
		expect(r.url.startsWith("/api/v1/local/mix?")).toBe(true);
		const p = params(r.url);
		expect(p.get("decade")).toBe("1990");
		expect(p.get("personal")).toBe("1");
		expect(p.get("exclude")).toBe([lid(1), lid(2)].join(",")); // lids only, most recent first, unique
	});

	it("genre, year and crossover keep their filter (stored, else from the title)", () => {
		expect(params(nextContinuationRequest(ctx("genre", "Hip-Hop/Rap"), queue)!.url).get("genre")).toBe("Hip-Hop/Rap");
		expect(params(nextContinuationRequest(ctx("year", "1997"), queue)!.url).get("year")).toBe("1997");
		const x = params(nextContinuationRequest(ctx("crossover", "Rock des années 1990"), queue)!.url);
		expect([x.get("decade"), x.get("genre")]).toEqual(["1990", "Rock"]);
		const d = nextContinuationRequest(ctx("decade", "Années 1980"), queue)!;
		expect(d.keepContext && params(d.url).get("decade") === "1980").toBe(true);
		const stored = params(nextContinuationRequest(ctx("crossover", "renamed", "decade=2000&genre=R%26B"), queue)!.url);
		expect([stored.get("decade"), stored.get("genre")]).toEqual(["2000", "R&B"]);
	});

	it("other contexts, unusable filters and forceRelated fall back to local/related on the last row", () => {
		for (const c of [null, ctx("album", "Discovery"), ctx("queue", "Suite"), ctx("year", "les années 90"), ctx("decade", "")]) {
			const r = nextContinuationRequest(c, queue)!;
			expect(r.keepContext).toBe(false);
			expect(r.url.startsWith("/api/v1/local/related?lid=" + lid(1) + "&")).toBe(true);
			expect(params(r.url).get("personal")).toBe("1");
		}
		const forced = nextContinuationRequest(ctx("decade", "Années 1990", "decade=1990"), queue, true)!;
		expect(forced.keepContext).toBe(false);
		expect(forced.url).toContain("/api/v1/local/related?");
	});

	it("null when nothing can seed it; the exclude list is bounded", () => {
		expect(nextContinuationRequest(null, [])).toBeNull();
		expect(nextContinuationRequest(null, [{ title: "" }])).toBeNull();
		// a mix context still continues from an empty queue
		expect(nextContinuationRequest(ctx("genre", "Rock"), [])!.url).toBe("/api/v1/local/mix?genre=Rock&personal=1");
		const long = Array.from({ length: 100 }, (_, i) => ({ videoId: lid(i + 1) }));
		const ex = continuationExclude(long);
		expect(ex).toHaveLength(CONTINUATION_EXCLUDE_MAX);
		expect(ex[0]).toBe(lid(100));
	});
});
