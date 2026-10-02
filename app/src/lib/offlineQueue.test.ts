import { describe, expect, it } from "vitest";
import {
	albumInfo,
	artistName,
	durationOf,
	explainUnplayable,
	formatBytes,
	formatDuration,
	groupByAlbum,
	groupByArtist,
	mixtape,
	notPlayedSince,
	OFFLINE_PLAY_MESSAGES,
	offlinePlayErrorMessage,
	play,
	playWithReason,
	recentlyCached,
	shuffle,
	toPlayableItems,
	totalBytes,
	totalDuration,
} from "./offlineQueue";

function track(id: string, artist: string, extra: Record<string, unknown> = {}) {
	return {
		videoId: id,
		title: "Title " + id,
		artistInfo: { artist: [{ text: artist, browseId: "la-" + artist.toLowerCase() }] },
		subtitle: [{ text: artist, browseId: "la-" + artist.toLowerCase(), pageType: "MUSIC_PAGE_TYPE_ARTIST" }],
		thumbnails: [{ url: "https://x/" + id + ".jpg", width: 226, height: 226 }],
		_offlineUrl: "https://cdn/" + id + ".opus",
		_at: 1000,
		...extra,
	};
}

const lib = [
	track("a1", "Alpha", { album: { text: "Alpha LP", browseId: "lb-alpha" }, index: 2, _at: 10, _bytes: 100 }),
	track("a2", "Alpha", { album: { text: "Alpha LP", browseId: "lb-alpha" }, index: 1, _at: 20, _bytes: 200 }),
	track("a3", "Alpha", { _at: 30 }),
	track("b1", "Beta", { albumName: "Beta EP", _at: 40, _bytes: 50 }),
	track("b2", "Beta", { subtitle: [{ text: "Beta EP", pageType: "MUSIC_PAGE_TYPE_ALBUM" }], _at: 50 }),
	track("c1", "Gamma", { playlistId: "OLAK5uy_gamma", _at: 60 }),
	track("d1", "Delta", { _at: 5 }),
];

describe("metadata accessors", () => {
	it("reads the artist from every known shape", () => {
		expect(artistName(track("x", "Zed"))).toBe("Zed");
		expect(artistName({ subtitle: [{ text: "Sub" }] })).toBe("Sub");
		expect(artistName({ artist: "Plain" })).toBe("Plain");
		expect(artistName({})).toBe("Artiste inconnu");
	});
	it("reads album info from object, string, subtitle run and album-like playlistId", () => {
		expect(albumInfo(lib[0])).toEqual({ name: "Alpha LP", browseId: "lb-alpha" });
		expect(albumInfo(lib[3])).toEqual({ name: "Beta EP", browseId: undefined });
		expect(albumInfo(lib[4])).toEqual({ name: "Beta EP", browseId: undefined });
		expect(albumInfo(lib[5])).toEqual({ name: "", browseId: "OLAK5uy_gamma" });
		expect(albumInfo(lib[2])).toBeNull();
	});
});

describe("groupByAlbum", () => {
	it("groups by album id / name and falls back to per-artist Singles", () => {
		const groups = groupByAlbum(lib);
		const byName = Object.fromEntries(groups.map((g) => [g.key, g]));
		expect(byName["id:lb-alpha"].tracks.map((t) => t.videoId)).toEqual(["a2", "a1"]); // track order
		expect(byName["id:lb-alpha"].bytes).toBe(300);
		expect(byName["name:beta ep|beta"].tracks).toHaveLength(2);
		expect(byName["id:OLAK5uy_gamma"].name).toBe("Album");
		const singles = groups.filter((g) => g.isSingles);
		expect(singles.map((g) => g.artist).sort()).toEqual(["Alpha", "Delta"]);
		expect(singles.every((g) => g.name === "Singles")).toBe(true);
	});
	it("orders albums by most recently cached track", () => {
		const groups = groupByAlbum(lib);
		expect(groups[0].key).toBe("id:OLAK5uy_gamma");
		expect(groups[groups.length - 1].artist).toBe("Delta");
	});
	it("handles empty / junk input", () => {
		expect(groupByAlbum([])).toEqual([]);
		expect(groupByAlbum([null, undefined] as never)).toEqual([]);
	});
});

