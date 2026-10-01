import { describe, expect, it } from "vitest";
import { firstUrl, idsFromUrl, parseSharedLink } from "./shareTarget";

describe("idsFromUrl", () => {
	it("reads v= / list= from watch, music and playlist URLs", () => {
		expect(idsFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ v: "dQw4w9WgXcQ" });
		expect(idsFromUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ")).toEqual({ v: "dQw4w9WgXcQ", list: "RDAMVMdQw4w9WgXcQ" });
		expect(idsFromUrl("https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")).toEqual({ list: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" });
	});
	it("reads youtu.be, shorts and our own /listen links", () => {
		expect(idsFromUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")).toEqual({ v: "dQw4w9WgXcQ" });
		expect(idsFromUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toEqual({ v: "dQw4w9WgXcQ" });
		expect(idsFromUrl("https://music.ekaii.fr/listen?id=dQw4w9WgXcQ&list=OLAK5uy_abc")).toEqual({ v: "dQw4w9WgXcQ", list: "OLAK5uy_abc" });
	});
	it("ignores malformed ids and non-URLs", () => {
		expect(idsFromUrl("https://www.youtube.com/watch?v=short")).toEqual({});
		expect(idsFromUrl("not a url")).toEqual({});
		expect(idsFromUrl("")).toEqual({});
	});
});

describe("firstUrl", () => {
	it("finds the link inside shared text and strips trailing punctuation", () => {
		expect(firstUrl("Écoute ça : https://youtu.be/dQw4w9WgXcQ.")).toBe("https://youtu.be/dQw4w9WgXcQ");
		expect(firstUrl("rien ici")).toBe("");
	});
});

describe("parseSharedLink", () => {
	it("routes a video to /listen?id= (with its list) and a playlist to /playlist/<list>", () => {
		expect(parseSharedLink({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).toEqual({ kind: "track", id: "dQw4w9WgXcQ", list: undefined, href: "/listen?id=dQw4w9WgXcQ" });
		expect(parseSharedLink({ text: "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ" })).toEqual({
			kind: "track",
			id: "dQw4w9WgXcQ",
			list: "RDAMVMdQw4w9WgXcQ",
			href: "/listen?id=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ",
		});
		expect(parseSharedLink({ text: "https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })).toEqual({
			kind: "playlist",
			id: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
			href: "/playlist/PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
		});
	});
	it("prefers url over text, finds the link inside a sentence (Android puts it in text), accepts a bare id", () => {
		expect(parseSharedLink({ url: "https://youtu.be/aaaaaaaaaaa", text: "https://youtu.be/bbbbbbbbbbb" })?.id).toBe("aaaaaaaaaaa");
		expect(parseSharedLink({ title: "Never Gonna Give You Up", text: "Regarde « Never Gonna Give You Up » sur YouTube https://youtu.be/dQw4w9WgXcQ?si=x" })?.href).toBe("/listen?id=dQw4w9WgXcQ");
		expect(parseSharedLink({ text: "dQw4w9WgXcQ" })?.href).toBe("/listen?id=dQw4w9WgXcQ");
	});
	it("returns null for anything else", () => {
		expect(parseSharedLink({})).toBeNull();
		expect(parseSharedLink({ title: "hello", text: "https://example.com/page" })).toBeNull();
		expect(parseSharedLink({ url: "https://www.youtube.com/" })).toBeNull();
		expect(parseSharedLink({ text: 42 })).toBeNull();
	});
});
