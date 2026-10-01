import type { ComponentType, SvelteComponent } from "svelte";
import { writable, type Readable } from "svelte/store";

/**
 * K7 (audit perf v2): a component whose chunk is only fetched on first use.
 * `load()` is idempotent (one import in flight, retried after a failure); the
 * store holds the constructor once loaded (null before), ready for
 * `<svelte:component this={$Lazy} …/>`, which renders nothing while null.
 *
 * L16 (audit v7, P1): a deferred chunk can 404 right after a service-worker
 * update dropped the old shell (see +layout.svelte). `load()` now retries
 * ONCE after `retryDelayMs` before giving up, and `onError` is called on
 * every failed attempt (`attempt` 0 = about to retry, 1 = giving up) so the
 * caller can reset the store that triggered the load and offer a reload
 * instead of leaving the page silently stuck (e.g. `no-scroll`).
 */
export interface LazyComponent<T> extends Readable<T | null> {
	load: () => Promise<T>;
}

export interface LazyComponentOptions {
	onError?: (error: unknown, attempt: number) => void;
	retryDelayMs?: number;
}

export function lazyComponent<T extends ComponentType<SvelteComponent>>(
	loader: () => Promise<{ default: T }>,
	opts: LazyComponentOptions = {},
): LazyComponent<T> {
	const store = writable<T | null>(null);
	const retryDelayMs = opts.retryDelayMs ?? 1000;
	let pending: Promise<T> | null = null;

	const attempt = (n: number): Promise<T> =>
		loader()
			.then((m) => {
				store.set(m.default);
				return m.default;
			})
			.catch((e) => {
				opts.onError?.(e, n);
				if (n === 0) {
					// One retry after a short delay: covers the common 404-right-
					// after-deploy race without the caller doing anything.
					return new Promise<T>((resolve, reject) => {
						setTimeout(() => attempt(1).then(resolve, reject), retryDelayMs);
					});
				}
				throw e;
			});

	const load = () => {
		if (!pending) {
			pending = attempt(0).catch((e) => {
				pending = null; // both attempts failed: a later load() tries fresh
				throw e;
			});
		}
		return pending;
	};
	return { subscribe: store.subscribe, load };
}
