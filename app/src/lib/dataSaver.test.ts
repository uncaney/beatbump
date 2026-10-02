import { describe, expect, it, vi } from "vitest";

// The settings store pulls $lib/utils (browser globals): the pure helpers do
// not need it, the live reader is exercised with a stubbed store below.
const storeState: { value: any } = { value: null };
vi.mock("$lib/stores/settings", () => ({ settings: { subscribe: (fn: (v: unknown) => void) => (fn(storeState.value), () => {}) } }));

import { dataSaverActive, dataSaverNotice, dataSaverSetting, isDataSaver, readConnection, shouldPrefetch } from "./dataSaver";

describe("B8-1 data saver", () => {
	it("is active on the person's switch, the OS switch or a 2g-class link, off otherwise", () => {
		expect(dataSaverActive(null)).toBe(false);
		expect(dataSaverActive({})).toBe(false);
		expect(dataSaverActive({ setting: false, saveData: false, effectiveType: "4g" })).toBe(false);
		expect(dataSaverActive({ setting: true })).toBe(true);
		expect(dataSaverActive({ saveData: true })).toBe(true);
		expect(dataSaverActive({ effectiveType: "2g" })).toBe(true);
		expect(dataSaverActive({ effectiveType: " Slow-2G " })).toBe(true);
		expect(dataSaverActive({ effectiveType: "3g" })).toBe(false);
		// a truthy non-boolean never counts (an undefined API, a string "false")
		expect(dataSaverActive({ setting: "true" as unknown as boolean, saveData: 1 as unknown as boolean })).toBe(false);
	});

	it("shouldPrefetch({saveData:true}) is false", () => {
		expect(shouldPrefetch({ saveData: true })).toBe(false);
		expect(shouldPrefetch({ setting: true })).toBe(false);
		expect(shouldPrefetch({ setting: false, saveData: false, effectiveType: "4g" })).toBe(true);
		expect(shouldPrefetch(undefined)).toBe(true);
	});

	it("readConnection tolerates browsers without the API", () => {
		expect(readConnection(null)).toEqual({});
		expect(readConnection({})).toEqual({});
		expect(readConnection({ connection: { saveData: true, effectiveType: "3g" } })).toEqual({ saveData: true, effectiveType: "3g" });
		expect(readConnection({ connection: { saveData: undefined } })).toEqual({ saveData: false, effectiveType: null });
		expect(readConnection({ mozConnection: { saveData: true } })).toEqual({ saveData: true, effectiveType: null });
		expect(
			readConnection({
				get connection() {
					throw new Error("blocked");
				},
			}),
		).toEqual({});
	});

	it("isDataSaver reads the switch from the settings store and the browser", () => {
		storeState.value = { playback: { "Data Saver": true } };
		expect(dataSaverSetting()).toBe(true);
		expect(isDataSaver()).toBe(true);
		storeState.value = { playback: {} };
		expect(dataSaverSetting()).toBe(false);
		expect(isDataSaver()).toBe(false);
		vi.stubGlobal("navigator", { connection: { saveData: true } });
		try {
			expect(isDataSaver()).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
		storeState.value = null;
		expect(dataSaverSetting()).toBe(false);
	});

	it("the offline page notice names the source and is empty when off", () => {
		expect(dataSaverNotice(false)).toBe("");
		expect(dataSaverNotice(true)).toMatch(/^Économie de données active/);
		expect(dataSaverNotice(true, true)).toMatch(/réglage du téléphone/);
	});
});
