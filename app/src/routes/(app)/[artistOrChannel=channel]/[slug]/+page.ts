/* eslint-disable @typescript-eslint/no-explicit-any */
import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import {APIClient} from "$lib/api";

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
    const response = await APIClient.fetch(
        `/api/v1/artist/`+ params?.slug,
    );
	// "fr:" marks our own French message for +error.svelte (audit v4 H10).
	if (!response) throw error(502, "fr:Impossible de charger cet artiste.");
	// Audit UX v4 (regression 1): an unknown artist is a 404, not an "Internal Error";
	// the upstream statusText never reaches the page. Only a real 404 (unknown id or
	// empty upstream answer) is "introuvable"; an upstream 400/5xx comes back as a
	// 502 from the API and stays a retryable error (audit v4 H9).
	if (response.status === 404) throw error(404, "fr:Artiste introuvable");
	if (!response.ok) throw error(502, "fr:Impossible de charger cet artiste.");
	const data = await response.json();
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
            // B8-20 (c48b): the other credits of a local artist's group, for the "Aussi sous" chips.
            aliases: (data as { aliases?: unknown } | undefined)?.aliases ?? null,
        },
        visitorData,
    };
	/*return ArtistPageParser({
		header,
		items: contents,
		visitorData: visitorData ?? "",
	});*/
}
