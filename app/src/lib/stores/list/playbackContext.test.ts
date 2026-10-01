import { describe, expect, it } from "vitest";
import { continuedContext, describeContext, makeContext, normalizeContext, playAllContextFor } from "./playbackContext";

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

describe("decade kind (c29b D1)", () => {
	it("is a known kind with its own label", () => {
		const c = makeContext({ kind: "decade", title: "Années 1990", href: "/library/mixes" }, album);
		expect(c?.kind).toBe("decade");
		expect(normalizeContext({ kind: "decade", title: "Années 1990", href: "/library/mixes", ids: ["a1"] })?.kind).toBe("decade");
		expect(describeContext(c, album, 0)?.label).toBe("Décennie : Années 1990 · 1/4");
		expect(describeContext(c, album, 0)?.href).toBe("/library/mixes");
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

describe("I8: context after a continuation and on Lire tout", () => {
	const t = (id: string) => ({ videoId: id });
	it("a continued album becomes the extended queue with the right total", () => {
		const album = [t("a"), t("b"), t("c")];
		const ctx = makeContext({ kind: "album", title: "Discovery", href: "/release?id=x" }, album);
		const mix = [...album, t("x"), t("y")];
		// before the fix: header only, no counter, on the appended rows
		expect(describeContext(ctx, mix, 3)!.label).toBe("Album : Discovery");
		const next = continuedContext(ctx, mix);
		const view = describeContext(next, mix, 3)!;
		expect(view.label).toBe("File : Suite · 4/5");
		expect(view.total).toBe(5);
		expect(view.interrupted).toBe(false);
		expect(continuedContext(null, mix)).toBeNull();
	});
	it("derives Favoris / Playlist / Artiste from the page", () => {
		expect(playAllContextFor("/library/saved", "x")).toEqual({ kind: "favorites", title: "Favoris", href: "/library/saved" });
		expect(playAllContextFor("/library/playlists-srv/12", " Road ")).toEqual({
			kind: "playlist",
			title: "Road",
			href: "/library/playlists-srv/12",
		});
		expect(playAllContextFor("/artist/UCabc", "Daft Punk")?.kind).toBe("artist");
		expect(playAllContextFor("/home", "x")).toBeNull();
		expect(playAllContextFor(undefined)).toBeNull();
		const ctx = makeContext(playAllContextFor("/library/saved"), [t("a"), t("b"), t("c")]);
		expect(describeContext(ctx, [t("a"), t("b"), t("c")], 1)!.label).toBe("Favoris · 2/3");
		const art = makeContext(playAllContextFor("/artist/UCabc", "Daft Punk"), [t("a"), t("b")]);
		expect(describeContext(art, [t("a"), t("b")], 0)!.label).toBe("Artiste : Daft Punk · 1/2");
	});
});

describe("crossover kind (c39b B6-2)", () => {
	it("reads Mix : <genre> des années <decade>", () => {
		const c = makeContext({ kind: "crossover", title: "Rock des années 1990", href: "/library/mixes" }, [{ videoId: "a1" }, { videoId: "a2" }]);
		expect(normalizeContext(c)?.kind).toBe("crossover");
		expect(describeContext(c, [{ videoId: "a1" }, { videoId: "a2" }], 0)?.label).toBe("Mix : Rock des années 1990 · 1/2");
	});
});

describe("year kind (c39b B6-3)", () => {
	it("reads Année : 1997", () => {
		const c = makeContext({ kind: "year", title: "1997", href: "/library/mixes" }, [{ videoId: "a1" }]);
		expect(normalizeContext(c)?.kind).toBe("year");
		expect(describeContext(c, [{ videoId: "a1" }], 0)?.label).toBe("Année : 1997 · 1/1");
	});
});
