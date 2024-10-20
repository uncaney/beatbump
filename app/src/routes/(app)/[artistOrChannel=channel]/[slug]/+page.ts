/* eslint-disable @typescript-eslint/no-explicit-any */
import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import {SERVER_DOMAIN} from "../../../../env";

export const load: PageServerLoad = async ({ params }) => {
/*	const response = await buildAPIRequest("artist", {
		context: {
			client: { clientName: "WEB_REMIX", clientVersion: "1.20230501.01.00" },
		},
		headers: null,
		params: {
			browseId: params.slug,
			browseEndpointContextMusicConfig: {
				browseEndpointContextMusicConfig: {
					pageType: "MUSIC_PAGE_TYPE_ARTIST",
				},
			},
		},
	});*/
    const response = await fetch(
        `${SERVER_DOMAIN}/api/v1/artist/`+ params?.slug,
    );
	if (!response) throw error(500, "Failed to fetch");
	const data = await response.json();
	if (!response.ok) throw error(500, response.statusText);
	const page = parseResponse(data);

	return Object.assign(page);
};
function parseResponse(data: {
	header: any;
	contents: {
		singleColumnBrowseResultsRenderer: {
			tabs: {
				tabRenderer: { content: { sectionListRenderer: { contents: any } } };
			}[];
		};
	};
	responseContext: { visitorData: string };
}) {
	/*const header = data?.header;
	const contents =
		data?.contents?.singleColumnBrowseResultsRenderer?.tabs[0]?.tabRenderer
			?.content?.sectionListRenderer?.contents;*/
	const visitorData = data?.visitorData ?? "";
    return {
        header: data?.header,
        body: {
            carousels: data?.carousels,
            songs: data?.songs,
        },
        visitorData,
    };
	/*return ArtistPageParser({
		header,
		items: contents,
		visitorData: visitorData ?? "",
	});*/
}
