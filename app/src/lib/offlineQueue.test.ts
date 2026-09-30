import { describe, expect, it } from "vitest";
import {
	albumInfo,
	artistName,
	formatBytes,
	groupByAlbum,
	groupByArtist,
	mixtape,
	recentlyCached,
	shuffle,
	toPlayableItems,
	totalBytes,
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
});

describe("recentlyCached", () => {
	it("sorts by _at desc and limits", () => {
		expect(recentlyCached(lib, 2).map((t) => t.videoId)).toEqual(["c1", "b2"]);
		expect(recentlyCached(lib, 0)).toEqual([]);
	});
});

describe("toPlayableItems", () => {
	it("clones with localUrl set and drops items without a cached url", () => {
		const items = toPlayableItems([lib[0], { videoId: "nourl", title: "x" }, track("k", "K", { _offlineUrl: "" })]);
		expect(items).toHaveLength(1);
		expect(items[0].localUrl).toBe("https://cdn/a1.opus");
		expect(items[0]).not.toBe(lib[0]);
		expect((lib[0] as { localUrl?: string }).localUrl).toBeUndefined();
	});
});

describe("sizes", () => {
	it("sums _bytes only when present and formats in French units", () => {
		expect(totalBytes(lib)).toBe(350);
		expect(totalBytes([track("z", "Z")])).toBeUndefined();
		expect(formatBytes(undefined)).toBe("");
		expect(formatBytes(512)).toBe("512 o");
		expect(formatBytes(3.5 * 1024 * 1024)).toBe("3,5 Mo");
		expect(formatBytes(200 * 1024 * 1024)).toBe("200 Mo");
	});
});
