// B8-1 "Économie de données" (cycle 47): on a metered phone nothing is
// downloaded that the person did not ask for: no prefetch of the next track
// (sessionList.ts prefetchTrackAtIndex), no automatic offline caching of the
// played track (player.ts autoCache) nor of the prefetched one (offline.ts
// prefetch hook). Active when the browser says so (navigator.connection
// .saveData, the OS "data saver" switch; a 2g / slow-2g effectiveType) or when
// the switch in Réglages > Lecture is on (settings.playback["Data Saver"],
// persisted with the other settings). Explicit "Garder hors-ligne" and packs
// are never held back: the person asked for them.
//
// Import cycle note: this module is imported by player.ts / sessionList.ts
// (cycle B) and reads the settings store (cycle A) INSIDE functions only;
// nothing here uses an imported binding at module level.
import { get } from "svelte/store";
import { settings } from "$lib/stores/settings";

export type DataSaverInput = {
	/** settings.playback["Data Saver"]: the person's switch (undefined / null = off). */
	setting?: boolean | null;
	/** navigator.connection.saveData (the OS / browser data-saver switch). */
	saveData?: boolean | null;
	/** navigator.connection.effectiveType ("4g", "3g", "2g", "slow-2g"). */
	effectiveType?: string | null;
};

const SLOW_TYPES = new Set(["2g", "slow-2g"]);

/** True when data must be saved: the person's switch, the OS switch, or a 2g-class link. Pure. */
export function dataSaverActive(i: DataSaverInput | null | undefined): boolean {
	if (!i) return false;
	if (i.setting === true) return true;
	if (i.saveData === true) return true;
	const t = typeof i.effectiveType === "string" ? i.effectiveType.trim().toLowerCase() : "";
	return SLOW_TYPES.has(t);
}

/** The next-track prefetch (and the auto-cache that rides on it) runs only off data saver. Pure. */
export function shouldPrefetch(i: DataSaverInput | null | undefined): boolean {
	return !dataSaverActive(i);
}

/** What the browser says about the connection (empty on SSR / browsers without the API). */
export function readConnection(nav: any = typeof navigator === "undefined" ? null : navigator): Pick<DataSaverInput, "saveData" | "effectiveType"> {
	try {
		const c = nav?.connection ?? nav?.mozConnection ?? nav?.webkitConnection;
		if (!c) return {};
		return { saveData: c.saveData === true, effectiveType: typeof c.effectiveType === "string" ? c.effectiveType : null };
	} catch {
		return {};
	}
}

/** The person's switch, read from the settings store (false on SSR / unset). */
export function dataSaverSetting(): boolean {
	try {
		return get(settings)?.playback?.["Data Saver"] === true;
	} catch {
		return false;
	}
}

/** Live answer: the switch in Réglages or the browser's own data-saver state. */
export function isDataSaver(): boolean {
	return dataSaverActive({ setting: dataSaverSetting(), ...readConnection() });
}

/** The one-line notice of the offline page when data saver is on ("" otherwise). */
export function dataSaverNotice(active: boolean, fromBrowser = false): string {
	if (!active) return "";
	return fromBrowser
		? "Économie de données (réglage du téléphone) : les titres écoutés ne sont pas gardés hors-ligne automatiquement et le titre suivant n'est pas préchargé."
		: "Économie de données active : les titres écoutés ne sont pas gardés hors-ligne automatiquement et le titre suivant n'est pas préchargé.";
}