describe("groupByArtist", () => {
	it("nests albums under each artist", () => {
		const groups = groupByArtist(lib);
		const alpha = groups.find((g) => g.name === "Alpha");
		expect(alpha?.tracks).toHaveLength(3);
		expect(alpha?.albums.map((a) => a.name).sort()).toEqual(["Alpha LP", "Singles"]);
		expect(alpha?.bytes).toBe(300);
		expect(groups.map((g) => g.name)).toEqual(["Gamma", "Beta", "Alpha", "Delta"]);
	});
});

describe("shuffle", () => {
	it("returns a new permutation, deterministic with a seed", () => {
		const a = shuffle(lib, 42);
		const b = shuffle(lib, 42);
		expect(a).not.toBe(lib);
		expect(a.map((t) => t.videoId)).toEqual(b.map((t) => t.videoId));
		expect(a.map((t) => t.videoId).sort()).toEqual(lib.map((t) => t.videoId).sort());
		expect(lib[0].videoId).toBe("a1"); // input untouched
	});
});

describe("mixtape", () => {
	it("never plays the same artist twice in a row when the pool allows it", () => {
		for (let seed = 1; seed < 30; seed++) {
			const mix = mixtape(lib, { seed });
			expect(mix).toHaveLength(lib.length);
			for (let i = 1; i < mix.length; i++) {
				expect(artistName(mix[i])).not.toBe(artistName(mix[i - 1]));
			}
		}
	});
	it("caps tracks per artist", () => {
		const mix = mixtape(lib, { maxPerArtist: 1, seed: 7 });
		expect(mix).toHaveLength(4);
		expect(new Set(mix.map(artistName)).size).toBe(4);
	});
	it("degrades gracefully when one artist dominates", () => {
		const heavy = [track("h1", "H"), track("h2", "H"), track("h3", "H"), track("o1", "O")];
		const mix = mixtape(heavy, { seed: 3 });
		expect(mix).toHaveLength(4);
		expect(mix.map((t) => t.videoId).sort()).toEqual(["h1", "h2", "h3", "o1"]);
	});

	// 60 tracks, 6 artists, lengths 3:00 .. 4:50 (m:ss strings like real items).
	const big = Array.from({ length: 60 }, (_, i) => {
		const sec = 180 + (i * 11) % 111;
		return track("t" + i, "Art" + (i % 6), { length: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` });
	});

	it("hits a target duration within +10 % (30 / 60 / 90 min) and keeps artists apart", () => {
		for (const minutes of [30, 60, 90]) {
			for (let seed = 1; seed <= 20; seed++) {
				const mix = mixtape(big, { targetSec: minutes * 60, seed });
				const sum = totalDuration(mix);
				expect(sum).toBeGreaterThanOrEqual(minutes * 60 * 0.9);
				expect(sum).toBeLessThanOrEqual(minutes * 60 * 1.1);
				for (let i = 1; i < mix.length; i++) expect(artistName(mix[i])).not.toBe(artistName(mix[i - 1]));
				expect(new Set(mix.map((t) => t.videoId)).size).toBe(mix.length);
			}
		}
	});

	it("respects the target in free order too", () => {
		for (let seed = 1; seed <= 20; seed++) {
			const mix = mixtape(big, { targetSec: 1800, seed, avoidSameArtistInARow: false });
			const sum = totalDuration(mix);
			expect(sum).toBeGreaterThanOrEqual(1620);
			expect(sum).toBeLessThanOrEqual(1980);
		}
	});

	it("never exceeds +10 % even when the pool runs short, and counts unknown lengths as 3:30", () => {
		const short = [track("x1", "X"), track("y1", "Y"), track("x2", "X")]; // no length -> 210 s each
		const mix = mixtape(short, { targetSec: 400, seed: 2 });
		expect(mix).toHaveLength(2); // 420 s <= 440, a third one (630) would not fit
		const whole = mixtape(short, { targetSec: 60 * 60, seed: 2 });
		expect(whole).toHaveLength(3); // pool exhausted: shorter than the target, never longer
		expect(totalDuration(whole)).toBe(630);
	});

	it("is reproducible for a seed and changes with the seed", () => {
		const a = mixtape(big, { targetSec: 3600, seed: 11 }).map((t) => t.videoId);
		const b = mixtape(big, { targetSec: 3600, seed: 11 }).map((t) => t.videoId);
		const c = mixtape(big, { targetSec: 3600, seed: 12 }).map((t) => t.videoId);
		expect(a).toEqual(b);
		expect(a).not.toEqual(c);
	});

	it("leaves out tracks played in the last 30 days when lastPlayed is known", () => {
		const now = 1_700_000_000_000;
		const day = 86_400_000;
		const lastPlayed = new Map<string, number>([
			["a1", now - 2 * day], // recent -> out
			["a2", now - 31 * day], // old -> in
			["b1", now - 29.5 * day], // recent -> out
			// a3, b2, c1, d1 unknown -> in
		]);
		const ids = mixtape(lib, { seed: 5, lastPlayed, notPlayedSinceMs: 30 * day, now }).map((t) => t.videoId).sort();
		expect(ids).toEqual(["a2", "a3", "b2", "c1", "d1"]);
		expect(notPlayedSince(lib, lastPlayed, 30 * day, now)).toHaveLength(5);
		// Without a map the rule is a no-op.
		expect(mixtape(lib, { seed: 5, notPlayedSinceMs: 30 * day, now })).toHaveLength(lib.length);
		expect(notPlayedSince(lib, undefined, 30 * day, now)).toHaveLength(lib.length);
	});
});

describe("durations", () => {
	it("reads every duration shape and falls back to unknown", () => {
		expect(durationOf({ length: "3:45" })).toBe(225);
		expect(durationOf({ length: "1:02:03" })).toBe(3723);
		expect(durationOf({ durationSec: 200 })).toBe(200);
		expect(durationOf({ lengthSeconds: "95" })).toBe(95);
		expect(durationOf({ length: "" })).toBeUndefined();
		expect(durationOf({})).toBeUndefined();
		expect(totalDuration([{ length: "1:00" }, {}])).toBe(60 + 210);
	});
	it("formats in French", () => {
		expect(formatDuration(45)).toBe("45 s");
		expect(formatDuration(1800)).toBe("30 min");
		expect(formatDuration(3900)).toBe("1 h 05 min");
		expect(formatDuration(7200)).toBe("2 h 00 min");
	});
});

describe("recentlyCached", () => {
	it("sorts by _at desc and limits", () => {
		expect(recentlyCached(lib, 2).map((t) => t.videoId)).toEqual(["c1", "b2"]);
		expect(recentlyCached(lib, 0)).toEqual([]);
	});
});

describe("toPlayableItems", () => {
	it("clones with localUrl set and keeps only tracks really cached", () => {
		const cached = track("a1", "Alpha", { _cached: true });
		const items = toPlayableItems([
			cached,
			{ videoId: "nourl", title: "x", _cached: true },
			track("k", "K", { _offlineUrl: "", _cached: true }),
			track("p", "P", { _offlineUrl: "/vp?u=https%3A%2F%2Fr1.googlevideo.com%2Fvideoplayback%3Fexpire%3D1", _cached: false }),
			track("q", "Q", { _offlineUrl: "/vp?u=x" }), // legacy entry without _cached
		]);
		expect(items).toHaveLength(1);
		expect(items[0].videoId).toBe("a1");
		expect(items[0].localUrl).toBe("https://cdn/a1.opus");
		expect(items[0]).not.toBe(cached);
		expect((cached as { localUrl?: string }).localUrl).toBeUndefined();
	});
	it("accepts service-worker confirmation and prefers the URL the SW holds", () => {
		const confirmed = new Map<string, string>([
			["q", "/aud/q"],
			["r", ""],
		]);
		const items = toPlayableItems(
			[track("q", "Q", { _offlineUrl: "/vp?u=old", _cached: false }), track("r", "R", { _cached: false }), track("s", "S", { _cached: false })],
			confirmed,
		);
		expect(items.map((t) => t.videoId)).toEqual(["q", "r"]);
		expect(items[0].localUrl).toBe("/aud/q");
		expect(items[1].localUrl).toBe("https://cdn/r.opus");
		expect(toPlayableItems([track("s", "S", { _cached: false })], new Set(["s"]))).toHaveLength(1);
	});
	it("returns [] instead of throwing when nothing is playable", () => {
		expect(toPlayableItems([])).toEqual([]);
		expect(toPlayableItems([null, undefined, { title: "no id", _cached: true }] as never)).toEqual([]);
		expect(toPlayableItems(lib)).toEqual([]); // fixture entries carry no _cached
	});
});

describe("sizes", () => {
	it("sums _bytes only when present and formats in French units", () => {
		expect(totalBytes(lib)).toBe(350);
		expect(totalBytes([track("z", "Z")])).toBeUndefined();
		expect(formatBytes(undefined)).toBe("");
		expect(formatBytes(512)).toBe("512\u202fo");
		expect(formatBytes(3.5 * 1024 * 1024)).toBe("3,5\u202fMo");
		expect(formatBytes(200 * 1024 * 1024)).toBe("200\u202fMo");
	});
});

describe("c56a: why a selection cannot start offline", () => {
	it("names the missing service worker controller first", () => {
		const r = explainUnplayable([track("915b65e583b", "Daft", { _cached: true })], 0, { confirmed: new Map(), swController: false });
		expect(r.reason).toBe("no_sw");
		expect(r.message).toMatch(/service worker/);
		expect(r.message).toMatch(/Recharge/);
	});
	it("says 'à retélécharger' when every candidate was evicted", () => {
		const r = explainUnplayable(
			[track("915b65e583b", "Daft", { _offlineUrl: "/localf?p=a", _cached: false, _evicted: true }), track("9ff82877810", "Daft", { _offlineUrl: "/aud/9ff82877810", _cached: false })],
			0,
			{ confirmed: new Map(), swController: true },
		);
		expect(r.reason).toBe("evicted");
		expect(r.message).toMatch(/retélécharger/);
	});
	it("says 'introuvable' for a local id the service worker does not hold", () => {
		const r = explainUnplayable([track("19d6b21c8ae", "Sasha", { _cached: true })], 0, { confirmed: new Map([["other000000", "/localf?p=x"]]), swController: true });
		expect(r.reason).toBe("unknown");
		expect(r.message).toBe("Titre local introuvable dans le cache hors-ligne.");
	});
	it("falls back to the empty-selection line", () => {
		expect(explainUnplayable([], 0, { swController: true }).reason).toBe("empty");
		expect(explainUnplayable([track("vid", "A", { _cached: false })], 0, { swController: true }).reason).toBe("empty");
	});
	it("playWithReason carries the reason instead of a bare false, and play() stays boolean", async () => {
		// `_cached: false` and not confirmed by the SW: nothing playable, so the reason is explained without touching the player.
		const r = await playWithReason([track("19d6b21c8ae", "Sasha", { _cached: false })], 0, { confirmed: new Map(), swController: false });
		expect(r).toEqual({ ok: false, reason: "no_sw", message: OFFLINE_PLAY_MESSAGES.no_sw });
		expect(await play([], 0, { confirmed: new Map() })).toBe(false);
	});
	it("offlinePlayErrorMessage names a stale chunk after a deploy, else keeps the error text", () => {
		expect(offlinePlayErrorMessage(new TypeError("Failed to fetch dynamically imported module: /_app/immutable/chunks/index.x.js"))).toMatch(/Nouvelle version/);
		expect(offlinePlayErrorMessage(new Error("boom"))).toBe("Lecture hors-ligne impossible : boom");
		expect(offlinePlayErrorMessage(undefined)).toBe("Lecture hors-ligne impossible.");
	});
});
