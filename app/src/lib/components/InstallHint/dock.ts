// UX5 (brainstorm v5, cycle 35): where the install hint docks.
// With a mini-player it sits right on top of the player bar; without one it
// used to dock under the top nav, where it covered the library nav and the
// page title (/about "À propos / État" unreadable on phones). It now always
// docks at the bottom of the viewport: above the player bar when there is
// one, else on the bottom edge with the safe-area inset (home indicator).
// The app has no bottom navigation bar; `bottomNav` is the height of one if
// a page ever adds it (CSS length), so the hint stays above it.

export type InstallHintDock = "above-player" | "bottom";

export function installHintDock(hasPlayer: boolean): InstallHintDock {
	return hasPlayer ? "above-player" : "bottom";
}

export interface InstallHintGeometry {
	/** CSS `bottom` of the fixed strip. */
	bottom: string;
	/** Extra bottom padding (safe area) inside the strip. */
	safeArea: string;
}

/**
 * Fixed-position geometry of the strip. Never `top`: the hint must never
 * sit over the nav or a page title.
 */
export function installHintGeometry(dock: InstallHintDock, bottomNav = "0px"): InstallHintGeometry {
	if (dock === "above-player") {
		// The footer already contains the safe-area inset.
		return { bottom: "var(--player-bar-height, 0px)", safeArea: "0px" };
	}
	return { bottom: bottomNav, safeArea: "env(safe-area-inset-bottom, 0px)" };
}

/**
 * L10-14: room the visible strip takes over the page bottom. The page's
 * `main` gets that much more space at its end (InstallHint sets
 * `--install-hint-reserve` + `data-install-hint` on <html>) so the last row /
 * button is never under the strip. null = nothing to reserve.
 */
export function installHintReserve(show: boolean, stripHeightPx: number): string | null {
	if (!show || !Number.isFinite(stripHeightPx) || stripHeightPx <= 0) return null;
	return `${Math.ceil(stripHeightPx)}px`;
}
