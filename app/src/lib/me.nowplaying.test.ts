// GET me/nowplaying answers 204 No Content when the profile has no resume
// state (a 404 before: a console error on every fresh profile). getNowPlaying
// reads 204, an older server's 404 and an error as "no row".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("$lib/api", () => ({
	APIClient: { fetch: (...a: unknown[]) => fetchMock(...a), post: vi.fn(), del: vi.fn() },
}));
vi.mock("$lib/homeCache", () => ({ clearHomeCache: vi.fn() }));

const store = () => {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
	};
};

describe("getNowPlaying", () => {
	beforeEach(() => {
		vi.resetModules();
		fetchMock.mockReset();
		vi.stubGlobal("localStorage", store());
		vi.stubGlobal("sessionStorage", store());
		vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("204 No Content (no resume state yet) is null, without reading a body", async () => {
		const json = vi.fn(async () => {
			throw new SyntaxError("Unexpected end of JSON input");
		});
		fetchMock.mockResolvedValue({ ok: true, status: 204, json, headers: new Headers() });
		const me = await import("./me");
		expect(await me.getNowPlaying()).toBeNull();
		expect(json).not.toHaveBeenCalled();
	});

	it("an older server's 404 is null too", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "none" }), headers: new Headers() });
		const me = await import("./me");
		expect(await me.getNowPlaying()).toBeNull();
	});

	it("a 200 row comes back with its payload", async () => {
		const row = { deviceId: "d1", deviceName: "Phone", position: 12, payload: { v: 1, mix: [] }, updatedAt: 1, now: 2 };
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => row, headers: new Headers() });
		const me = await import("./me");
		expect(await me.getNowPlaying()).toMatchObject({ deviceId: "d1", position: 12, now: 2 });
	});
});
