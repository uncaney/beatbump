import type { ExploreSlugResponse } from "../[slug].json/+server.js";
import {APIClient} from "$lib/api";

export const load = async ({ url, params, fetch }) => {
	const response = await APIClient.fetch<Awaited<ExploreSlugResponse>>(
        `/api/v1/explore/${params.slug}`,
	).then((response) => response.json());

	const path = url.pathname;
	// console.log(routeId, params, path, sections, header, type);
	return {
		response,
		path,
	} as const;
};
