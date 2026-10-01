import { describe, expect, it } from "vitest";
import { albumOfDayFrom, albumOfDayHref, albumOfDayLine, utcDay } from "./albumOfDay";

const album = { title: "Discovery", browseId: "lb-0123456789ab", subtitle: [{ text: "Daft Punk", pageType: "MUSIC_PAGE_TYPE_ARTIST" }], thumbnails: [{ url: "/cover?lid=x" }] };

describe("albumOfDayFrom (c39b B6-1)", () => {
	it("parses the endpoint answer", () => {
		const a = albumOfDayFrom({ album, year: "2001", date: "2026-10-01", tracks: [{ videoId: "e182ccc85ad", title: "One More Time" }, { title: "no id" }], reason: "du jour" });
		expect(a?.album.title).toBe("Discovery");
		expect(a?.year).toBe("2001");
		expect(a?.date).toBe("2026-10-01");
		expect(a?.tracks).toHaveLength(1);
		expect(albumOfDayHref(a!)).toBe("/release?id=lb-0123456789ab");
	});

	it("rejects empty, YouTube or malformed answers", () => {
		expect(albumOfDayFrom(null)).toBeNull();
		expect(albumOfDayFrom({ album: null, reason: "empty", date: "2026-10-01" })).toBeNull();
		expect(albumOfDayFrom({ album: { ...album, browseId: "MPREb_x" }, date: "2026-10-01" })).toBeNull();
		expect(albumOfDayFrom({ album: { ...album, title: "" }, date: "2026-10-01" })).toBeNull();
		expect(albumOfDayFrom({ album, date: "01/10/2026" })).toBeNull();
		expect(albumOfDayFrom({ album, date: "2026-10-01", year: 1997 })?.year).toBe("");
	});

	it("formats the card line and the UTC day", () => {
		expect(albumOfDayLine("Daft Punk", "2001")).toBe("Daft Punk · 2001");
		expect(albumOfDayLine("Daft Punk", "")).toBe("Daft Punk");
		expect(albumOfDayLine("", "2001")).toBe("2001");
		expect(utcDay(new Date("2026-10-01T23:30:00-02:00"))).toBe("2026-10-02");
	});
});
