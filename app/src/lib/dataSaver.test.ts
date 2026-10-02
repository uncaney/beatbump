import { describe, expect, it, vi } from "vitest";

// The settings store pulls $lib/utils (browser globals): the pure helpers do
// not need it, the live reader is exercised with a stubbed store below.
const storeState: { value: any } = { value: null };
vi.mock("$lib/stores/settings", () => ({ settings: { subscribe: (fn: (v: unknown) => void) => (fn(storeState.value), () => {}) } }));

import { dataSaverActive, dataSaverNotice, dataSaverReason, dataSaverSetting, isDataSaver, readConnection, shouldPrefetch } from "./dataSaver";

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
		expect(dataSaverNotice(true, "save-data")).toMatch(/réglage du téléphone/);
		expect(dataSaverNotice(true, "setting")).toMatch(/^Économie de données active/);
		// L14-10: a 2g-class link is named as such, with the "lifts by itself" note, not as a phone setting
		expect(dataSaverNotice(true, "slow-link")).toMatch(/liaison lente détectée/);
		expect(dataSaverNotice(true, "slow-link")).toMatch(/reprend dès que la connexion s'améliore/);
		expect(dataSaverNotice(true, "slow-link")).not.toMatch(/réglage du téléphone/);
		expect(dataSaverNotice(false, "slow-link")).toBe("");
	});

	it("L14-10: dataSaverReason names the first source that applies", () => {
		expect(dataSaverReason(null)).toBeNull();
		expect(dataSaverReason({ setting: false, saveData: false, effectiveType: "4g" })).toBeNull();
		expect(dataSaverReason({ setting: true, saveData: true, effectiveType: "2g" })).toBe("setting");
		expect(dataSaverReason({ saveData: true, effectiveType: "2g" })).toBe("save-data");
		expect(dataSaverReason({ effectiveType: "slow-2g" })).toBe("slow-link");
		expect(dataSaverReason({ effectiveType: "3g" })).toBeNull();
	});
});
