/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CarouselHeader, Thumbnail } from "$lib/types";
import type { ICarouselTwoRowItem } from "$lib/types/musicCarouselTwoRowItem";
import type { IListItemRenderer } from "$lib/types/musicListItemRenderer";

export interface IArtistPageHeader {
	name: string;
	thumbnails: Thumbnail[];
	buttons: {
		shuffle?: { params?: string; playlistId?: string; videoId?: string };
		radio?: {
			params?: string;
			playlistId?: string;
		} | null;
	};
	mixInfo?: {
		params?: string;
		playlistId?: string;
	};
	description?: string;
	foregroundThumbnails?: Thumbnail[];
}

export interface ArtistPageBody {
	carousels?: { header: CarouselHeader; contents: ICarouselTwoRowItem[] }[];
	songs?: {
		header?: CarouselHeader;
		items?: IListItemRenderer[];
	};
}
export interface ArtistPage {
	header?: IArtistPageHeader;
	body?: ArtistPageBody;
	visitorData?: string;
}


