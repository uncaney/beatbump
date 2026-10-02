import { describe, expect, it } from "vitest";
import { LISTEN_LOG_KEY, LISTEN_LOG_MAX, LISTEN_MIN_SECONDS, isListened, listenThreshold, readListenLog, recordListen } from "./listenLog";

// L13-1: "listened" = >= 50 % of the track or >= 2 min really played, never
// a track merely served by the service worker.
function kv() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		raw: () => m.get(LISTEN_LOG_KEY),
	};
}

describe("listenLog", () => {
	it("isListened: half of a known length, or two minutes; nothing without seconds", () => {
		expect(isListened(90, 180)).toBe(true); // 50 %
		expect(isListened(89, 180)).toBe(false);
		expect(isListened(LISTEN_MIN_SECONDS, 0)).toBe(true); // unknown length: 2 min
		expect(isListened(LISTEN_MIN_SECONDS, 3600)).toBe(true); // long track: 2 min is enough
		expect(isListened(119, 3600)).toBe(false);
		expect(isListened(119, 0)).toBe(false);
		expect(isListened(0, 180)).toBe(false);
		expect(isListened(undefined, 180)).toBe(false); // a served entry, no listen
		expect(isListened(NaN, 180)).toBe(false);
		expect(isListened(2, 180)).toBe(false); // the 2 s "suivant"
	});

	it("listenThreshold: min(2 min, half the length), 2 min when unknown", () => {
		expect(listenThreshold(180)).toBe(90);
		expect(listenThreshold(3600)).toBe(LISTEN_MIN_SECONDS);
		expect(listenThreshold(0)).toBe(LISTEN_MIN_SECONDS);
		expect(listenThreshold(NaN)).toBe(LISTEN_MIN_SECONDS);
	});

	it("records qualifying listens, bounded, and ignores junk", () => {
		const s = kv();
		expect(readListenLog(s)).toEqual([]);
		recordListen(s, { videoId: "a", seconds: 100, duration: 180, at: 1_000 });
		recordListen(s, { videoId: "b", seconds: 130, at: 2_000 }); // unknown length
		recordListen(s, { videoId: "", seconds: 130, at: 3_000 }); // no id: dropped
		recordListen(s, { videoId: "c", seconds: 0, at: 4_000 }); // nothing listened: dropped
		expect(readListenLog(s)).toEqual([
			{ videoId: "a", at: 1_000, seconds: 100, duration: 180 },
			{ videoId: "b", at: 2_000, seconds: 130, duration: 0 },
		]);
		// bounded: the oldest go first
		for (let i = 0; i < LISTEN_LOG_MAX + 5; i++) recordListen(s, { videoId: "x" + i, seconds: 200, at: 10_000 + i });
		const log = readListenLog(s);
		expect(log.length).toBe(LISTEN_LOG_MAX);
		expect(log[0].videoId).toBe("x5");
		expect(log[log.length - 1].videoId).toBe("x" + (LISTEN_LOG_MAX + 4));
		// malformed storage reads as empty, a null store is a no-op
		s.setItem(LISTEN_LOG_KEY, "{not json");
		expect(readListenLog(s)).toEqual([]);
		expect(() => recordListen(null, { videoId: "a", seconds: 200 })).not.toThrow();
		expect(readListenLog(undefined)).toEqual([]);
	});
});
