import { beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
vi.mock("$lib/api", () => ({ APIClient: { fetch: vi.fn(), post: (...a: unknown[]) => postMock(...a) } }));

const posted: unknown[] = [];
class FakeChannel {
	onmessage: ((e: unknown) => void) | null = null;
	constructor(public name: string) {}
	postMessage(m: unknown) {
		posted.push(m);
	}
	close() {}
}

describe("L10-8: logout() announces only after the server call", () => {
	beforeEach(() => {
		vi.resetModules();
		postMock.mockReset();
		posted.length = 0;
		vi.stubGlobal("BroadcastChannel", FakeChannel);
		vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
	});

	it("posts first, then tells the other tabs", async () => {
		const order: string[] = [];
		postMock.mockImplementation(async () => {
			order.push("post:" + posted.length);
			return { ok: true, status: 200 };
		});
		const { logout } = await import("./me");
		await logout();
		expect(postMock).toHaveBeenCalledWith("/api/v1/me/logout", {});
		expect(order).toEqual(["post:0"]); // nothing announced before the request
		expect(posted).toHaveLength(1);
	});

	it("a failed logout throws and announces nothing (session kept)", async () => {
		postMock.mockResolvedValueOnce({ ok: false, status: 503 });
		const { logout } = await import("./me");
		await expect(logout()).rejects.toThrow("logout 503");
		expect(posted).toHaveLength(0);
		postMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await expect(logout()).rejects.toThrow("Failed to fetch");
		expect(posted).toHaveLength(0);
	});
});
