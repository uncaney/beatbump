import list from "$lib/stores/list/sessionList";
import { groupSession } from "$lib/stores/sessions";
import type { Item } from "$lib/types";
import { notify } from "$lib/utils";

/**
 * Row-menu queue actions shared by every track row (ListItem, Listing,
 * CarouselItem): one implementation, French toasts. In a group session the
 * insertion goes through `groupSession.addToQueue` so guests receive the mix.
 */

const label = (item: Item): string =>
	item?.title ? `« ${item.title} »` : "Le morceau";

/** "Lire ensuite": right after the current track (first track when the queue is empty). */
export async function playNext(item: Item): Promise<void> {
	if (!item) return;
	if (groupSession.hasActiveSession) {
		await groupSession.addToQueue(item, list.position);
		notify(`${label(item)} sera lu ensuite`, "success");
		return;
	}
	if (await list.playNext(item)) notify(`${label(item)} sera lu ensuite`, "success");
}

/** "Ajouter à la file": at the end of the queue (first track when the queue is empty). */
export async function addToQueueEnd(item: Item): Promise<void> {
	if (!item) return;
	if (groupSession.hasActiveSession) {
		await groupSession.addToQueue(item, Math.max(list.$.value.mix.length - 1, 0));
		notify(`${label(item)} ajouté à la file d'attente`, "success");
		return;
	}
	if (await list.addToQueueEnd(item)) notify(`${label(item)} ajouté à la file d'attente`, "success");
}
