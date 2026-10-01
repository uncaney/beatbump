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
	isInstalled.set(runningStandalone());

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
