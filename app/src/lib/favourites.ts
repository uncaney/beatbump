// Single write path for favourites (audit F4).
//
// Favourites used to be written to two stores inconsistently: Item/Listing
// wrote IndexedDB + the server profile, while ListItem / LocalListItem /
// CarouselItem wrote IndexedDB only, so the server-backed "Saved" view and
// cross-device sync missed most of them.
//
// - IndexedDB keeps the exact same store / shape as before ("favorites",
//   message type "favorite"), so existing data stays readable.
// - The server write (/api/v1/me/favorites) is fire-and-forget: it never
//   blocks the UI and silently tolerates 401 / offline / network errors.
//
// The returned promise is the IndexedDB write so callers that need to refresh
// a list afterwards (e.g. "Remove From Favorites") can await it as before.
import { browser } from "$app/environment";
import { addFavorite, removeFavoriteItem } from "$lib/me";
import type { Item } from "$lib/types";
import type { IListItemRenderer } from "$lib/types/musicListItemRenderer";
import { IDBService } from "$lib/workers/db/service";

type IDBResult = ReturnType<typeof IDBService.sendMessage>;

// Every call site passes either a queue/list `Item` or a carousel
// `IListItemRenderer`; IndexedDB stores the object as-is (same as before).
export type FavouriteInput = Item | IListItemRenderer;

function serverWrite(p: Promise<unknown> | undefined) {
	// Never let a server failure surface: the IDB copy is authoritative locally.
	if (p && typeof (p as Promise<unknown>).catch === "function") {
		(p as Promise<unknown>).catch(() => {});
	}
}

/** Add `item` to favourites: IndexedDB (awaitable) + server (fire-and-forget). */
export function saveFavourite(item: FavouriteInput): IDBResult | Promise<undefined> {
	if (!browser || !item) return Promise.resolve(undefined);
	const idb = IDBService.sendMessage("create", "favorite", item as Item);
	try {
		serverWrite(addFavorite(item));
	} catch {
		/* offline / not logged in: IDB copy only */
	}
	return idb;
}

/** Remove `item` from favourites: IndexedDB (awaitable) + server (fire-and-forget). */
export function removeFavourite(item: FavouriteInput): IDBResult | Promise<undefined> {
	if (!browser || !item) return Promise.resolve(undefined);
	const idb = IDBService.sendMessage("delete", "favorite", item as Item);
	try {
		serverWrite(removeFavoriteItem(item));
	} catch {
		/* offline / not logged in: IDB copy only */
	}
	return idb;
}

/** Convenience: `isSaved` true removes, false adds. */
export function toggleFavourite(item: FavouriteInput, isSaved: boolean) {
	return isSaved ? removeFavourite(item) : saveFavourite(item);
}
