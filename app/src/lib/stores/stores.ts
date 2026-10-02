import type { Item } from "$lib/types";
import { filter } from "$lib/utils/collections";
import { derived, writable, type Readable } from "svelte/store";
import { settings, type UserSettings } from "./settings";

export const ctxKey = {};
export const currentTitle = writable(undefined);

/** Button rendered inside an alert; the alert stays until clicked (or 20 s). */
export type AlertAction = { label: string; run: () => void };

export type Alert = {
	msg?: string;
	/** A string (legacy metadata such as "getNextTrack") renders nothing. */
	action?: string | AlertAction;
	type?: string;
	id?: number;
};

// Derived from Settings.
// L13-11: this module and `./settings` sit on an import cycle (settings.ts ->
// $lib/utils -> utils/utils.ts -> stores/stores.ts -> settings.ts). A
// top-level `derived(settings, ...)` reads the `settings` binding while the
// cycle is still evaluating: safe today only because every entry reaches
// settings.ts before this file; an entry through `$lib/stores/settings`
// first would throw "Cannot access 'settings' before initialization" at
// startup. The derived is built on the first subscription instead, when the
// whole cycle has long been initialised (lazy, whatever the module order).
function fromSettings<T>(pick: ($settings: UserSettings) => T): Readable<T> {
	let inner: Readable<T> | null = null;
	return {
		subscribe: (run, invalidate) => (inner ??= derived(settings, pick)).subscribe(run, invalidate),
	};
}
export const theme = fromSettings(($settings) => $settings.appearance.Theme);
export const filterAutoPlay = fromSettings(($settings) => $settings?.playback["Dedupe Automix"]);
export const preferWebM = fromSettings(($settings) => $settings?.playback["Prefer WebM Audio"]);
export const preserveSearch = fromSettings(($settings) => $settings?.search?.Preserve);
export const immersiveQueue = fromSettings(($settings) => $settings?.appearance["Immersive Queue"]);
// Alert
export const alertHandler = _alertHandler();
function _alertHandler() {
	const { set, subscribe, update } = writable<Alert[]>([]);
	let id = -1;
	return {
		subscribe,
		add: ({ msg, type, action }: Alert) => {
			update((u) => [...u, { msg, type, action, id: ++id }]);
		},
		remove: ({ id }: Alert) => {
			update((u) => filter(u, (item) => item.id !== id));
		},
	};
}

export const isPagePlaying = _isPagePlaying();

function _isPagePlaying() {
	const pageIds = new Set<string>(["player-queue"]);

	const { subscribe, set } = writable<Set<string>>(pageIds);

	return {
		subscribe,
		add(id: string) {
			pageIds.add(id);
			set(pageIds);
		},
		clear() {
			pageIds.clear();
			set(pageIds);
		},
		has(id: string) {
			return pageIds.has(id);
		},
		remove(id: string) {
			if (!pageIds.has(id)) return;
			pageIds.delete(id);
		},
	};
}
export const playerLoading = writable(false);

export const showAddToPlaylistPopper = writable<{
	state: boolean;
	item: Item | Item[] | undefined;
}>({
	state: false,
	item: undefined,
});

export const showDownloadSongPopper = writable<{
	state: boolean;
	item: Item | undefined;
}>({
	state: false,
	item: undefined,
});

export const showGroupSessionManager = writable<boolean>(false);
export const showGroupSessionCreator = writable<boolean>(false);
