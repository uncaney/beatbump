/**
 * Audit UX v11 section 4: the queue drawer of the fullscreen player keeps
 * ~100 focusable rows / artist links in the DOM while it is closed (the
 * phone sheet below the handle, the desktop side panel slid off-screen, or
 * the whole player closed). Keyboard users tabbed through invisible rows.
 *
 * Pure decision for the `inert` (+ aria-hidden / tabindex fallback) flag of
 * the drawer BODY (the tab bar + lists; never the handle, which must stay
 * tappable to open the sheet). On phones the sheet is interactive while it
 * is open OR being dragged (`sliding`, so a drag that reveals rows never
 * hits an inert subtree); on desktop the side panel is interactive when it
 * is slid in (`panelOpen`).
 */
export interface QueueDrawerState {
	/** The fullscreen player itself ("open" | "closed"). */
	playerState: "open" | "closed";
	/** Phone layout (< 720px): the queue is a bottom sheet. */
	mobile: boolean;
	/** Phone sheet opened by its handle. */
	sheetOpen: boolean;
	/** Phone sheet currently dragged by its handle. */
	sliding: boolean;
	/** Desktop side panel slid in (the legacy `queueOpen` flag). */
	panelOpen: boolean;
}

/** True when the drawer body must be inert (not focusable, hidden from AT). */
export function queueDrawerInert(s: QueueDrawerState): boolean {
	if (s.playerState !== "open") return true;
	if (s.mobile) return !(s.sheetOpen || s.sliding);
	return !s.panelOpen;
}
