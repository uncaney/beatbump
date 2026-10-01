import { describe, expect, it } from "vitest";
import { queueDrawerHiddenFallback, queueDrawerInert, supportsInert, type QueueDrawerState } from "./queueDrawer";

const base: QueueDrawerState = {
	playerState: "open",
	mobile: false,
	sheetOpen: false,
	sliding: false,
	panelOpen: true,
};

describe("queue drawer inert (audit UX v11 section 4)", () => {
	it("is inert whenever the fullscreen player is closed", () => {
		expect(queueDrawerInert({ ...base, playerState: "closed" })).toBe(true);
		expect(queueDrawerInert({ ...base, playerState: "closed", mobile: true, sheetOpen: true })).toBe(true);
	});

	it("desktop: follows the side panel", () => {
		expect(queueDrawerInert({ ...base, panelOpen: true })).toBe(false);
		expect(queueDrawerInert({ ...base, panelOpen: false })).toBe(true);
		// the phone-only flags never matter on desktop
		expect(queueDrawerInert({ ...base, panelOpen: false, sheetOpen: true, sliding: true })).toBe(true);
	});

	it("phone: inert while the sheet is closed and at rest, interactive once open or dragged", () => {
		// Fullscreen.svelte keeps the legacy panel flag inverted on phones
		// (queueOpen starts true, sheetOpen false): the phone decision must
		// not read panelOpen.
		const phone = { ...base, mobile: true, panelOpen: true };
		expect(queueDrawerInert({ ...phone, sheetOpen: false, sliding: false })).toBe(true);
		expect(queueDrawerInert({ ...phone, sheetOpen: true, sliding: false })).toBe(false);
		expect(queueDrawerInert({ ...phone, sheetOpen: false, sliding: true })).toBe(false);
		expect(queueDrawerInert({ ...phone, panelOpen: false, sheetOpen: true })).toBe(false);
	});
});

describe("queue drawer without inert support (L9-9)", () => {
	it("detects inert on the element prototype", () => {
		expect(supportsInert({ inert: false })).toBe(true);
		expect(supportsInert({})).toBe(false);
		expect(supportsInert(undefined)).toBe(true); // SSR: no change
	});
	it("hides only the closed drawer, only when inert is missing", () => {
		expect(queueDrawerHiddenFallback(true, false)).toBe(true);
		expect(queueDrawerHiddenFallback(false, false)).toBe(false); // open drawer stays usable
		expect(queueDrawerHiddenFallback(true, true)).toBe(false); // inert does the job
		expect(queueDrawerHiddenFallback(false, true)).toBe(false);
		// a dragged phone sheet is not inert, so never hidden by the fallback
		const sliding = queueDrawerInert({ ...base, mobile: true, sheetOpen: false, sliding: true });
		expect(queueDrawerHiddenFallback(sliding, false)).toBe(false);
	});
});
