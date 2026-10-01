import { describe, expect, it } from "vitest";
import { queueDrawerInert, type QueueDrawerState } from "./queueDrawer";

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
