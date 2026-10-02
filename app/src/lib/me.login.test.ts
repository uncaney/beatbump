// c45b B7-17 (L12-8): writes started while POST me/login is on the wire are
// held until the server answered (the bbp cookie is then the named one), the
// previous anonymous id is remembered and sent as `prevAnon`, logout forgets it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
const fetchMock = vi.fn();
const delMock = vi.fn();
vi.mock("$lib/api", () => ({
	APIClient: { fetch: (...a: unknown[]) => fetchMock(...a), post: (...a: unknown[]) => postMock(...a), del: (...a: unknown[]) => delMock(...a) },
}));
vi.mock("$lib/homeCache", () => ({ clearHomeCache: vi.fn() }));

const local = new Map<string, string>();
const session = new Map<string, string>();
const storageOf = (m: Map<string, string>) => ({
	getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
	setItem: (k: string, v: string) => void m.set(k, v),
	removeItem: (k: string) => void m.delete(k),
});
class FakeChannel {
	onmessage: ((e: unknown) => void) | null = null;
	constructor(public name: string) {}
	postMessage() {}
	close() {}
}
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const p = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { p, resolve, reject };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("L12-8: login() holds the writes until the cookie switch is done", () => {
	beforeEach(() => {
		vi.resetModules();
		postMock.mockReset();
		fetchMock.mockReset();
		delMock.mockReset();
		local.clear();
		session.clear();
		vi.stubGlobal("localStorage", storageOf(local));
		vi.stubGlobal("sessionStorage", storageOf(session));
		vi.stubGlobal("BroadcastChannel", FakeChannel);
		vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("queues plays, favourites, follows, playlists and now_playing during the login, then flushes them", async () => {
		const me = await import("./me");
		const calls: string[] = [];
		const loginAnswer = deferred<unknown>();
		postMock.mockImplementation(async (url: string) => {
			calls.push("post " + url);
			if (url.endsWith("/me/login")) return loginAnswer.p;
			return ok({ ok: true });
		});
		fetchMock.mockImplementation(async (url: string) => {
			calls.push("fetch " + url);
			return ok({});
		});
		delMock.mockImplementation(async (url: string) => {
			calls.push("del " + url);
			return ok({});
		});
		expect(me.loginInProgress()).toBe(false);
		const login = me.login("Alice");
		expect(me.loginInProgress()).toBe(true);
		const writes = Promise.all([
			me.recordHistory({ videoId: "v1", title: "T" }),
			me.addFavorite({ videoId: "v1" }),
			me.follow("la-a", "A"),
			me.addToPlaylist(3, { videoId: "v1" }),
			me.removeFavoriteItem({ videoId: "v2" }),
			me.putNowPlaying({ deviceId: "d", deviceName: "D", position: 1, payload: {} }),
		]);
		await tick();
		await tick();
		// nothing but the login left while the cookie is being switched
		expect(calls).toEqual(["post /api/v1/me/login"]);
		loginAnswer.resolve(ok({ id: "u-1", name: "Alice", migrated: null }));
		const r = await login;
		expect(r.id).toBe("u-1");
		expect(me.loginInProgress()).toBe(false);
		await writes;
		expect(calls[0]).toBe("post /api/v1/me/login");
		expect(calls.slice(1).sort()).toEqual(
			[
				"post /api/v1/me/history",
				"post /api/v1/me/favorites",
				"post /api/v1/me/follows",
				"post /api/v1/me/playlists/3/items",
				"del /api/v1/me/favorites?ref=v2",
				"fetch /api/v1/me/nowplaying",
			].sort(),
		);
		// the memo now names the profile; the gate is open for the next write
		await me.addFavorite({ videoId: "v3" });
		expect(postMock).toHaveBeenCalledTimes(1 + 4 + 1);
	});

	it("a login that never answers holds a write LOGIN_GATE_MAX_MS at most, never the keepalive now_playing push (L13-5)", async () => {
		vi.useFakeTimers();
		try {
			const me = await import("./me");
			const never = deferred<unknown>();
			postMock.mockImplementation(async (url: string) => (url.endsWith("/me/login") ? never.p : ok({ ok: true })));
			fetchMock.mockImplementation(async () => ok({}));
			void me.login("Carol").catch(() => {});
			expect(me.loginInProgress()).toBe(true);
			// pagehide: the keepalive push goes out at once, with the current cookie
			const keep = me.putNowPlaying({ deviceId: "d", deviceName: "D", position: 1, payload: {} }, true);
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect((await keep).status).toBe(200);
			// an ordinary write waits for the login, LOGIN_GATE_MAX_MS at most
			const fav = me.addFavorite({ videoId: "v1" });
			const sync = me.putNowPlaying({ deviceId: "d", deviceName: "D", position: 2, payload: {} });
			await vi.advanceTimersByTimeAsync(me.LOGIN_GATE_MAX_MS - 1);
			expect(postMock).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await fav;
			expect((await sync).status).toBe(200);
			expect(postMock).toHaveBeenCalledTimes(2);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			// the login is still on the wire: the gate stays for the next write
			expect(me.loginInProgress()).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a failed login releases the queue (the writes go out with whatever cookie the server kept)", async () => {
		const me = await import("./me");
		const loginAnswer = deferred<unknown>();
		postMock.mockImplementation(async (url: string) => (url.endsWith("/me/login") ? loginAnswer.p : ok({ ok: true })));
		const login = me.login("Bob");
		const fav = me.addFavorite({ videoId: "v1" });
		await tick();
		expect(postMock).toHaveBeenCalledTimes(1);
		loginAnswer.resolve({ ok: false, status: 503, json: async () => ({}) });
		await expect(login).rejects.toThrow("login 503");
		await fav;
		expect(postMock).toHaveBeenCalledTimes(2);
		expect(me.loginInProgress()).toBe(false);
	});

	it("a refused login keeps the whoami memo and the home cache; an accepted one drops both (L13-16)", async () => {
		const me = await import("./me");
		const { clearHomeCache } = await import("$lib/homeCache");
		vi.mocked(clearHomeCache).mockClear(); // the mock spy outlives resetModules
		const memo = JSON.stringify({ id: "anon-keep", name: "", at: Date.now() });
		session.set("ytm-whoami", memo);
		postMock.mockImplementation(async () => ({ ok: false, status: 400, json: async () => ({ error: "bad_request" }) }));
		await expect(me.login("")).rejects.toThrow("login 400");
		expect(session.get("ytm-whoami")).toBe(memo);
		expect(clearHomeCache).not.toHaveBeenCalled();
		postMock.mockImplementation(async () => ok({ id: "u-9", name: "Dan", migrated: null }));
		await me.login("Dan");
		expect(JSON.parse(session.get("ytm-whoami") || "{}").id).toBe("u-9");
		expect(clearHomeCache).toHaveBeenCalledTimes(1);
	});

	it("remembers the anonymous id, sends it as prevAnon on the next login, forgets it on logout", async () => {
		const me = await import("./me");
		session.set("ytm-whoami", JSON.stringify({ id: "anon-abc", name: "", at: Date.now() }));
		postMock.mockImplementation(async (url: string) => (url.endsWith("/me/login") ? ok({ id: "u-1", name: "Alice", migrated: { plays: 2 } }) : ok({ ok: true })));
		await me.login("Alice");
		expect(postMock).toHaveBeenCalledWith("/api/v1/me/login", { name: "Alice" }); // nothing remembered yet
		expect(local.get(me.PREV_ANON_KEY)).toBe("anon-abc");
		// second login from the named memo: the remembered id travels, the memo (named) is not remembered
		await me.login("alice");
		expect(postMock).toHaveBeenLastCalledWith("/api/v1/me/login", { name: "alice", prevAnon: "anon-abc" });
		expect(local.get(me.PREV_ANON_KEY)).toBe("anon-abc");
		// a login from a fresh anonymous memo replaces it
		session.set("ytm-whoami", JSON.stringify({ id: "anon-def", name: "", at: Date.now() }));
		await me.login("Alice");
		expect(postMock).toHaveBeenLastCalledWith("/api/v1/me/login", { name: "Alice", prevAnon: "anon-abc" });
		expect(local.get(me.PREV_ANON_KEY)).toBe("anon-def");
		await me.logout();
		expect(local.has(me.PREV_ANON_KEY)).toBe(false);
		// a malformed remembered value is never sent
		local.set(me.PREV_ANON_KEY, "not valid!");
		await me.login("Alice");
		expect(postMock).toHaveBeenLastCalledWith("/api/v1/me/login", { name: "Alice" });
	});
});
