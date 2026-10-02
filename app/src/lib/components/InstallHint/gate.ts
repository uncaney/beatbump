// c48c B8-4: the install bar is proposed after the first sound of the
// session, never on first paint. Pure helpers, unit-tested; InstallHint.svelte
// feeds them from AudioPlayer.paused and $page.
export type InstallHintGateInput = {
	/** A track started playing in this session (AudioPlayer.paused went true -> false once). */
	heardSound: boolean;
	/** Current pathname: /bienvenue (the install page) shows the bar without a sound. */
	pathname: string;
};

/** The pages whose first paint may carry the bar (they ARE about installing). */
export const INSTALL_HINT_PATHS = ["/bienvenue"];

/** True when the bar may be proposed: a sound was heard this session, or the page is the install page. */
export function installHintGate(s: InstallHintGateInput): boolean {
	if (s.heardSound) return true;
	const p = (s.pathname || "").replace(/\/+$/, "") || "/";
	return INSTALL_HINT_PATHS.some((base) => p === base || p.startsWith(base + "/"));
}

/** The first sound of the session: the paused flag goes true -> false (a restored, paused track never counts). */
export function heardFirstSound(prevPaused: boolean, paused: boolean): boolean {
	return prevPaused && !paused;
}

/**
 * B9-1 (U13-13): on /bienvenue the page already IS the step-by-step guide, so the
 * bar's "Comment installer ?" link would only point back to the current page.
 * The bar itself stays (its "Installer" button is still useful), but the link is
 * dropped there. Returns false exactly on the install page(s).
 */
export function showInstallHintLink(pathname: string): boolean {
	const p = (pathname || "").replace(/\/+$/, "") || "/";
	return !INSTALL_HINT_PATHS.some((base) => p === base || p.startsWith(base + "/"));
}
