import { describe, expect, it } from "vitest";
import { describeContext, makeContext, normalizeContext } from "./playbackContext";

const row = (videoId: string) => ({ videoId });
const album = ["a1", "a2", "a3", "a4"].map(row);

describe("makeContext / normalizeContext", () => {
	it("records the source ids", () => {
		const c = makeContext({ kind: "album", title: "Discovery", href: "/release?id=x" }, album);
		expect(c?.ids).toEqual(["a1", "a2", "a3", "a4"]);
	});
	it("rejects unknown kinds and foreign hrefs", () => {
		expect(makeContext({ kind: "nope" as never, title: "", href: "" }, album)).toBeNull();
		expect(normalizeContext({ kind: "x" })).toBeNull();
		expect(normalizeContext(null)).toBeNull();
		expect(normalizeContext({ kind: "album", title: "T", href: "https://evil", ids: [1, "a"] })).toEqual({
			kind: "album",
			title: "T",
			href: "",
			ids: ["", "a"],
		});
	});
	it("caps ids to 500", () => {
		const big = Array.from({ length: 900 }, (_, i) => row("v" + i));
		expect(makeContext({ kind: "queue", title: "", href: "" }, big)?.ids.length).toBe(500);
	});
});

describe("describeContext", () => {
	const ctx = makeContext({ kind: "album", title: "Discovery", href: "/release?id=x" }, album);

	it("album counter", () => {
		const v = describeContext(ctx, album, 3);
		expect(v?.label).toBe("Album : Discovery · 4/4");
		expect(v?.href).toBe("/release?id=x");
		expect(v?.interrupted).toBe(false);
	});

	it("label without a redundant title", () => {
		const fav = makeContext({ kind: "favorites", title: "Favoris", href: "/favorites" }, album);
		expect(describeContext(fav, album, 0)?.label).toBe("Favoris · 1/4");
	});

	it("'Lire ensuite' interrupts: return to the next album track", () => {
		const mix = [row("a1"), row("x"), row("a2"), row("a3")];
		const v = describeContext(ctx, mix, 1);
		expect(v?.interrupted).toBe(true);
		expect(v?.label).toBe("Album : Discovery");
		expect(v?.returnIndex).toBe(2);
		expect(v?.returnLabel).toBe("Revenir à l'album");
	});

	it("no return when nothing of the album is left", () => {
		const mix = [row("a1"), row("x")];
		const v = describeContext(ctx, mix, 1);
		expect(v?.returnIndex).toBe(-1);
		expect(v?.returnLabel).toBe("");
	});

	it("plain queue reads 'File · n/m', single track nothing", () => {
		expect(describeContext(null, album, 1)?.label).toBe("File · 2/4");
		expect(describeContext(null, [row("a")], 0)).toBeNull();
		expect(describeContext(ctx, [], 0)).toBeNull();
	});
});
