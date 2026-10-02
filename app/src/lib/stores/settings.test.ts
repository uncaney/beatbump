// @vitest-environment jsdom
// c55a (harness lane c53c, ux_v13_data_saver): Réglages > Lecture, the note
// "Suspendu tant que l'économie de données est active" under the Garder
// switch (OfflineSettings) only appeared after a reload. Svelte compiles
// `bind:checked={$settings.playback["Data Saver"]}` to an in-place mutation
// followed by `settings.set($settings)`: the SAME object. The store's set
// (WritableStore) skipped the notification for an identical reference, so
// every other subscriber ($settings in another component, the derived
// stores of stores.ts) kept the stale value. The store now notifies on every
// set, like a plain svelte/store writable does for objects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$app/environment", () => ({ browser: true }));

import { get } from "svelte/store";

describe("settings.set with the object the store already holds (Svelte bind:)", () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
	});
	afterEach(() => {
		localStorage.clear();
	});

	it("notifies every subscriber and persists the value", async () => {
		const { settings } = await import("./settings");
		const seen: unknown[] = [];
		const unsub = settings.subscribe((v) => seen.push(v?.playback?.["Data Saver"]));
		expect(seen).toEqual([false]);

		const cur = get(settings);
		cur.playback["Data Saver"] = true;
		settings.set(cur); // what bind:checked compiles to: same reference

		expect(seen).toEqual([false, true]);
		expect(get(settings).playback["Data Saver"]).toBe(true);
		expect(JSON.parse(localStorage.getItem("settings") ?? "{}").playback["Data Saver"]).toBe(true);

		cur.playback["Data Saver"] = false;
		settings.set(get(settings));
		expect(seen).toEqual([false, true, false]);
		unsub();
	});

	it("a derived reader (dataSaverSetting) follows the switch without a reload", async () => {
		const { settings } = await import("./settings");
		const { dataSaverSetting } = await import("$lib/dataSaver");
		expect(dataSaverSetting()).toBe(false);
		const cur = get(settings);
		cur.playback["Data Saver"] = true;
		settings.set(cur);
		expect(dataSaverSetting()).toBe(true);
	});
});
