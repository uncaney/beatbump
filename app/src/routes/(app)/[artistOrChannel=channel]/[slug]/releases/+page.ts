import type { CarouselItem } from "$lib/types";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import {SERVER_DOMAIN} from "../../../../../env";
export const load: PageLoad = (async ({
	fetch,
	url,
	params,
}): Promise<{
	header: { artist?: string; type?: string };
	contents?: CarouselItem[];
    songs?:CarouselItem[];
}> => {
	// let browseId = url.searchParams.get("browseId");
	const qparams = url.searchParams.get("params");
	const itct = url.searchParams.get("itct");
	const visitorData = url.searchParams.get("visitorData");
	const response = await fetch(
        `${SERVER_DOMAIN}/api/v1/artist/${
			params.slug
		}?visitorData=${visitorData}&params=${qparams}&itct=${encodeURIComponent(
			itct,
		)}`,
	);
	if (!response.ok) {
		throw error(500, response.statusText);
	}
	const data = await response.json();
	const { header, contents, songs } = data;
	return {
		header: header,
		contents: contents,
        songs: songs,
	};
}) satisfies PageLoad;
