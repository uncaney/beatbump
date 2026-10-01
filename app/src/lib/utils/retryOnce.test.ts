import { describe, expect, it, vi } from "vitest";
import { retryOnce } from "./retryOnce";

describe("retryOnce (L10-9 home.json)", () => {
	it("returns the first success without waiting", async () => {
		const wait = vi.fn(async () => {});
		const fn = vi.fn(async () => 1);
		await expect(retryOnce(fn, 2000, wait)).resolves.toBe(1);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(wait).not.toHaveBeenCalled();
	});
	it("retries once after the delay", async () => {
		const wait = vi.fn(async () => {});
		let n = 0;
		const fn = vi.fn(async () => {
			if (n++ === 0) throw new Error("home.json 502");
			return "ok";
		});
		await expect(retryOnce(fn, 2000, wait)).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
		expect(wait).toHaveBeenCalledWith(2000);
	});
	it("rejects with the second error, never a third attempt", async () => {
		const wait = vi.fn(async () => {});
		const fn = vi.fn(async () => {
			throw new Error("down");
		});
		await expect(retryOnce(fn, 2000, wait)).rejects.toThrow("down");
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
