import { describe, expect, it } from "vitest";
import {
	RESUME_KEY,
	RESUME_MAX_ITEMS,
	buildResumeState,
	parseResumeState,
	readResumeState,
	resumeSeekTime,
	slimQueueItem,
	writeResumeState,
} from "./resumeState";

const track = (i: number) => ({
	videoId: "0123456789" + (i % 10),
	title: "T" + i,
	playlistId: "PL",
	localUrl: "/localf?lid=" + i,
	thumbnails: [{ url: "a" }, { url: "b" }, { url: "c", width: 512, height: 512 }],
	artistInfo: { artist: [{ text: "Daft Punk", browseId: "x" }] },
	loggingContext: { vssLoggingContext: { serializedContextData: "zzzz".repeat(100) } },
	menu: { huge: true },
});

const memory = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("slimQueueItem", () => {
	it("keeps what playback needs, drops the rest", () => {
		const s = slimQueueItem(track(1))!;
		expect(s.videoId).toBe("01234567891");
		expect(s.localUrl).toBe("/localf?lid=1");
		expect(s.thumbnails).toHaveLength(2);
		expect(s.thumbnails[1].url).toBe("c");
		expect(s.artistInfo.artist[0].text).toBe("Daft Punk");
		expect(s.loggingContext).toBeUndefined();
		expect(s.menu).toBeUndefined();
	});
	it("rejects rows without videoId", () => {
		expect(slimQueueItem({ title: "x" })).toBeNull();
		expect(slimQueueItem(null)).toBeNull();
	});
});

describe("buildResumeState / parseResumeState", () => {
	const ctx = { kind: "album" as const, title: "Discovery", href: "/release?id=x", ids: ["a", "b"] };

	it("round-trips queue, cursor, type, time and context", () => {
		const mix = [track(0), track(1), track(2), track(3)];
		const st = buildResumeState({ mix, position: 2, currentMixType: "local", context: ctx }, 40.5, 200, 1000)!;
		const back = parseResumeState(JSON.stringify(st))!;
		expect(back.mix).toHaveLength(4);
		expect(back.position).toBe(2);
		expect(back.type).toBe("local");
		expect(back.currentTime).toBe(40.5);
		expect(back.duration).toBe(200);
		expect(back.context).toEqual(ctx);
		expect(back.mix[2].title).toBe("T2");
	});

	it("an empty queue saves nothing", () => {
		expect(buildResumeState({ mix: [], position: 0 }, 10, 100)).toBeNull();
	});

	it("caps a long queue to 500 rows around the cursor", () => {
		const mix = Array.from({ length: 1200 }, (_, i) => track(i));
		const st = buildResumeState({ mix, position: 500 }, 0, 0)!;
		expect(st.mix).toHaveLength(RESUME_MAX_ITEMS);
		expect(st.mix[st.position].title).toBe("T500");
		expect(st.position).toBe(100);
		const early = buildResumeState({ mix, position: 3 }, 0, 0)!;
		expect(early.position).toBe(3);
		expect(early.mix[0].title).toBe("T0");
	});

	it("re-anchors the cursor when a row is unusable", () => {
		const mix = [{ title: "no id" }, track(1), track(2)];
		const st = buildResumeState({ mix, position: 2 }, 0, 0)!;
		expect(st.mix).toHaveLength(2);
		expect(st.mix[st.position].title).toBe("T2");
	});

	it("rejects corrupt / foreign payloads", () => {
		expect(parseResumeState(null)).toBeNull();
		expect(parseResumeState("{")).toBeNull();
		expect(parseResumeState(JSON.stringify({ v: 2, mix: [track(1)] }))).toBeNull();
		expect(parseResumeState(JSON.stringify({ v: 1, mix: [{ title: "x" }] }))).toBeNull();
		const p = parseResumeState(JSON.stringify({ v: 1, mix: [track(1)], position: 99, currentTime: "x", type: "weird" }))!;
		expect(p.position).toBe(0);
		expect(p.currentTime).toBe(0);
		expect(p.type).toBeNull();
	});
});

describe("resumeSeekTime", () => {
	it("resumes at the saved time, restarts a finished track", () => {
		expect(resumeSeekTime({ currentTime: 40, duration: 200 })).toBe(40);
		expect(resumeSeekTime({ currentTime: 198.5, duration: 200 })).toBe(0);
		expect(resumeSeekTime({ currentTime: 40, duration: 0 })).toBe(40);
	});
});

describe("read / write", () => {
	it("persists under the resumeState key", () => {
		const s = memory();
		const st = buildResumeState({ mix: [track(1)], position: 0 }, 5, 10)!;
		expect(writeResumeState(s, st)).toBe(true);
		expect(s.m.has(RESUME_KEY)).toBe(true);
		expect(readResumeState(s)?.mix[0].videoId).toBe("01234567891");
	});
	it("survives a throwing storage", () => {
		const bad = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(readResumeState(bad)).toBeNull();
		expect(writeResumeState(bad, buildResumeState({ mix: [track(1)], position: 0 }, 0, 0))).toBe(false);
	});
});
