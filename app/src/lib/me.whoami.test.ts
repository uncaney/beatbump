import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("$lib/api", () => ({ APIClient: { fetch: (...a: unknown[]) => fetchMock(...a), post: vi.fn() } }));

type Who = { id: string; name: string };
function deferred() {
	let resolve!: (w: Who) => void;
	let reject!: (e: unknown) => void;
	const p = new Promise<Who>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { p, resolve, reject };
}
const response = (p: Promise<Who>) => Promise.resolve({ json: () => p });
const store = new Map<string, string>();
const sessionStorageStub = {
	getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
};

describe("PF4-4: whoami shares its in-flight request", () => {
	beforeEach(async () => {
		vi.stubGlobal("sessionStorage", sessionStorageStub);
		store.clear();
		fetchMock.mockReset();
		const { forgetWhoami } = await import("./me");
		forgetWhoami();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("a cold home's parallel callers issue ONE request", async () => {
		const me = await import("./me");
		const d = deferred();
		fetchMock.mockImplementation(() => response(d.p));
		const calls = [me.whoami(), me.whoami(), me.isAnonymousProfile(), me.whoami({ fresh: true })];
		d.resolve({ id: "p1", name: "" });
		const [a, b, anon, c] = await Promise.all(calls);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/me/whoami");
		expect(a).toEqual({ id: "p1", name: "" });
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(anon).toBe(true);
		// settled: the memo answers, no new request
		expect(await me.whoami()).toEqual({ id: "p1", name: "" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// a fresh call after settlement asks the server again
		fetchMock.mockImplementation(() => response(Promise.resolve({ id: "p1", name: "" })));
		await me.whoami({ fresh: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("a failure is shared once, then forgotten", async () => {
		const me = await import("./me");
		const d = deferred();
		fetchMock.mockImplementation(() => response(d.p));
		const both = Promise.allSettled([me.whoami(), me.whoami()]);
		d.reject(new Error("offline"));
		const r = await both;
		expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fetchMock.mockImplementation(() => response(Promise.resolve({ id: "p2", name: "bob" })));
		expect(await me.whoami()).toEqual({ id: "p2", name: "bob" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("forgetWhoami (login / logout) drops the pending request and its answer", async () => {
		const me = await import("./me");
		const old = deferred();
		fetchMock.mockImplementationOnce(() => response(old.p));
		const stale = me.whoami();
		me.forgetWhoami();
		fetchMock.mockImplementationOnce(() => response(Promise.resolve({ id: "p-new", name: "alice" })));
		const fresh = me.whoami();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		old.resolve({ id: "p-old", name: "" });
		expect(await stale).toEqual({ id: "p-old", name: "" });
		expect(await fresh).toEqual({ id: "p-new", name: "alice" });
		// the previous profile's late answer did not overwrite the memo
		expect(await me.whoami()).toEqual({ id: "p-new", name: "alice" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
