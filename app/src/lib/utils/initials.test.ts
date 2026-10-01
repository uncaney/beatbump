import { describe, expect, it } from "vitest";
import { coverLabel, hueFor, initials } from "./initials";

describe("initials", () => {
	it("takes the first letter of the first two words, uppercased", () => {
		expect(initials("Daft Punk")).toBe("DP");
		expect(initials("the best of michael jackson")).toBe("TB");
	});
	it("takes the first two letters of a single word", () => {
		expect(initials("Discovery")).toBe("DI");
		expect(initials("x")).toBe("X");
	});
	it("ignores punctuation and empty input", () => {
		expect(initials("  (Random) Access -- Memories ")).toBe("RA");
		expect(initials("")).toBe("");
		expect(initials(undefined)).toBe("");
		expect(initials("...")).toBe("");
	});
	it("handles accents and non-latin letters", () => {
		expect(initials("Édith Piaf")).toBe("ÉP");
		expect(initials("坂本龍一")).toBe("坂本");
	});
});

describe("hueFor", () => {
	it("is deterministic and in [0, 360)", () => {
		for (const s of ["Daft Punk", "Discovery", "", "a", "Édith Piaf"]) {
			const h = hueFor(s);
			expect(h).toBe(hueFor(s));
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
			expect(Number.isInteger(h)).toBe(true);
		}
	});
	it("ignores case and surrounding spaces, differs between names", () => {
		expect(hueFor("  Daft Punk ")).toBe(hueFor("daft punk"));
		expect(hueFor("Daft Punk")).not.toBe(hueFor("Discovery"));
	});
});

describe("coverLabel", () => {
	it("uses the title for album / artist / playlist entities", () => {
		expect(coverLabel({ title: "Discovery", endpoint: { pageType: "MUSIC_PAGE_TYPE_ALBUM" } })).toBe("Discovery");
		expect(coverLabel({ title: "Daft Punk", endpoint: { pageType: "MUSIC_PAGE_TYPE_ARTIST" } })).toBe("Daft Punk");
		expect(coverLabel({ title: "Mix", type: "playlists" })).toBe("Mix");
	});
	it("prefers the album, then the artist, then the title for tracks", () => {
		expect(coverLabel({ title: "One More Time", album: { text: "Discovery" }, subtitle: [{ text: "Daft Punk" }] })).toBe("Discovery");
		expect(
			coverLabel({
				title: "One More Time",
				subtitle: [{ text: "Song" }, { text: "Daft Punk", pageType: "MUSIC_PAGE_TYPE_ARTIST" }],
			}),
		).toBe("Daft Punk");
		expect(coverLabel({ title: "One More Time", artistInfo: { artist: [{ text: "Daft Punk" }] } })).toBe("Daft Punk");
		expect(coverLabel({ title: "One More Time" })).toBe("One More Time");
	});
	it("never throws on junk", () => {
		expect(coverLabel(null)).toBe("");
		expect(coverLabel({ album: {}, subtitle: [null, {}] })).toBe("");
	});
});
