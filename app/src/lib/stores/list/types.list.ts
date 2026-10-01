import type { Item } from "$lib/types";
import type { Nullable } from "$lib/types/utilities";
import type { ResponseBody } from "$lib/utils/utils";
import type { Writable } from "svelte/store";
import type { PlaybackContext, PlaybackContextInput } from "./playbackContext";

export interface ISessionListProvider {
	clickTrackingParams: Nullable<string>;
	continuation: string;
	currentMixId: string;
	currentMixType: "playlist" | "auto" | "local" | null;
	mix: Array<Item>;
	position: number;
	related?: {
		browseId: string;
		browseEndpointContextSupportedConfigs: {
			browseEndpointContextMusicConfig: {
				pageType: "MUSIC_PAGE_TYPE_TRACK_RELATED";
			};
		};
	} | null;
	visitorData: null | string;
	/** Source of the queue (P2), null for a plain queue. */
	context?: PlaybackContext | null;
}

export interface ISessionListService {
	/** Getter for clickTrackingParams */
	clickTrackingParams: string;
	/** Getter for continuation */
	continuation: string;
	/** Getter for currentMixId */
	currentMixId: string;
	/** Getter for mix */
	mix: Array<Item>;
	/** Getter for queue position */
	position: number;
	set: Writable<ISessionListProvider>["set"];
	subscribe: Writable<ISessionListProvider>["subscribe"];

	/**
	 * Fetches a set of similar songs and appends them to the current
	 * automix session
	 */
	getMoreLikeThis(args?: { playlistId?: Nullable<string> }): Promise<void>;
	/** Continues current automix session by fetching the next batch of songs */
	getSessionContinuation(args: {
		itct: string;
		videoId: string;
		playlistId: string;
		ctoken: string;
		clickTrackingParams: string;
		loggingContext?: { vssLoggingContext: { serializedContextData: string } };
		key: number;
	}): Promise<ResponseBody>;
	/** Initialize a new automix session */
	initAutoMixSession(args: {
		videoId?: string;
		playlistId?: string;
		keyId?: number;
		playlistSetVideoId?: string;
		loggingContext?: Nullable<{
			vssLoggingContext?: { serializedContextData: string };
		}>;
		clickTracking?: string;
		config?: { playerParams?: string; type?: string };
	}): Promise<void>;
	/** Initializes a new playlist session */
	initPlaylistSession(args: {
		playlistId: string;
		index: number;
		clickTrackingParams?: string;
		params?: string | undefined;
		videoId?: string;
		visitorData?: string;
		playlistSetVideoId?: string;
	}): Promise<{
		body: ResponseBody;
		error?: boolean | undefined;
	} | null>;
	lockedSet(_mix: ISessionListProvider): Promise<ISessionListProvider>;
	removeTrack(index: number): void;
	/** Drag reorder: same rows in a new order, cursor kept on the playing track */
	reorder(mix: Item[]): boolean;
	/** "Vider la file": keep only the current track */
	clearQueue(): Promise<boolean>;
	setMix(
		mix: Item[],
		type?: "auto" | "playlist" | "local",
		context?: PlaybackContextInput | PlaybackContext | null,
	): void;
	/** Inserts the item (or the tracks it expands to) at key + 1; true when inserted */
	setTrackWillPlayNext(item: Item, key: number): Promise<boolean>;
	/** "Lire ensuite": right after the current track */
	playNext(item: Item): Promise<boolean>;
	/** "Ajouter à la file": at the end of the queue */
	addToQueueEnd(item: Item): Promise<boolean>;
	/** Queue row "Lire ensuite": move the row right after the current track */
	moveTrackNext(index: number): Promise<boolean>;
	shuffle(index: number, preserveBeforeActive?: boolean): void;
	shuffleRandom(items: Array<Item>): void;
	toJSON(): string;
	updatePosition(direction: "next" | "back" | number): Promise<number>;
}
