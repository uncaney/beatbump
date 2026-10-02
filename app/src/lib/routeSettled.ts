// c56a (black screen on "Préparer 2 h"): the root layout keys every page on
// the route and crossfades it (Wrapper.svelte, 150 ms fly). During the fade
// the OUTGOING page stays in the document flow above the incoming one, at
// opacity 0 (black). Anything that scrolls to an element of the new page in
// that window (scrollIntoView from an onMount) scrolls the container past the
// outgoing page's height; the user sees the black outgoing block, and once
// it is removed the scroll position is clamped back to the top, so the scroll
// did not even land. These helpers wait for the outgoing page to be gone.

/** Selector of a page block still animating out (or in) in the root layout. */
export const TRANSITION_WRAPPER = ".app-transition-wrapper";

/**
 * True when no keyed page block is animating any more: a single wrapper (or
 * none, outside the app layout) and none with a Svelte animation style.
 * Pure: takes the document (tests pass a jsdom one).
 */
export function routeSettled(doc: Document | null | undefined): boolean {
	if (!doc) return true;
	const wrappers = doc.querySelectorAll(TRANSITION_WRAPPER);
	if (wrappers.length <= 1) {
		const only = wrappers[0] as HTMLElement | undefined;
		return !only || !only.style.animation;
	}
	return false;
}

/**
 * Resolve once the route transition has settled, polling each animation
 * frame (fallback: a timer when rAF is unavailable), at most `timeoutMs`
 * (the fade lasts 150 ms; the cap guards a stalled outro so the caller
 * still runs). Never rejects.
 */
export function whenRouteSettled(doc: Document | null | undefined, timeoutMs = 600): Promise<void> {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const schedule = (fn: () => void) => {
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
			else setTimeout(fn, 16);
		};
		const tickFn = () => {
			if (routeSettled(doc) || Date.now() - t0 >= timeoutMs) return resolve();
			schedule(tickFn);
		};
		tickFn();
	});
}

/**
 * scrollIntoView(el) once the page transition is over, and only when `el` is
 * not already fully visible. Safe on null and on environments without
 * scrollIntoView (jsdom). Resolves true when it scrolled.
 */
export async function scrollIntoViewWhenSettled(
	el: Element | null | undefined,
	opts: ScrollIntoViewOptions = { block: "center" },
	timeoutMs = 600,
): Promise<boolean> {
	if (!el) return false;
	await whenRouteSettled(el.ownerDocument, timeoutMs);
	if (!el.isConnected) return false;
	try {
		const r = el.getBoundingClientRect();
		const vh = typeof window !== "undefined" ? window.innerHeight || 0 : 0;
		if (vh && r.height && r.top >= 0 && r.bottom <= vh) return false;
		if (typeof (el as HTMLElement).scrollIntoView !== "function") return false;
		(el as HTMLElement).scrollIntoView(opts);
		return true;
	} catch {
		return false;
	}
}
