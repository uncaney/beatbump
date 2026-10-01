import { describe, expect, it } from "vitest";
import { ARTWORK_SIZES, mediaArtwork, mediaMetadataFields, mediaSessionSeekTarget, positionState, previousAction, seekTarget } from "./mediaSession";

describe("positionState", () => {
	it("clamps the position and defaults the rate", () => {
		expect(positionState(40, 200)).toEqual({ duration: 200, position: 40, playbackRate: 1 });
		expect(positionState(250, 200, 1.5)).toEqual({ duration: 200, position: 200, playbackRate: 1.5 });
		expect(positionState(-3, 200, 0)).toEqual({ duration: 200, position: 0, playbackRate: 1 });
	});
	it("null for an unknown duration", () => {
		expect(positionState(1, 0)).toBeNull();
		expect(positionState(1, NaN)).toBeNull();
		expect(positionState(1, Infinity)).toBeNull();
	});
});

describe("seekTarget (±10 s)", () => {
	it("stays inside the track", () => {
		expect(seekTarget(40, -10, 200)).toBe(30);
		expect(seekTarget(5, -10, 200)).toBe(0);
		expect(seekTarget(195, 10, 200)).toBe(200);
		expect(seekTarget(40, 10, NaN)).toBe(50);
	});
});

describe("mediaSessionSeekTarget (B6-8)", () => {
	it("seekto 0 seeks to the start", () => {
		expect(mediaSessionSeekTarget({ action: "seekto", seekTime: 0 }, 40, 200)).toBe(0);
	});
	it("seekto clamps and ignores a missing or bad time", () => {
		expect(mediaSessionSeekTarget({ action: "seekto", seekTime: 250 }, 40, 200)).toBe(200);
		expect(mediaSessionSeekTarget({ action: "seekto", seekTime: -2 }, 40, 200)).toBe(0);
		expect(mediaSessionSeekTarget({ action: "seekto" }, 40, 200)).toBeNull();
		expect(mediaSessionSeekTarget({ action: "seekto", seekTime: NaN }, 40, 200)).toBeNull();
		expect(mediaSessionSeekTarget({ action: "seekto", seekTime: "3" }, 40, 200)).toBeNull();
		expect(mediaSessionSeekTarget({ action: "seekto", seekTime: 90 }, 40, NaN)).toBe(90);
	});
	it("seekbackward / seekforward default to 10 s", () => {
		expect(mediaSessionSeekTarget({ action: "seekbackward" }, 40, 200)).toBe(30);
		expect(mediaSessionSeekTarget({ action: "seekforward" }, 40, 200)).toBe(50);
		expect(mediaSessionSeekTarget({ action: "seekforward", seekOffset: 0 }, 40, 200)).toBe(50);
		expect(mediaSessionSeekTarget({ action: "seekbackward", seekOffset: 30 }, 40, 200)).toBe(10);
		expect(mediaSessionSeekTarget({ action: "seekbackward" }, 4, 200)).toBe(0);
		expect(mediaSessionSeekTarget({ action: "seekforward" }, 195, 200)).toBe(200);
	});
	it("null for other actions or no details", () => {
		expect(mediaSessionSeekTarget({ action: "play" }, 40, 200)).toBeNull();
		expect(mediaSessionSeekTarget(null, 40, 200)).toBeNull();
	});
});

describe("previousAction (B6-8)", () => {
	it("restarts the track after 3 s", () => {
		expect(previousAction(40, 5)).toBe("restart");
		expect(previousAction(3.2, 1)).toBe("restart");
	});
	it("goes to the previous track in the first 3 s", () => {
		expect(previousAction(3, 5)).toBe("previous");
		expect(previousAction(0.5, 1)).toBe("previous");
		expect(previousAction(NaN, 2)).toBe("previous");
	});
	it("restarts the first track of the queue", () => {
		expect(previousAction(1, 0)).toBe("restart");
	});
});

