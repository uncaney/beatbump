import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { lazyComponent } from "./lazyComponent";

const comp = (tag: string) => ({ default: tag }) as any;

describe("lazyComponent (K7 / L16 audit v7)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves with the loaded component and fills the store", async () => {
		const loader = vi.fn().mockResolvedValue(comp("A"));
		const lc = lazyComponent(loader as any);
		expect(get(lc)).toBeNull();
		await expect(lc.load()).resolves.toBe("A");
		expect(get(lc)).toBe("A");
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it("is idempotent: concurrent load() calls share one in-flight import", async () => {
		const loader = vi.fn().mockResolvedValue(comp("A"));
		const lc = lazyComponent(loader as any);
		const [a, b] = [lc.load(), lc.load()];
		await Promise.all([a, b]);
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it("L16: retries once after retryDelayMs when the chunk fails, then succeeds", async () => {
		const loader = vi.fn().mockRejectedValueOnce(new Error("404")).mockResolvedValueOnce(comp("A"));
		const onError = vi.fn();
		const lc = lazyComponent(loader as any, { onError, retryDelayMs: 1000 });
		const p = lc.load();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(p).resolves.toBe("A");
		expect(loader).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(expect.any(Error), 0);
	});

	it("L16: calls onError for both attempts and rejects when the retry also fails", async () => {
		const loader = vi.fn().mockRejectedValue(new Error("404"));
		const onError = vi.fn();
		const lc = lazyComponent(loader as any, { onError, retryDelayMs: 1000 });
		const p = lc.load();
		const assertion = expect(p).rejects.toThrow("404");
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
		expect(loader).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenNthCalledWith(1, expect.any(Error), 0);
		expect(onError).toHaveBeenNthCalledWith(2, expect.any(Error), 1);
	});

	it("L16: a later load() after a final failure tries fresh (does not stay stuck)", async () => {
		const loader = vi
			.fn()
			.mockRejectedValueOnce(new Error("404"))
			.mockRejectedValueOnce(new Error("404"))
			.mockResolvedValueOnce(comp("A"));
		const lc = lazyComponent(loader as any, { retryDelayMs: 1000 });
		const first = lc.load();
		const firstAssertion = expect(first).rejects.toThrow("404");
		await vi.advanceTimersByTimeAsync(1000);
		await firstAssertion;
		expect(loader).toHaveBeenCalledTimes(2);
		await expect(lc.load()).resolves.toBe("A");
		expect(loader).toHaveBeenCalledTimes(3);
	});
});
