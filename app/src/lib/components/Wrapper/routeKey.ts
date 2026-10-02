// c48c (BACKLOG P2, harness login_keeps_inflight_writes): the key the Wrapper
// remounts its page on. The layout passes `$page.url.pathname`, but SvelteKit's
// page store is "notifiable": its subscribers run in Root's afterUpdate, one
// flush AFTER Root already swapped the page component into the slot. The
// `{#key}` then changed late and recreated the freshly mounted page a second
// time (every page's onMount twice per navigation; the first instance stayed
// 150 ms in the outro, so a form filled during that window was wiped: the
// Compte page's login name). `history.pushState` runs BEFORE the swap, so the
// live `location.pathname` is the key that changes in the same flush as the
// slot: the page is created once, the old one outros as K1 intended.
export function liveRouteKey(propKey: string, loc?: { pathname?: unknown } | null): string {
	const p = loc && typeof loc.pathname === "string" ? loc.pathname : "";
	return p || propKey;
}