describe("mediaArtwork", () => {
	const origin = "https://music.example";
	it("local cover first at 512 px, absolute", () => {
		const art = mediaArtwork(
			{ videoId: "0123456789a", thumbnails: [{ url: "/cover?lid=fedcba98765" }] },
			origin,
		);
		expect(art.map((a) => a.sizes)).toEqual(["512x512", "384x384", "256x256", "192x192", "96x96"]);
		expect(new Set(art.map((a) => a.src))).toEqual(new Set(["https://music.example/cover?lid=fedcba98765"]));
		expect(art.every((a) => a.type === "image/jpeg")).toBe(true);
	});
	it("builds the cover from a lid without thumbnails", () => {
		expect(mediaArtwork({ videoId: "0123456789a" }, origin)[0].src).toBe("https://music.example/cover?lid=0123456789a");
	});
	it("YouTube rows: largest thumbnail first, input untouched", () => {
		const thumbnails = [
			{ url: "https://i/s.jpg", width: 60, height: 60 },
			{ url: "https://i/l.jpg", width: 544, height: 544 },
		];
		const art = mediaArtwork({ videoId: "dQw4w9WgXcQ", thumbnails }, origin);
		// the 60 px thumbnail is dropped while a larger one exists (B6-26)
		expect(art.map((a) => a.src)).toEqual(["https://i/l.jpg"]);
		expect(art[0].sizes).toBe("544x544");
		expect(thumbnails[0].url).toBe("https://i/s.jpg");
	});
	it("keeps a lone small thumbnail rather than nothing", () => {
		const art = mediaArtwork({ videoId: "dQw4w9WgXcQ", thumbnails: [{ url: "https://i/s.jpg", width: 60, height: 60 }] }, origin);
		expect(art.map((a) => a.src)).toEqual(["https://i/s.jpg"]);
	});
	it("googleusercontent thumbnails: one URL per declared size, largest first", () => {
		const thumbnails = [
			{ url: "https://lh3.googleusercontent.com/abc=w60-h60-l90-rj", width: 60, height: 60 },
			{ url: "https://lh3.googleusercontent.com/abc=w120-h120-l90-rj", width: 120, height: 120 },
		];
		const art = mediaArtwork({ videoId: "dQw4w9WgXcQ", thumbnails }, origin);
		expect(art.map((a) => a.sizes)).toEqual(ARTWORK_SIZES.map((s) => `${s}x${s}`));
		expect(art[0].src).toBe("https://lh3.googleusercontent.com/abc=w512-h512-l90-rj");
		expect(art[4].src).toBe("https://lh3.googleusercontent.com/abc=w96-h96-l90-rj");
		expect(thumbnails[0].url).toBe("https://lh3.googleusercontent.com/abc=w60-h60-l90-rj");
	});
	it("local cover, then the row thumbnails above 96 px", () => {
		const art = mediaArtwork(
			{ videoId: "0123456789a", thumbnails: [{ url: "https://i/s.jpg", width: 60, height: 60 }, { url: "https://i/m.jpg", width: 226, height: 226 }] },
			origin,
		);
		expect(art).toHaveLength(6);
		expect(art[0].src).toBe("https://music.example/cover?lid=0123456789a");
		expect(art[5].src).toBe("https://i/m.jpg");
	});
});

describe("mediaMetadataFields (B6-26)", () => {
	it("joins every artist and reads the album title", () => {
		expect(
			mediaMetadataFields({
				title: "Get Lucky",
				artistInfo: { artist: [{ text: "Daft Punk" }, { text: "&" }, { text: "Pharrell Williams" }] },
				album: { title: "Random Access Memories" },
			}),
		).toEqual({ title: "Get Lucky", artist: "Daft Punk, Pharrell Williams", album: "Random Access Memories" });
	});
	it("falls back to the subtitle artist, a slimmed album and the album queue", () => {
		expect(
			mediaMetadataFields({ title: "A", subtitle: [{ text: "Air", pageType: "MUSIC_PAGE_TYPE_ARTIST" }], album: { text: "Moon Safari" } }),
		).toEqual({ title: "A", artist: "Air", album: "Moon Safari" });
		expect(
			mediaMetadataFields({ title: "B", videoId: "0123456789a", artist: "Air" }, { kind: "album", title: "Talkie Walkie", ids: ["0123456789a"] }),
		).toEqual({ title: "B", artist: "Air", album: "Talkie Walkie" });
		expect(
			mediaMetadataFields({ title: "C", videoId: "zzzzzzzzzzz" }, { kind: "album", title: "Talkie Walkie", ids: ["0123456789a"] }).album,
		).toBe("");
	});
	it("empty for no track", () => {
		expect(mediaMetadataFields(null)).toEqual({ title: "", artist: "", album: "" });
	});
});
