import { describe, expect, it } from "vitest";
import { isYouTubeAlbumId, parseOwnedMatch } from "./alreadyOwned";

describe("alreadyOwned", () => {
	it("only YouTube album ids ask the library", () => {
		expect(isYouTubeAlbumId("MPREb_abc")).toBe(true);
		expect(isYouTubeAlbumId("lb-0123456789ab")).toBe(false);
		expect(isYouTubeAlbumId("")).toBe(false);
		expect(isYouTubeAlbumId(null)).toBe(false);
	});
	it("keeps a local lb- match and builds its /release link", () => {
		const m = parseOwnedMatch({ match: { id: "lb-0123456789ab", title: "Discovery", artist: "Daft Punk", trackCount: 14, thumbnail: "/cover?lid=x", href: "/x" } });
		expect(m).toEqual({ id: "lb-0123456789ab", title: "Discovery", artist: "Daft Punk", trackCount: 14, thumbnail: "/cover?lid=x", href: "/release?id=lb-0123456789ab" });
	});
	it("no banner without a strong local match", () => {
		expect(parseOwnedMatch({ match: null })).toBeNull();
		expect(parseOwnedMatch({})).toBeNull();
		expect(parseOwnedMatch(null)).toBeNull();
		expect(parseOwnedMatch({ match: { id: "MPREb_x" } })).toBeNull();
	});
});
