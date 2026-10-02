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

/**
 * L14-10: why data is being saved, the first source that applies: the
 * person's switch ("setting"), the OS / browser data-saver switch
 * ("save-data"), or a 2g-class link ("slow-link": Chrome's estimate from
 * the round trips, which a degraded 4G reaches for a few minutes and which
 * lifts by itself). null when nothing applies. Pure.
 */
export type DataSaverReason = "setting" | "save-data" | "slow-link";
export function dataSaverReason(i: DataSaverInput | null | undefined): DataSaverReason | null {
	if (!i) return null;
	if (i.setting === true) return "setting";
	if (i.saveData === true) return "save-data";
	const t = typeof i.effectiveType === "string" ? i.effectiveType.trim().toLowerCase() : "";
	return SLOW_TYPES.has(t) ? "slow-link" : null;
}

/** True when data must be saved: the person's switch, the OS switch, or a 2g-class link. Pure. */
export function dataSaverActive(i: DataSaverInput | null | undefined): boolean {
	return dataSaverReason(i) !== null;
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

/**
 * The one-line notice of the offline page when data saver is on ("" otherwise).
 * `from` names the source (dataSaverReason); the booleans of the first
 * version still work (true = the OS switch, false = the person's switch).
 * L14-10: a slow link is named as such, not as a phone setting nobody set.
 */
export function dataSaverNotice(active: boolean, from: boolean | DataSaverReason | null = false): string {
	if (!active) return "";
	const reason: DataSaverReason = from === true ? "save-data" : from === false || from === null ? "setting" : from;
	const effect = "les titres écoutés ne sont pas gardés hors-ligne automatiquement et le titre suivant n'est pas préchargé";
	switch (reason) {
		case "save-data":
			return `Économie de données (réglage du téléphone) : ${effect}.`;
		case "slow-link":
			return `Économie de données (liaison lente détectée) : ${effect} ; tout reprend dès que la connexion s'améliore.`;
		default:
			return `Économie de données active : ${effect}.`;
	}
}
