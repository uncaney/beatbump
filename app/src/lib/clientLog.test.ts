import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../env", () => ({ SERVER_DOMAIN: "" }));

import {
	CLIENT_LOG_MAX_BODY,
	CLIENT_LOG_MAX_MESSAGE,
	_setClientLogSender,
	buildClientLogPayload,
	clientLogKey,
	describeThrown,
	pageLocationPath,
	reportClientError,
	shouldReport,
} from "./clientLog";

describe("ST3 clientLog: payload", () => {
	it("clips every field and drops a stack equal to the message", () => {
		const p = buildClientLogPayload("error", " boom ", { stack: "boom", url: "/y", ua: "UA" });
		expect(p).toEqual({ kind: "error", message: "boom", url: "/y", ua: "UA" });
		const long = buildClientLogPayload("media", "m".repeat(5000), { stack: "s".repeat(5000), url: "u".repeat(900), ua: "a".repeat(400) });
		expect(long!.message.length).toBe(CLIENT_LOG_MAX_MESSAGE);
		expect(long!.message.length).toBe(500); // L8-17
		expect(long!.stack!.length).toBe(2000);
		expect(long!.url!.length).toBe(256);
		expect(long!.ua!.length).toBe(250);
		expect(JSON.stringify(long).length).toBeLessThan(CLIENT_LOG_MAX_BODY);
	});
	it("L8-17: reports the pathname only, never the query or the fragment", () => {
		expect(pageLocationPath("https://music.ekaii.fr/search/abba?filter=songs#top")).toBe("/search/abba");
		expect(pageLocationPath("https://music.ekaii.fr/listen?id=dQw4w9WgXcQ")).toBe("/listen");
		expect(pageLocationPath({ pathname: "/home", href: "https://music.ekaii.fr/home?x=1" })).toBe("/home");
		expect(pageLocationPath({ href: "https://music.ekaii.fr/library/albums?sort=album:asc" })).toBe("/library/albums");
		expect(pageLocationPath("/listen?id=x#y")).toBe("/listen");
		expect(pageLocationPath("")).toBe("");
		expect(pageLocationPath(undefined)).toBe("");
	});
	it("needs a message, defaults the kind", () => {
		expect(buildClientLogPayload("error", "")).toBeNull();
		expect(buildClientLogPayload("error", undefined)).toBeNull();
		expect(buildClientLogPayload("", "x")!.kind).toBe("error");
	});
	it("describes whatever was thrown", () => {
		const e = new TypeError("bad");
		expect(describeThrown(e).message).toBe("TypeError: bad");
		expect(describeThrown(e).stack).toBe(e.stack);
		expect(describeThrown("plain")).toEqual({ message: "plain" });
		expect(describeThrown({ name: "AbortError", message: "aborted" })).toEqual({ message: "AbortError: aborted" });
		expect(describeThrown({ code: 4 })).toEqual({ message: '{"code":4}' });
		expect(describeThrown(undefined)).toEqual({ message: "undefined" });
	});
});

describe("ST3 clientLog: once per distinct message per session", () => {
	it("dedupes on kind + message, bounded", () => {
		const seen = new Set<string>();
		expect(shouldReport(seen, clientLogKey("error", "a"))).toBe(true);
		expect(shouldReport(seen, clientLogKey("error", "a "))).toBe(false); // trimmed
		expect(shouldReport(seen, clientLogKey("media", "a"))).toBe(true); // other kind
		expect(shouldReport(seen, clientLogKey("error", "b"))).toBe(true);
		const small = new Set<string>();
		expect(shouldReport(small, "k1", 1)).toBe(true);
		expect(shouldReport(small, "k2", 1)).toBe(false); // full
	});
});

describe("ST3 clientLog: reportClientError", () => {
	const sent: string[] = [];
	const g = globalThis as unknown as { window?: unknown };
	const hadWindow = typeof g.window !== "undefined";
	beforeEach(() => {
		// node environment: a minimal window so the reporter runs (it is a
		// no-op outside the browser).
		if (!hadWindow) g.window = { location: { href: "https://music.ekaii.fr/search/abba?filter=songs#x", pathname: "/search/abba" } };
	});
	afterEach(() => {
		_setClientLogSender(null);
		sent.length = 0;
		if (!hadWindow) delete g.window;
	});
	it("is a no-op without a window", () => {
		if (!hadWindow) delete g.window;
		_setClientLogSender((b) => void sent.push(b));
		expect(reportClientError("error", "x")).toBe(hadWindow);
	});
	it("sends a JSON body once per message, with the page url", () => {
		_setClientLogSender((b) => void sent.push(b));
		expect(reportClientError("media", "MEDIA_ERR_DECODE", { stack: "st" })).toBe(true);
		expect(reportClientError("media", "MEDIA_ERR_DECODE")).toBe(false);
		expect(reportClientError("media", "MEDIA_ERR_NETWORK")).toBe(true);
		expect(sent.length).toBe(2);
		const first = JSON.parse(sent[0]);
		expect(first.kind).toBe("media");
		expect(first.message).toBe("MEDIA_ERR_DECODE");
		expect(first.stack).toBe("st");
		expect(first.url).toBe("/search/abba"); // L8-17: no query string, no fragment
		expect(sent[0]).not.toContain("filter=songs");
		_setClientLogSender((b) => void sent.push(b));
		expect(reportClientError("error", "explicit url", { url: "https://music.ekaii.fr/listen?id=dQw4w9WgXcQ" })).toBe(true);
		expect(JSON.parse(sent[sent.length - 1]).url).toBe("/listen");
	});
	it("never throws when the transport does", () => {
		_setClientLogSender(() => {
			throw new Error("down");
		});
		expect(() => reportClientError("error", "x")).not.toThrow();
		expect(reportClientError("error", "")).toBe(false);
	});
});
