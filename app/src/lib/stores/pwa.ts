// PWA install state.
//
// Chromium browsers fire `beforeinstallprompt` once the manifest + service
// worker make the app installable; we capture (and preventDefault) it here so
// Settings > Application can offer an explicit "Installer l'application"
// button that calls `prompt()`. `isInstalled` tracks whether the app already
// runs installed (display-mode: standalone, iOS `navigator.standalone`, or the
// `appinstalled` event); `isIOS` lets the UI show the Share > Add-to-Home-Screen
// hint on Safari, which never fires the event.
import { browser } from "$app/environment";
import { get, writable } from "svelte/store";

export interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

/** The captured `beforeinstallprompt` event, or null when the browser never fired it (iOS, Firefox, already installed, already dismissed). */
export const installPrompt = writable<BeforeInstallPromptEvent | null>(null);
/** True when the app is running installed (standalone display mode) or was just installed. */
export const isInstalled = writable(false);
/** True on iPhone / iPad (incl. iPadOS 13+ which reports itself as a Mac). */
export const isIOS = writable(false);
/** U14-3: true on Android (any browser): without `beforeinstallprompt` the install bar shows the menu steps. */
export const isAndroid = writable(false);

// HL4: contextual install hint. Eligible once the visit counter reaches 3
// (bumped once per app load, see `recordVisit` below) OR the first
// "Garder hors-ligne" batch succeeds this session (`markOfflineSuccess`,
// called from the offline pages/components); InstallHint.svelte combines
// this with `installPrompt` / `isIOS` / `isInstalled` and the 14-day snooze
// before actually rendering.
export const installHintEligible = writable(false);

const VISITS_KEY = "ytm-visits";
const INSTALL_HINT_SNOOZE_KEY = "ytm-install-hint-snooze";
const INSTALL_HINT_SNOOZE_DAYS = 14;

/** Bump the visit counter (localStorage, persists across sessions); returns the new count. Never throws. */
function recordVisit(): number {
	if (!browser) return 0;
	try {
		const n = (parseInt(localStorage.getItem(VISITS_KEY) || "0", 10) || 0) + 1;
		localStorage.setItem(VISITS_KEY, String(n));
		return n;
	} catch {
		return 0;
	}
}

/** HL4: called after the first "Garder hors-ligne" batch succeeds (>= 1 track kept). */
export function markOfflineSuccess(): void {
	installHintEligible.set(true);
}

/** True while the 14-day "Plus tard" snooze (from `snoozeInstallHint`) is still running. */
export function isInstallHintSnoozed(): boolean {
	if (!browser) return true;
	try {
		const until = Number(localStorage.getItem(INSTALL_HINT_SNOOZE_KEY) || 0);
		return Date.now() < until;
	} catch {
		return false;
	}
}

/** "Plus tard": hide the install hint for `INSTALL_HINT_SNOOZE_DAYS` days. */
export function snoozeInstallHint(): void {
	if (!browser) return;
	try {
		localStorage.setItem(INSTALL_HINT_SNOOZE_KEY, String(Date.now() + INSTALL_HINT_SNOOZE_DAYS * 24 * 60 * 60 * 1000));
	} catch {
		/* no storage: the hint may show again next load, harmless */
	}
}

const STANDALONE_MQ = "(display-mode: standalone)";

function runningStandalone(): boolean {
	if (!browser) return false;
	const nav = navigator as Navigator & { standalone?: boolean };
	try {
		if (window.matchMedia(STANDALONE_MQ).matches) return true;
	} catch {
		/* matchMedia unavailable */
	}
	return nav.standalone === true;
}

let initialized = false;

/** Install the listeners once; safe to call from the root layout at any time. */
export function initPwa(): void {
	if (!browser || initialized) return;
	initialized = true;

	const ua = navigator.userAgent;
	isIOS.set(/iPhone|iPad|iPod/.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1));
	isAndroid.set(/Android/i.test(ua));
	isInstalled.set(runningStandalone());
	if (recordVisit() >= 3) installHintEligible.set(true);

	try {
		const mq = window.matchMedia(STANDALONE_MQ);
		mq.addEventListener("change", (e) => isInstalled.set(e.matches || runningStandalone()));
	} catch {
		/* matchMedia unavailable */
	}

	window.addEventListener("beforeinstallprompt", (e) => {
		// Keep the browser's mini-infobar quiet; Settings shows our own button.
		e.preventDefault();
		installPrompt.set(e as BeforeInstallPromptEvent);
	});
	window.addEventListener("appinstalled", () => {
		isInstalled.set(true);
		installPrompt.set(null);
	});
}

/** Show the native install dialog (Chromium only). The captured event is single-use. */
export async function promptInstall(): Promise<InstallOutcome> {
	const ev = get(installPrompt);
	if (!ev) return "unavailable";
	installPrompt.set(null);
	try {
		await ev.prompt();
		const { outcome } = await ev.userChoice;
		if (outcome === "accepted") isInstalled.set(true);
		return outcome;
	} catch {
		return "dismissed";
	}
}
