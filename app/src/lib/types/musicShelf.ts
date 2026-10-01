import type { IListItemRenderer } from "./musicListItemRenderer";

export interface MusicShelf {
	header?: {
		title: string;
	};
	contents: IListItemRenderer[];
	/** true for the owned-library ("Your Library") shelf appended by the backend search endpoint */
	local?: boolean;
}
