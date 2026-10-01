import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("$lib/api", () => ({ APIClient: { fetch: (...a: unknown[]) => fetchMock(...a), post: vi.fn() } }));

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ videoId: "v" + i }));
const answer = (n: number) => Promise.resolve({ json: () => Promise.resolve({ items: items(n) }) });

describe("PF3-6: getRecent memo", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
		fetchMock.mockReset();
		const { forgetRecent } = await import("./me");
		forgetRecent();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("FirstRun (limit 1) and PersonalRows (limit 30) share one request", async () => {
		const { getRecent } = await import("./me");
		fetchMock.mockImplementation(() => answer(30));
		const [a, b] = await Promise.all([getRecent(1), getRecent(30)]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/me/stats/recent?limit=30");
		expect(a.items).toHaveLength(1);
		expect(b.items).toHaveLength(30);
		await getRecent(20); // search overlay, within 5 s
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("a bigger limit, an expired memo or a recorded play refetch", async () => {
		const me = await import("./me");
		fetchMock.mockImplementation((u: string) => answer(Number(new URL(u, "http://x").searchParams.get("limit"))));
		await me.getRecent(30);
		await me.getRecent(100);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(me.RECENT_MEMO_MS + 1);
		await me.getRecent(30);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		me.forgetRecent();
		await me.getRecent(30);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		me.forgetWhoami(); // profile change drops it too
		await me.getRecent(30);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("never memoises a failure", async () => {
		const { getRecent } = await import("./me");
		fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
		await expect(getRecent(30)).rejects.toThrow("offline");
		fetchMock.mockImplementation(() => answer(3));
		const r = await getRecent(30);
		expect(r.items).toHaveLength(3);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
