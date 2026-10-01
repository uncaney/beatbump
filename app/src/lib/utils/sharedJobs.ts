/**
 * L8-16: in-flight dedup with per-waiter cancellation, used by the service
 * worker's `cache-audio` / `abort-audio` (one download per videoId shared by
 * every page that asked for it).
 *
 * Each `join` is one waiter (a page's cache-audio message), tagged with its
 * owner (the id of the client that sent it). `cancel(key, owner)` withdraws
 * ONE waiter of that owner: it resolves at once with the `cancelled` value,
 * while the shared job keeps running for the other waiters. The job's
 * AbortSignal fires only when its last waiter is withdrawn. So the pack's
 * "Annuler" no longer aborts another page's "Garder hors-ligne" of the same
 * track.
 */
type Waiter<T> = { owner: string; resolve: (v: T) => void; reject: (e: unknown) => void };
type Job<T> = { ctrl: AbortController; waiters: Waiter<T>[] };

export class SharedJobs<T> {
	private jobs = new Map<string, Job<T>>();

	constructor(private readonly cancelled: () => T) {}

	/** Join (or start) the job `key`; resolves with its result, or `cancelled()` once this waiter is withdrawn. */
	join(key: string, owner: string, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const running = this.jobs.get(key);
		const job: Job<T> = running ?? { ctrl: new AbortController(), waiters: [] };
		const waiter = new Promise<T>((resolve, reject) => job.waiters.push({ owner, resolve, reject }));
		if (!running) {
			this.jobs.set(key, job);
			let p: Promise<T>;
			try {
				p = start(job.ctrl.signal);
			} catch (e) {
				p = Promise.reject(e);
			}
			const done = (fn: (w: Waiter<T>) => void) => {
				if (this.jobs.get(key) === job) this.jobs.delete(key);
				const ws = job.waiters.splice(0);
				for (const w of ws) fn(w);
			};
			p.then(
				(v) => done((w) => w.resolve(v)),
				(e) => done((w) => w.reject(e)),
			);
		}
		return waiter;
	}

	/** Withdraw the latest waiter of `owner` from `key`; false when it has none there. */
	cancel(key: string, owner: string): boolean {
		const job = this.jobs.get(key);
		if (!job) return false;
		for (let i = job.waiters.length - 1; i >= 0; i--) {
			if (job.waiters[i].owner !== owner) continue;
			const [w] = job.waiters.splice(i, 1);
			w.resolve(this.cancelled());
			if (job.waiters.length === 0) {
				// nobody waits any more: stop the download and forget the job, so
				// a new request starts afresh instead of joining an aborted one
				this.jobs.delete(key);
				job.ctrl.abort();
			}
			return true;
		}
		return false;
	}

	/** Live waiters of `key` (tests, diagnostics). */
	waiters(key: string): number {
		return this.jobs.get(key)?.waiters.length ?? 0;
	}
}
