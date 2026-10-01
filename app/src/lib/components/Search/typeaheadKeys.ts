/**
 * H7b: the search box re-ran the YouTube typeahead on EVERY keyup, arrows
 * and modifiers included (an ArrowDown that found no row to move to, Shift,
 * Home/End, Escape...), which cancelled the in-flight lookup and fetched the
 * same suggestions again. A lookup is only worth re-running when the query
 * text actually changed.
 */

/** Keys that never change the query text. */
const NAVIGATION_KEYS = new Set([
	"ArrowDown",
	"ArrowUp",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"Tab",
	"Shift",
	"Control",
	"Alt",
	"Meta",
	"AltGraph",
	"CapsLock",
	"NumLock",
	"ScrollLock",
	"Escape",
	"Enter",
	"ContextMenu",
	"Insert",
	"Dead",
]);

/** True for a key that moves the caret / focus or is a bare modifier. */
export function isNavigationKey(key: string | undefined): boolean {
	if (!key) return false;
	return NAVIGATION_KEYS.has(key) || /^F\d{1,2}$/.test(key);
}

/**
 * Whether a keyup should (re)run the typeahead: never for a navigation key,
 * and only when the query differs from the one the last lookup ran with
 * (`lastQuery`, "" before any). A deliberate re-run (refocus after a submit)
 * bypasses this and calls the typeahead directly.
 */
export function shouldTypeaheadOnKeyup(key: string | undefined, query: string, lastQuery: string): boolean {
	if (isNavigationKey(key)) return false;
	return query !== lastQuery;
}
