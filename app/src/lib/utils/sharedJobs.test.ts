import { describe, expect, it } from "vitest";
import { SharedJobs } from "./sharedJobs";

type R = { ok: boolean; reason?: string };
const cancelled = (): R => ({ ok: false, reason: "cancelled" });

/** A job the test finishes by hand; records its AbortSignal. */
function deferredJob() {
	const finishers: ((v: R) => void)[] = [];
	let signal!: AbortSignal;
	const start = (s: AbortSignal) => {
		signal = s;
		return new Promise<R>((r) => finishers.push(r));
	};
	return {
		start,
		finish: (v: R) => finishers[finishers.length - 1](v),
		finishers,
		signal: () => signal,
		starts: () => finishers.length,
	};
}

describe("SharedJobs (L8-16 SW abort-audio)", () => {
	it("dedups concurrent joins on one job", async () => {
		const jobs = new SharedJobs<R>(cancelled);
		const d = deferredJob();
		const a = jobs.join("id:x", "pageA", d.start);
		const b = jobs.join("id:x", "pageB", d.start);
		expect(d.starts()).toBe(1);
		expect(jobs.waiters("id:x")).toBe(2);
		d.finish({ ok: true });
		expect(await a).toEqual({ ok: true });
		expect(await b).toEqual({ ok: true });
		expect(jobs.waiters("id:x")).toBe(0);
	});

	it("one page cancelling does not abort another page's download", async () => {
		const jobs = new SharedJobs<R>(cancelled);
		const d = deferredJob();
		const pack = jobs.join("id:x", "pack", d.start);
		const keep = jobs.join("id:x", "keep", d.start);
		expect(jobs.cancel("id:x", "pack")).toBe(true);
		expect(await pack).toEqual(cancelled());
		expect(d.signal().aborted).toBe(false);
		d.finish({ ok: true });
		expect(await keep).toEqual({ ok: true });
	});

	it("aborts the fetch when the last waiter is withdrawn, and a new join starts afresh", async () => {
		const jobs = new SharedJobs<R>(cancelled);
		const d = deferredJob();
		const a = jobs.join("id:x", "pack", d.start);
		expect(jobs.cancel("id:x", "pack")).toBe(true);
		expect(d.signal().aborted).toBe(true);
		expect(await a).toEqual(cancelled());
		const again = jobs.join("id:x", "keep", d.start);
		expect(d.starts()).toBe(2);
		d.finishers[0]({ ok: false, reason: "cancelled" }); // the aborted job settling late changes nothing
		d.finish({ ok: true });
		expect(await again).toEqual({ ok: true });
	});

	it("cancel without a waiter of that owner is a no-op", async () => {
		const jobs = new SharedJobs<R>(cancelled);
		const d = deferredJob();
		const keep = jobs.join("id:x", "keep", d.start);
		expect(jobs.cancel("id:x", "other")).toBe(false);
		expect(jobs.cancel("id:y", "keep")).toBe(false);
		expect(d.signal().aborted).toBe(false);
		d.finish({ ok: true });
		expect(await keep).toEqual({ ok: true });
	});

	it("a failing job rejects every waiter", async () => {
		const jobs = new SharedJobs<R>(cancelled);
		const a = jobs.join("id:x", "a", () => Promise.reject(new Error("boom")));
		const b = jobs.join("id:x", "b", () => Promise.resolve({ ok: true }));
		await expect(a).rejects.toThrow("boom");
		await expect(b).rejects.toThrow("boom");
	});
});
