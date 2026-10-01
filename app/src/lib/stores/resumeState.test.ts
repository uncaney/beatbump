import { describe, expect, it } from "vitest";
import {
	RESUME_KEY,
	RESUME_POS_KEY,
	RESUME_MAX_ITEMS,
	REMEMBER_MIGRATED_KEY,
	RESUME_MAX_AGE_MS,
	buildResumePos,
	buildResumeState,
	clearResumeState,
	mergeResumePos,
	parseResumePos,
	resumeSavePlan,
	resumeSignature,
	shouldSaveResume,
	writeResumePos,
	migrateRememberLastTrack,
	resumeAction,
	resumeKeptFor,
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

describe("migrateRememberLastTrack (I1)", () => {
	it("turns a stored false into true once, then keeps later choices", () => {
		const s = memory();
		const settings = { playback: { "Remember Last Track": false } as { "Remember Last Track"?: boolean } };
		expect(migrateRememberLastTrack(settings, s)).toBe(true);
		expect(settings.playback["Remember Last Track"]).toBe(true);
		expect(s.getItem(REMEMBER_MIGRATED_KEY)).toBe("1");
		settings.playback["Remember Last Track"] = false; // explicit choice after migration
		expect(migrateRememberLastTrack(settings, s)).toBe(false);
		expect(settings.playback["Remember Last Track"]).toBe(false);
	});
	it("sets the flag without change when already true (fresh install)", () => {
		const s = memory();
		const settings = { playback: { "Remember Last Track": true } as { "Remember Last Track"?: boolean } };
		expect(migrateRememberLastTrack(settings, s)).toBe(false);
		expect(s.getItem(REMEMBER_MIGRATED_KEY)).toBe("1");
	});
	it("is a no-op without storage", () => {
		const settings = { playback: { "Remember Last Track": false } as { "Remember Last Track"?: boolean } };
		expect(migrateRememberLastTrack(settings, undefined)).toBe(false);
		expect(settings.playback["Remember Last Track"]).toBe(false);
	});
});

describe("resumeKeptFor (I2)", () => {
	it("drops a pending restore when another track loads", () => {
		expect(resumeKeptFor({ videoId: "aaaaaaaaaaa" }, "bbbbbbbbbbb")).toBe(false);
	});
	it("keeps it for its own track or an unknown id", () => {
		expect(resumeKeptFor({ videoId: "aaaaaaaaaaa" }, "aaaaaaaaaaa")).toBe(true);
		expect(resumeKeptFor({ videoId: "aaaaaaaaaaa" }, undefined)).toBe(true);
		expect(resumeKeptFor({}, "bbbbbbbbbbb")).toBe(true);
	});
	it("is false without a pending restore", () => {
		expect(resumeKeptFor(null, "aaaaaaaaaaa")).toBe(false);
	});
});

describe("resumeAction (I4)", () => {
	const state = { mix: [{ videoId: "aaaaaaaaaaa" }, { videoId: "bbbbbbbbbbb" }], position: 1 };
	it("only plays when the restored track holds a source", () => {
		expect(resumeAction({ videoId: "bbbbbbbbbbb" }, state, true)).toBe("play");
	});
	it("restores again when the startup restore left no source", () => {
		expect(resumeAction({ videoId: "bbbbbbbbbbb" }, state, false)).toBe("restore");
	});
	it("restores when another track (or none) is under the cursor", () => {
		expect(resumeAction({ videoId: "aaaaaaaaaaa" }, state, true)).toBe("restore");
		expect(resumeAction(undefined, state, true)).toBe("restore");
	});
});

describe("I7: conditional save, max age, purge", () => {
	const mix = [track(0), track(1), track(2)];
	it("signature changes with cursor, queue order and context, not with time", () => {
		const a = resumeSignature({ mix, position: 1 });
		expect(resumeSignature({ mix, position: 1 })).toBe(a);
		expect(resumeSignature({ mix, position: 2 })).not.toBe(a);
		expect(resumeSignature({ mix: [mix[1], mix[0], mix[2]], position: 1 })).not.toBe(a);
		expect(resumeSignature({ mix: [...mix, track(3)], position: 1 })).not.toBe(a);
		expect(
			resumeSignature({ mix, position: 1, context: { kind: "album", title: "X", href: "", ids: [] } }),
		).not.toBe(a);
	});
	it("periodic save only when the time moved > 2 s or the queue changed", () => {
		const sig = resumeSignature({ mix, position: 0 });
		expect(shouldSaveResume(null, sig, 0)).toBe(true);
		const last = { sig, t: 40 };
		expect(shouldSaveResume(last, sig, 41.5)).toBe(false); // paused / barely moved
		expect(shouldSaveResume(last, sig, 40)).toBe(false); // paused tab: no rewrite
		expect(shouldSaveResume(last, sig, 45)).toBe(true);
		expect(shouldSaveResume(last, sig, 10)).toBe(true); // seek back
		expect(shouldSaveResume(last, resumeSignature({ mix, position: 1 }), 40)).toBe(true);
	});
	it("pause write: exact position once, second pause write of the same state skipped", () => {
		const sig = resumeSignature({ mix, position: 0 });
		expect(shouldSaveResume({ sig, t: 40 }, sig, 41, 0.25)).toBe(true);
		expect(shouldSaveResume({ sig, t: 41 }, sig, 41, 0.25)).toBe(false);
	});
	it("ignores a state older than 30 days at read", () => {
		const s = memory();
		const now = 1_800_000_000_000;
		writeResumeState(s, buildResumeState({ mix, position: 0 }, 5, 10, now - RESUME_MAX_AGE_MS - 1));
		expect(readResumeState(s, now)).toBeNull();
		writeResumeState(s, buildResumeState({ mix, position: 0 }, 5, 10, now - 3600_000));
		expect(readResumeState(s, now)?.mix).toHaveLength(3);
	});
	it("clearResumeState removes the saved queue, its position and lastTrack", () => {
		const m = new Map<string, string>([
			[RESUME_KEY, "x"],
			[RESUME_POS_KEY, "p"],
			["lastTrack", "y"],
			["other", "z"],
		]);
		clearResumeState({
			getItem: (k) => m.get(k) ?? null,
			setItem: (k, v) => void m.set(k, v),
			removeItem: (k) => void m.delete(k),
		});
		expect([...m.keys()]).toEqual(["other"]);
	});
});

describe("K8: the position is written apart from the queue", () => {
	const mix = [track(0), track(1), track(2)];
	it("resumeSavePlan: queue on first save / signature change, pos when the time moved, none otherwise", () => {
		const sig = resumeSignature({ mix, position: 0 });
		expect(resumeSavePlan(null, sig, 0)).toBe("queue");
		expect(resumeSavePlan({ sig, t: 40 }, resumeSignature({ mix, position: 1 }), 40)).toBe("queue");
		expect(resumeSavePlan({ sig, t: 40 }, sig, 45)).toBe("pos");
		expect(resumeSavePlan({ sig, t: 40 }, sig, 41.5)).toBe("none");
		expect(resumeSavePlan({ sig, t: 40 }, sig, 41, 0.25)).toBe("pos"); // pause write
	});
	it("read merges a position that belongs to the saved queue (small key)", () => {
		const s = memory();
		const st = buildResumeState({ mix, position: 1 }, 5, 200, 1000)!;
		writeResumeState(s, st);
		expect(writeResumePos(s, buildResumePos(st, 42, 200, 1500))).toBe(true);
		const r = readResumeState(s, 2000)!;
		expect(r.currentTime).toBe(42);
		expect(r.savedAt).toBe(1500);
		expect(r.position).toBe(1);
		expect(r.mix).toHaveLength(3);
		expect(s.m.get(RESUME_POS_KEY)!.length).toBeLessThan(160);
		expect(s.m.get(RESUME_KEY)!.length).toBeGreaterThan(s.m.get(RESUME_POS_KEY)!.length * 3);
	});
	it("ignores a position taken on another queue (base or cursor row mismatch)", () => {
		const s = memory();
		const older = buildResumeState({ mix, position: 1 }, 5, 200, 1000)!;
		writeResumePos(s, buildResumePos(older, 42, 200, 1500));
		// a newer full write (e.g. a remote restore) has another savedAt
		writeResumeState(s, buildResumeState({ mix, position: 1 }, 7, 200, 3000));
		expect(readResumeState(s, 4000)?.currentTime).toBe(7);
		// same base, other row under the cursor
		const st = buildResumeState({ mix, position: 1 }, 5, 200, 1000)!;
		const pos = { ...buildResumePos(st, 42, 200, 1500)!, videoId: mix[2].videoId };
		expect(mergeResumePos(st, pos)?.currentTime).toBe(5);
		// a position older than its base is ignored too
		expect(mergeResumePos(st, { ...buildResumePos(st, 42, 200, 900)! })?.currentTime).toBe(5);
		expect(mergeResumePos(st, null)).toBe(st);
	});
	it("parseResumePos rejects corrupt / foreign payloads", () => {
		expect(parseResumePos(null)).toBeNull();
		expect(parseResumePos("{")).toBeNull();
		expect(parseResumePos(JSON.stringify({ v: 2, base: 1, videoId: "x" }))).toBeNull();
		expect(parseResumePos(JSON.stringify({ v: 1, base: 0, videoId: "x" }))).toBeNull();
		expect(parseResumePos(JSON.stringify({ v: 1, base: 1, videoId: "" }))).toBeNull();
		expect(parseResumePos(JSON.stringify({ v: 1, base: 1, videoId: "x", currentTime: -3 }))?.currentTime).toBe(0);
	});
});
