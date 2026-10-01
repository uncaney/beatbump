import { describe, expect, it } from "vitest";
import { enqueuePlay, flushOutbox, OUTBOX_MAX, readOutbox, slimHistoryItem, statusResult, type SendResult } from "./historyOutbox";

function memStore() {
	const m = new Map<string, string>();
	return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, v) };
}
const song = (id: string) => ({ videoId: id, title: "Song " + id, loggingContext: { big: "x".repeat(100) }, thumbnails: [{ url: "1" }, { url: "2" }, { url: "3" }] });

describe("historyOutbox", () => {
	it("slims the item", () => {
		const s = slimHistoryItem({ ...song("a"), playedAt: 5 });
		expect(s.loggingContext).toBeUndefined();
		expect(s.playedAt).toBeUndefined();
		expect((s.thumbnails as unknown[]).length).toBe(2);
		expect(s.title).toBe("Song a");
	});

	it("maps HTTP status", () => {
		expect(statusResult(200)).toBe("ok");
		expect(statusResult(503)).toBe("retry");
		expect(statusResult(429)).toBe("retry");
		expect(statusResult(400)).toBe("drop");
	});

	it("caps the queue at OUTBOX_MAX, dropping the oldest", () => {
		const st = memStore();
		for (let i = 0; i < OUTBOX_MAX + 5; i++) enqueuePlay({ videoId: "v" + i }, 1000 + i, st);
		const l = readOutbox(st);
		expect(l.length).toBe(OUTBOX_MAX);
		expect(l[0].playedAt).toBe(1005);
	});

	it("replays oldest first with playedAt, stops on retry, keeps the rest", async () => {
		const st = memStore();
		enqueuePlay(song("a"), 1, st);
		enqueuePlay(song("b"), 2, st);
		enqueuePlay(song("c"), 3, st);
		const calls: string[] = [];
		const send = async (item: any, at: number): Promise<SendResult> => {
			calls.push(`${item.videoId}@${at}`);
			return item.videoId === "b" ? "retry" : "ok";
		};
		const r = await flushOutbox(send, st);
		expect(calls).toEqual(["a@1", "b@2"]);
		expect(r).toEqual({ sent: 1, dropped: 0, left: 2 });
		expect(readOutbox(st).map((e) => e.playedAt)).toEqual([2, 3]);
	});

	it("drops 4xx entries and empties the queue", async () => {
		const st = memStore();
		enqueuePlay(song("a"), 1, st);
		enqueuePlay(song("b"), 2, st);
		const r = await flushOutbox(async (item: any) => (item.videoId === "a" ? "drop" : "ok"), st);
		expect(r).toEqual({ sent: 1, dropped: 1, left: 0 });
	});

	it("keeps a play queued during the flush", async () => {
		const st = memStore();
		enqueuePlay(song("a"), 1, st);
		const r = await flushOutbox(async () => {
			enqueuePlay(song("z"), 9, st);
			return "retry";
		}, st);
		expect(r.left).toBe(2);
		const r2 = await flushOutbox(async () => "ok", st);
		expect(r2).toEqual({ sent: 2, dropped: 0, left: 0 });
	});
});
