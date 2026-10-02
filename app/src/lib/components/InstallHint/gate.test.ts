import { describe, expect, it } from "vitest";
import { heardFirstSound, installHintGate } from "./gate";

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

describe("heardFirstSound", () => {
	it("is the paused flag going true -> false, nothing else", () => {
		expect(heardFirstSound(true, false)).toBe(true);
		expect(heardFirstSound(true, true)).toBe(false);
		expect(heardFirstSound(false, false)).toBe(false);
		expect(heardFirstSound(false, true)).toBe(false);
	});
});
