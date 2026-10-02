import { describe, expect, it } from "vitest";
import { FIRST_PACK_SECONDS, firstPackSizeText, firstPackSources, hasFirstPackMaterial, planFirstPack, shouldShowFirstPackCard, sizeFirstPack } from "./firstPack";
import { NNBSP } from "./utils/formatFr";

describe("shouldShowFirstPackCard", () => {
	it("shows for a profile without history once the service worker is active", () => {
		expect(shouldShowFirstPackCard({ stored: null, recentCount: 0, swActive: true })).toBe(true);
		expect(shouldShowFirstPackCard({ stored: undefined, recentCount: 0, swActive: true })).toBe(true);
		expect(shouldShowFirstPackCard({ stored: "", recentCount: NaN, swActive: true })).toBe(true);
	});

	it("hides once dismissed or used (memo), without a service worker, or with a play recorded", () => {
		expect(shouldShowFirstPackCard({ stored: "1", recentCount: 0, swActive: true })).toBe(false);
		expect(shouldShowFirstPackCard({ stored: null, recentCount: 0, swActive: false })).toBe(false);
		expect(shouldShowFirstPackCard({ stored: null, recentCount: 1, swActive: true })).toBe(false);
		expect(shouldShowFirstPackCard({ stored: null, recentCount: 12, swActive: true })).toBe(false);
	});

	it("L14-5: hides when the history is unknown (me/stats/recent failed) rather than assuming none", () => {
		expect(shouldShowFirstPackCard({ stored: null, recentCount: null, swActive: true })).toBe(false);
	});
});

const track = (videoId: string, length = "4:00") => ({ videoId, title: videoId, length });

describe("firstPackSources", () => {
	it("draws the album of the day, the artist of the day and a decade mix, each best-effort", async () => {
		const calls: string[] = [];
		const answers: Record<string, unknown> = {
			"/api/v1/local/album-of-day": { album: { browseId: "lb-1", title: "Discovery" }, date: "2026-10-02", tracks: [track("a1"), track("a2")] },
			"/api/v1/local/artist-of-the-day": { artist: { browseId: "la-1", title: "Daft Punk" }, name: "Daft Punk", date: "2026-10-02" },
			"/api/v1/local/mixes": { decades: [{ decade: 1990, albums: 12, tracks: 150 }] },
		};
		const getJson = async (url: string) => {
			calls.push(url);
			if (url in answers) return answers[url];
			if (url.startsWith("/api/v1/local/songs?artist=Daft%20Punk")) return { items: [track("s1")] };
			if (url.startsWith("/api/v1/local/mix?")) return { items: [track("m1"), track("m2")] };
			throw new Error("unexpected " + url);
		};
		const src = await firstPackSources(getJson);
		expect(src.album.map((t) => t.videoId)).toEqual(["a1", "a2"]);
		expect(src.artist.map((t) => t.videoId)).toEqual(["s1"]);
		expect(src.mix.map((t) => t.videoId)).toEqual(["m1", "m2"]);
		expect(calls.some((u) => u.startsWith("/api/v1/local/mix?"))).toBe(true);
	});

	it("reads a failed or empty source as an empty list", async () => {
		const src = await firstPackSources(async (url) => {
			if (url.includes("album-of-day")) throw new Error("500");
			return null;
		});
		expect(src).toEqual({ album: [], artist: [], mix: [] });
		expect(hasFirstPackMaterial(src)).toBe(false);
	});
});

describe("planFirstPack", () => {
	it("fills 1 h by duration: album first, then the artist, then the mix, cached ones skipped", () => {
		const album = [track("a1", "10:00"), track("a2", "10:00")];
		const artist = [track("s1", "20:00"), track("a1", "3:00")];
		const mix = [track("m1", "15:00"), track("m2", "30:00"), track("m3", "5:00")];
		const plan = planFirstPack({ album, artist, mix }, ["m1"]);
		expect(plan.mode).toBe("seconds");
		expect(plan.target).toBe(FIRST_PACK_SECONDS);
		expect(plan.items.map((i) => i.videoId)).toEqual(["a1", "a2", "s1", "m3"]);
		expect(plan.seconds).toBe(45 * 60);
		expect(plan.left).toBe(1);
	});
});

describe("U13-2 size announced before the tap", () => {
	const MB = 1024 * 1024;
	// Three 10 min tracks (30 min of listening), no known size.
	const plan = planFirstPack({ album: [track("a1", "10:00"), track("a2", "10:00")], artist: [track("s1", "10:00")], mix: [] });

	it("sizeFirstPack: the estimate at the cache bitrate, the plan untouched off data saver", () => {
		const r = sizeFirstPack(plan, MB, false);
		expect(r.plan).toBe(plan);
		expect(r.estimate).toEqual({ bytes: 1800 * MB, dataSaver: false, capped: false, count: 3, seconds: 1800 });
		expect(firstPackSizeText(r.estimate)).toBe(`Environ 1,8${NNBSP}Go à télécharger (qualité d'origine).`);
	});

	it("sizeFirstPack: data saver cuts the plan to 300 Mo and the line says so, or just names the saver when it fits", () => {
		const r = sizeFirstPack(plan, MB / 4, true);
		expect(r.plan.items.map((i) => i.videoId)).toEqual(["a1", "a2"]);
		expect(r.estimate).toEqual({ bytes: 300 * MB, dataSaver: true, capped: true, count: 2, seconds: 1200 });
		expect(firstPackSizeText(r.estimate)).toBe(`Économie de données : pack limité à 300${NNBSP}Mo, soit 20 min (qualité d'origine, env. 300${NNBSP}Mo).`);
		const small = sizeFirstPack(plan, MB / 100, true);
		expect(small.plan).toBe(plan);
		expect(small.estimate.capped).toBe(false);
		expect(firstPackSizeText(small.estimate)).toBe(`Environ 18${NNBSP}Mo à télécharger (qualité d'origine), économie de données active.`);
	});

	it("firstPackSizeText: nothing without a plan", () => {
		expect(firstPackSizeText(null)).toBe("");
		expect(firstPackSizeText({ bytes: 0, dataSaver: false, capped: false, count: 0, seconds: 0 })).toBe("");
	});
});
