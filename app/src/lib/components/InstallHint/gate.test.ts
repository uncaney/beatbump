import { describe, expect, it } from "vitest";
import { heardFirstSound, installHintGate, installOffer, isAndroidUA, showInstallHintLink } from "./gate";

describe("installHintGate", () => {
	it("never on first paint: no sound heard, an ordinary page", () => {
		expect(installHintGate({ heardSound: false, pathname: "/home" })).toBe(false);
		expect(installHintGate({ heardSound: false, pathname: "/" })).toBe(false);
		expect(installHintGate({ heardSound: false, pathname: "" })).toBe(false);
		expect(installHintGate({ heardSound: false, pathname: "/library/downloads-offline" })).toBe(false);
	});

	it("after the first sound of the session, on any page", () => {
		expect(installHintGate({ heardSound: true, pathname: "/home" })).toBe(true);
		expect(installHintGate({ heardSound: true, pathname: "/search/daft%20punk" })).toBe(true);
	});

	it("on /bienvenue without a sound (the install page), not on a look-alike", () => {
		expect(installHintGate({ heardSound: false, pathname: "/bienvenue" })).toBe(true);
		expect(installHintGate({ heardSound: false, pathname: "/bienvenue/" })).toBe(true);
		expect(installHintGate({ heardSound: false, pathname: "/bienvenue-x" })).toBe(false);
	});
});

describe("showInstallHintLink", () => {
	it("hides the self-referential link on the install page, keeps it elsewhere", () => {
		expect(showInstallHintLink("/bienvenue")).toBe(false);
		expect(showInstallHintLink("/bienvenue/")).toBe(false);
		expect(showInstallHintLink("/home")).toBe(true);
		expect(showInstallHintLink("/bienvenue-x")).toBe(true);
		expect(showInstallHintLink("")).toBe(true);
	});
});

describe("heardFirstSound", () => {
	it("is the paused flag going true -> false, nothing else", () => {
		expect(heardFirstSound(true, false)).toBe(true);
		expect(heardFirstSound(true, true)).toBe(false);
		expect(heardFirstSound(false, false)).toBe(false);
		expect(heardFirstSound(false, true)).toBe(false);
	});
});

describe("U14-3 installOffer", () => {
	it("the captured prompt wins (one tap), on any platform", () => {
		expect(installOffer({ isIOS: false, isAndroid: true, hasPrompt: true })).toBe("prompt");
		expect(installOffer({ isIOS: false, isAndroid: false, hasPrompt: true })).toBe("prompt");
	});
	it("iOS: the Share steps, as before", () => {
		expect(installOffer({ isIOS: true, isAndroid: false, hasPrompt: false })).toBe("ios");
	});
	it("Android without beforeinstallprompt (Vanadium, Firefox, a refused prompt): the menu steps, not nothing", () => {
		expect(installOffer({ isIOS: false, isAndroid: true, hasPrompt: false })).toBe("android-manual");
	});
	it("a desktop browser without the event: no bar", () => {
		expect(installOffer({ isIOS: false, isAndroid: false, hasPrompt: false })).toBeNull();
	});
	it("isAndroidUA", () => {
		expect(isAndroidUA("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")).toBe(true);
		expect(isAndroidUA("Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0")).toBe(true);
		expect(isAndroidUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(false);
		expect(isAndroidUA(null)).toBe(false);
	});
});
