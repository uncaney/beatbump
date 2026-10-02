import { describe, expect, it } from "vitest";
import {
	ARTIST_OF_DAY_ROW,
	artistOfDayFrom,
	artistOfDayHref,
	artistOfDayId,
	artistOfDayLine,
	artistOfDaySongsUrl,
	artistOfDaySubheading,
} from "./artistOfDay";
import { HOME_ROW_ORDER, HOME_ROW_PRIORITY, arrangeHomeRows } from "./homeRows";

const card = (id = "la-c7e84a3742d0", title = "Daft Punk") => ({
	title,
	browseId: id,
	type: "artist",
	endpoint: { browseId: id, pageType: "MUSIC_PAGE_TYPE_ARTIST" },
	thumbnails: [{ url: "/api/v1/local/cover/abc", width: 226, height: 226 }],
});

describe("artistOfDayFrom (c44a B7-1)", () => {
	it("parses the endpoint answer", () => {
		const a = artistOfDayFrom({ artist: card(), name: "Daft Punk", albumCount: 3, trackCount: 31, scope: "profile", reason: "du jour", date: "2026-10-02" });
		expect(a).not.toBeNull();
		expect(a?.name).toBe("Daft Punk");
		expect(a?.albumCount).toBe(3);
		expect(a?.trackCount).toBe(31);
		expect(a?.scope).toBe("profile");
		expect(a?.reason).toBe("du jour");
		expect(a?.date).toBe("2026-10-02");
		expect(artistOfDayId(a!)).toBe("la-c7e84a3742d0");
		expect(artistOfDayHref(a!)).toBe("/artist/la-c7e84a3742d0");
	});

	it("falls back to the card title and the library scope, rounds the counts", () => {
		const a = artistOfDayFrom({ artist: card("la-1", "  Air "), albumCount: 2.4, trackCount: "x", scope: "weird", date: "2026-10-02" });
		expect(a?.name).toBe("Air");
		expect(a?.albumCount).toBe(2);
		expect(a?.trackCount).toBe(0);
		expect(a?.scope).toBe("library");
		expect(a?.reason).toBe("");
	});

	it("rejects empty, YouTube or malformed answers", () => {
		expect(artistOfDayFrom(null)).toBeNull();
		expect(artistOfDayFrom({ artist: null, reason: "empty", date: "2026-10-02" })).toBeNull();
		expect(artistOfDayFrom({ artist: card("UCabc"), name: "YouTube", date: "2026-10-02" })).toBeNull();
		expect(artistOfDayFrom({ artist: card("la-1", ""), date: "2026-10-02" })).toBeNull();
		expect(artistOfDayFrom({ artist: card(), name: "Daft Punk", date: "today" })).toBeNull();
	});

	it("formats the line, the subheading and the mix url", () => {
		expect(artistOfDayLine(3, 31)).toBe("3 albums · 31 titres");
		expect(artistOfDayLine(1, 0)).toBe("1 album");
		expect(artistOfDayLine(0, 0)).toBe("");
		expect(artistOfDaySubheading({ scope: "profile", reason: "du jour" })).toMatch(/jamais écouté/);
		expect(artistOfDaySubheading({ scope: "profile", reason: "all_played" })).toMatch(/tout écouté/);
		expect(artistOfDaySubheading({ scope: "library", reason: "du jour" })).toMatch(/tout le monde/);
		expect(artistOfDaySongsUrl({ name: "Daft Punk" })).toBe("/api/v1/local/songs?artist=Daft%20Punk&limit=200");
		expect(artistOfDaySongsUrl({ name: "AC/DC" }, 50)).toBe("/api/v1/local/songs?artist=AC%2FDC&limit=50");
	});

	it("takes a bonus slot right after the album of the day", () => {
		expect(HOME_ROW_ORDER.indexOf(ARTIST_OF_DAY_ROW)).toBe(HOME_ROW_ORDER.indexOf("album-du-jour") + 1);
		expect(HOME_ROW_PRIORITY.indexOf(ARTIST_OF_DAY_ROW)).toBe(HOME_ROW_PRIORITY.indexOf("album-du-jour") + 1);
		const albums = (k: string) => [1, 2, 3, 4].map((i) => ({ browseId: `lb-${k}${i}`, title: `${k}${i}`, thumbnails: [] }));
		const out = arrangeHomeRows([
			{ key: "reprendre", items: [{ videoId: "v1", title: "v1", thumbnails: [] }] },
			{ key: "pour-toi", items: [{ videoId: "v2", title: "v2", thumbnails: [] }] },
			{ key: "album-du-jour", items: [{ browseId: "lb-z", title: "z", thumbnails: [] }], bonusSlot: true },
			{ key: ARTIST_OF_DAY_ROW, items: [card()], bonusSlot: true },
			{ key: "recemment-acquis", items: albums("a") },
			{ key: "nouveautes-artistes", items: albums("b") },
			{ key: "jamais-ecoute", items: albums("c") },
		]);
		expect(out.visible.map((r) => r.key)).toEqual(["reprendre", "pour-toi", "album-du-jour", ARTIST_OF_DAY_ROW, "recemment-acquis", "nouveautes-artistes"]);
		expect(out.more.map((r) => r.key)).toEqual(["jamais-ecoute"]);
	});
});
