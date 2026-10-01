// Favourite state of the track being played (brainstorm F2), shared by the
// mini-bar heart and the fullscreen heart. Reads IndexedDB through the existing
// IDBService ("get" / "favorites", keyed by videoId, same as the Favorites
// page) and writes through the cycle-6 helper `toggleFavourite`.
import { browser } from "$app/environment";
import { toggleFavourite } from "$lib/favourites";
import type { Item } from "$lib/types";
import { IDBService } from "$lib/workers/db/service";
import { get, writable } from "svelte/store";

export const currentIsFavourite = writable<boolean>(false);

let lastId = "";

/** Re-read the favourite flag for `track` (no-op outside the browser). */
export async function refreshFavouriteState(track: Item | undefined | null) {
	const id = track?.videoId ?? "";
	lastId = id;
	if (!browser || !id) {
		currentIsFavourite.set(false);
		return;
	}
	try {
		const favs = (await IDBService.sendMessage("get", "favorites")) as
			| Array<{ videoId?: string }>
			| undefined;
		if (lastId !== id) return; // track changed while reading
		currentIsFavourite.set(
			Array.isArray(favs) && favs.some((f) => f?.videoId === id),
		);
	} catch {
		currentIsFavourite.set(false);
	}
}

/**
 * Toggle the favourite flag of `track`. The IDB write path already raises a
 * toast ("Added to favorites!" / "Item removed from favorites!") through
 * IDBService.process, so no second toast is emitted here.
 */
export async function toggleCurrentFavourite(track: Item | undefined | null) {
	if (!browser || !track?.videoId) return;
	const saved = get(currentIsFavourite);
	currentIsFavourite.set(!saved); // optimistic
	try {
		await toggleFavourite(track, saved);
	} catch {
		currentIsFavourite.set(saved);
	}
}
