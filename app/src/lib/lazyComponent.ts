import type { ComponentType, SvelteComponent } from "svelte";
import { writable, type Readable } from "svelte/store";

/**
 * K7 (audit perf v2): a component whose chunk is only fetched on first use.
 * `load()` is idempotent (one import in flight, retried after a failure); the
 * store holds the constructor once loaded (null before), ready for
 * `<svelte:component this={$Lazy} …/>`, which renders nothing while null.
 */
export interface LazyComponent<T> extends Readable<T | null> {
	load: () => Promise<T>;
}

export function lazyComponent<T extends ComponentType<SvelteComponent>>(
	loader: () => Promise<{ default: T }>,
): LazyComponent<T> {
	const store = writable<T | null>(null);
	let pending: Promise<T> | null = null;
	const load = () => {
		if (!pending) {
			pending = loader()
				.then((m) => {
					store.set(m.default);
					return m.default;
				})
				.catch((e) => {
					pending = null;
					throw e;
				});
		}
		return pending;
	};
	return { subscribe: store.subscribe, load };
}
