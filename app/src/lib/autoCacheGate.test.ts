import { describe, expect, it, vi } from "vitest";
import { AUTO_CACHE_PENDING_MAX, autoCacheListenThreshold, autoKeepNotice, createAutoCacheGate, WEBDRIVER_LISTEN_SECONDS } from "./autoCacheGate";
import { listenThreshold } from "./listenLog";
import { NNBSP } from "./utils/formatFr";

const t = (videoId: string) => ({ videoId, title: "T " + videoId });

describe("U14-2 createAutoCacheGate", () => {
	it("a track started by the player is kept only once its listen counts (>= 2 min / half), not when it starts", () => {
		const keep = vi.fn();
		const g = createAutoCacheGate(keep);
		expect(g.request(t("a"), "/localf?p=a.flac")).toBe("deferred");
		expect(keep).not.toHaveBeenCalled();
		expect(g.pendingFor("a")).toBe(1);
		expect(g.listened("a").map((r) => r.url)).toEqual(["/localf?p=a.flac"]);
		expect(keep).toHaveBeenCalledWith(t("a"), "/localf?p=a.flac");
		expect(g.pendingFor("a")).toBe(0);
		expect(g.isListened("a")).toBe(true);
	});

	it("a track listened this session is kept at once the next time it starts", () => {
		const keep = vi.fn();
		const g = createAutoCacheGate(keep);
		g.listened("a");
		expect(g.request(t("a"), "/aud/a")).toBe("now");
		expect(keep).toHaveBeenCalledTimes(1);
	});

	it("a prefetched next track waits on the CURRENT track's listen (`after`), not on its own", () => {
		const keep = vi.fn();
		const g = createAutoCacheGate(keep);
		expect(g.request(t("next"), "/localf?p=next.flac", "cur")).toBe("deferred");
		expect(g.request(t("next2"), "/localf?p=next2.flac", "cur")).toBe("deferred");
		expect(g.pendingFor("cur")).toBe(2);
		// The next track's own listen releases nothing: it was asked after "cur".
		expect(g.listened("next")).toEqual([]);
		expect(keep).not.toHaveBeenCalled();
		const out = g.listened("cur");
		expect(out.map((r) => r.item.videoId)).toEqual(["next", "next2"]);
		expect(keep).toHaveBeenCalledTimes(2);
		// A skipped-through "cur" never listened: its prefetches stay out of the cache.
		expect(g.pending()).toBe(0);
	});

	it("one request per videoId: a newer URL or condition replaces the older one", () => {
		const keep = vi.fn();
		const g = createAutoCacheGate(keep);
		g.request(t("a"), "/vp?sig=1");
		g.request(t("a"), "/vp?sig=2");
		expect(g.pendingFor("a")).toBe(1);
		expect(g.listened("a").map((r) => r.url)).toEqual(["/vp?sig=2"]);
		g.request(t("b"), "/aud/b", "x");
		g.request(t("b"), "/aud/b", "y");
		expect(g.pendingFor("x")).toBe(0);
		expect(g.pendingFor("y")).toBe(1);
	});

	it("bounded: the oldest waiting groups are dropped past AUTO_CACHE_PENDING_MAX", () => {
		const g = createAutoCacheGate(() => {});
		for (let i = 0; i < AUTO_CACHE_PENDING_MAX + 5; i++) g.request(t("v" + i), "/aud/v" + i);
		expect(g.pending()).toBe(AUTO_CACHE_PENDING_MAX);
		expect(g.pendingFor("v0")).toBe(0);
		expect(g.pendingFor("v" + (AUTO_CACHE_PENDING_MAX + 4))).toBe(1);
	});

	it("ignores an item without id or a request without URL; reset forgets everything", () => {
		const keep = vi.fn();
		const g = createAutoCacheGate(keep);
		expect(g.request({}, "/aud/x")).toBe("ignored");
		expect(g.request(t("a"), "")).toBe("ignored");
		expect(g.listened("")).toEqual([]);
		g.request(t("a"), "/aud/a");
		g.listened("b");
		g.reset();
		expect(g.pending()).toBe(0);
		expect(g.isListened("b")).toBe(false);
		expect(keep).not.toHaveBeenCalled();
	});


	it("autoCacheListenThreshold: real users keep the full listenLog rule (webdriver false, nothing weakened)", () => {
		expect(autoCacheListenThreshold(300, false)).toBe(listenThreshold(300));
		expect(autoCacheListenThreshold(300, false)).toBe(120); // min(120, 150)
		expect(autoCacheListenThreshold(60, false)).toBe(30); // half of a short track
		expect(autoCacheListenThreshold(0, false)).toBe(120); // unknown length
	});

	it("autoCacheListenThreshold: capped at 5 s under webdriver only (Playwright/automation)", () => {
		expect(autoCacheListenThreshold(300, true)).toBe(WEBDRIVER_LISTEN_SECONDS);
		expect(autoCacheListenThreshold(300, true)).toBe(5);
		expect(autoCacheListenThreshold(0, true)).toBe(5);
		// never raises a threshold already below the cap: half of a 6 s track is 3 s
		expect(autoCacheListenThreshold(6, true)).toBe(3);
	});

	it("autoKeepNotice: one line with the size, in French", () => {
		expect(autoKeepNotice(98 * 1024 * 1024)).toBe(`Gardé hors-ligne (98${NNBSP}Mo)`);
		expect(autoKeepNotice(0)).toBe("Gardé hors-ligne");
		expect(autoKeepNotice(undefined)).toBe("Gardé hors-ligne");
	});
});
