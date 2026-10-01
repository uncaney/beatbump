import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/utils", () => ({ notify: vi.fn() }));

import { shareLink } from "./shareLink";
import { weekShareCopy, weekShareData, weekShareText } from "./shareWeek";

const NNBSP = " ";
const NBSP = " ";

describe("weekShareText", () => {
	it("says minutes, titles and the top artist", () => {
		expect(weekShareText({ minutes: 212.4, tracks: 34, topArtist: "Daft Punk" })).toBe(
			`Cette semaine : 212${NNBSP}min, 34${NBSP}titres, artiste n°1 Daft Punk`,
		);
	});
	it("drops a missing artist and keeps the singular", () => {
		expect(weekShareText({ minutes: 4, tracks: 1, topArtist: " " })).toBe(`Cette semaine : 4${NNBSP}min, 1${NBSP}titre`);
		expect(weekShareText({ minutes: 1500, tracks: 0, topArtist: "" })).toContain(`1${NNBSP}500${NNBSP}min`);
	});
	it("links the top album when it has an id, else the site", () => {
		const d = weekShareData({ minutes: 212, tracks: 34, topArtist: "Daft Punk", topAlbumId: "lb-0123456789ab" }, "https://music.ekaii.fr");
		expect(d.url).toBe("https://music.ekaii.fr/release?id=lb-0123456789ab");
		expect(d.text).toContain("min");
		expect(weekShareData({ minutes: 1, tracks: 1, topArtist: "" }, "https://music.ekaii.fr/").url).toBe("https://music.ekaii.fr/");
		expect(weekShareCopy(d)).toBe(`${d.text}\nhttps://music.ekaii.fr/release?id=lb-0123456789ab`);
	});
	it("copies text + link with a 'Copié' toast without Web Share", async () => {
		const toast = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		const d = weekShareData({ minutes: 212, tracks: 34, topArtist: "Daft Punk" }, "https://x");
		const out = await shareLink(d, { clipboard: { writeText } } as any, toast, { copyText: weekShareCopy(d), copiedToast: "Copié" });
		expect(out).toBe("copied");
		expect(writeText).toHaveBeenCalledWith(weekShareCopy(d));
		expect(toast).toHaveBeenCalledWith("Copié", "success");
	});
	it("hands text and url to the native sheet", async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		const d = weekShareData({ minutes: 212, tracks: 34, topArtist: "Daft Punk", topAlbumId: "lb-x" }, "https://x");
		expect(await shareLink(d, { share } as any, vi.fn())).toBe("shared");
		expect(share).toHaveBeenCalledWith(d);
	});
});
