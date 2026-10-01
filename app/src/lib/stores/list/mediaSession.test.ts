import { describe, expect, it } from "vitest";
import { mediaArtwork, positionState, seekTarget } from "./mediaSession";

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

describe("mediaArtwork", () => {
	const origin = "https://music.example";
	it("local cover first at 512 px, absolute", () => {
		const art = mediaArtwork(
			{ videoId: "0123456789a", thumbnails: [{ url: "/cover?lid=fedcba98765" }] },
			origin,
		);
		expect(art).toEqual([{ src: "https://music.example/cover?lid=fedcba98765", sizes: "512x512", type: "image/jpeg" }]);
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
		expect(art.map((a) => a.src)).toEqual(["https://i/l.jpg", "https://i/s.jpg"]);
		expect(art[0].sizes).toBe("544x544");
		expect(thumbnails[0].url).toBe("https://i/s.jpg");
	});
});
