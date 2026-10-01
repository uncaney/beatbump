import type { GlobalIntersectionObserver } from "./observer";

export const CALLBACK_MAP = {
	images: (
		thisArg: GlobalIntersectionObserver,
		entry: IntersectionObserverEntry,
	) => {
		const target = entry.target as HTMLImageElement;
		if (entry.isIntersecting) {
			target
				.decode()
				.finally(() => {
					if (!target.dataset.src) return;

					target.src = target.dataset.src;
				})
				.then(() =>
					// returned so a broken swapped-in src rejects into the catch below
					// instead of surfacing as an unhandled "source image cannot be decoded"
					target.decode().finally(() => {
						thisArg.unobserve(entry.target as HTMLElement);
					}),
				)
				// a broken/empty thumbnail rejects decode() with EncodingError —
				// swallow it so it doesn't surface as an unhandled rejection in console
				.catch(() => {
					thisArg.unobserve(entry.target as HTMLElement);
				});
		}
	},
} as const;
