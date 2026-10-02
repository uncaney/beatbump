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
