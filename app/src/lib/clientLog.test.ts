import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../env", () => ({ SERVER_DOMAIN: "" }));

import {
	CLIENT_LOG_MAX_BODY,
	_setClientLogSender,
	buildClientLogPayload,
	clientLogKey,
	describeThrown,
	reportClientError,
	shouldReport,
} from "./clientLog";

describe("ST3 clientLog: payload", () => {
	it("clips every field and drops a stack equal to the message", () => {
		const p = buildClientLogPayload("error", " boom ", { stack: "boom", url: "https://x/y", ua: "UA" });
		expect(p).toEqual({ kind: "error", message: "boom", url: "https://x/y", ua: "UA" });
		const long = buildClientLogPayload("media", "m".repeat(5000), { stack: "s".repeat(5000), url: "u".repeat(900), ua: "a".repeat(400) });
		expect(long!.message.length).toBe(1000);
		expect(long!.stack!.length).toBe(2000);
		expect(long!.url!.length).toBe(500);
		expect(long!.ua!.length).toBe(250);
		expect(JSON.stringify(long).length).toBeLessThan(CLIENT_LOG_MAX_BODY);
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
		if (!hadWindow) g.window = { location: { href: "https://music.ekaii.fr/home" } };
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
		expect(typeof first.url).toBe("string");
	});
	it("never throws when the transport does", () => {
		_setClientLogSender(() => {
			throw new Error("down");
		});
		expect(() => reportClientError("error", "x")).not.toThrow();
		expect(reportClientError("error", "")).toBe(false);
	});
});
