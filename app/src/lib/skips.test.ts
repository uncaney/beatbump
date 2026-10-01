import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSkip, isSkipItem, skipBody, skipItem, SKIP_MARK } from "./skips";

const postMock = vi.fn();
/** vitest 0.32 has no vi.waitFor: poll `ok` over a few macrotasks. */
async function until(ok: () => boolean, tries = 50): Promise<void> {
	for (let i = 0; i < tries && !ok(); i++) await new Promise((r) => setTimeout(r, 2));
}
vi.mock("$lib/api", () => ({ APIClient: { fetch: vi.fn(), post: (...a: unknown[]) => postMock(...a) } }));

describe("c40b B6-10: skip rule", () => {
	it("before 20 s or before 30 % of the track", () => {
		expect(isSkip(0, 200)).toBe(true);
		expect(isSkip(19.9, 0)).toBe(true);
		expect(isSkip(20, 0)).toBe(false); // unknown duration: 20 s only
		expect(isSkip(25, 100)).toBe(true); // < 30 s = 30 %
		expect(isSkip(30, 100)).toBe(false);
		expect(isSkip(170, 600)).toBe(true);
		expect(isSkip(-1, 100)).toBe(false);
		expect(isSkip(NaN, 100)).toBe(false);
	});

	it("skipItem: only for a loaded track pressed early", () => {
		const t = { videoId: "0123456789a", title: "Song", thumbnails: [{ url: "x" }] };
		expect(skipItem(t, 5.04, 240.33, "player")).toEqual({
			[SKIP_MARK]: true,
			videoId: "0123456789a",
			title: "Song",
			position: 5,
			duration: 240.3,
			source: "player",
		});
		expect(skipItem(t, 100, 240, "player")).toBeNull(); // late: a real listen
		expect(skipItem(t, 2, 0, "player")).toBeNull(); // never loaded
		expect(skipItem({ title: "no id" }, 2, 100, "player")).toBeNull();
		expect(skipItem(null, 2, 100, "player")).toBeNull();
	});

	it("skipBody: lid vs videoId, press time and replay marker", () => {
		const it1 = skipItem({ videoId: "0123456789a" }, 3, 200, "mediasession")!;
		expect(isSkipItem(it1)).toBe(true);
		expect(isSkipItem({ videoId: "x" })).toBe(false);
		expect(skipBody(it1 as any, 1000)).toEqual({ lid: "0123456789a", position: 3, duration: 200, source: "mediasession", at: 1000 });
		const yt = skipItem({ videoId: "dQw4w9WgXcQ" }, 3, 200, "keyboard")!;
		expect(skipBody({ ...yt, clientSentAt: 5000 } as any, 1000)).toEqual({
			videoId: "dQw4w9WgXcQ",
			position: 3,
			duration: 200,
			source: "keyboard",
			at: 1000,
			clientSentAt: 5000,
		});
	});
});

describe("c40b B6-10: recordSkip goes through the history outbox", () => {
	const store = new Map<string, string>();
	beforeEach(() => {
		store.clear();
		postMock.mockReset();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts me/skips online and never me/history", async () => {
		postMock.mockResolvedValue({ status: 200 });
		const { recordSkip } = await import("./me");
		expect(recordSkip({ videoId: "0123456789a" }, 4, 200, "player")).toBe(true);
		await Promise.resolve();
		expect(postMock).toHaveBeenCalledTimes(1);
		expect(postMock.mock.calls[0][0]).toBe("/api/v1/me/skips");
		expect(postMock.mock.calls[0][1]).toMatchObject({ lid: "0123456789a", position: 4, duration: 200, source: "player" });
		expect(typeof postMock.mock.calls[0][1].at).toBe("number");
		// a late press records nothing
		expect(recordSkip({ videoId: "0123456789a" }, 150, 200, "player")).toBe(false);
		expect(postMock).toHaveBeenCalledTimes(1);
	});

	it("offline: queued, then replayed to me/skips with clientSentAt", async () => {
		vi.stubGlobal("navigator", { onLine: false });
		const me = await import("./me");
		const outbox = await import("./historyOutbox");
		expect(me.recordSkip({ videoId: "0123456789a" }, 4, 200, "mediasession")).toBe(true);
		expect(postMock).not.toHaveBeenCalled();
		const q = outbox.readOutbox();
		expect(q).toHaveLength(1);
		expect(isSkipItem(q[0].item)).toBe(true);
		// back online: the next recorded play flushes the outbox through the
		// real sender (me.ts postPlay), which routes the skip to me/skips.
		vi.stubGlobal("navigator", { onLine: true });
		postMock.mockResolvedValue({ status: 200 });
		await me.recordHistory({ videoId: "bbbbbbbbbbb", title: "Played" });
		await until(() => postMock.mock.calls.length >= 2);
		expect(postMock).toHaveBeenCalledTimes(2);
		expect(postMock.mock.calls[0][0]).toBe("/api/v1/me/history");
		expect(postMock.mock.calls[1][0]).toBe("/api/v1/me/skips");
		expect(postMock.mock.calls[1][1]).toMatchObject({ lid: "0123456789a", source: "mediasession", at: q[0].playedAt });
		expect(postMock.mock.calls[1][1].clientSentAt).toBeTypeOf("number");
		await until(() => outbox.readOutbox().length === 0);
		expect(outbox.readOutbox()).toHaveLength(0);
	});
});
