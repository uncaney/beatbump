import type { PageLoad } from "../../../../../.svelte-kit/types/src/routes";
import {APIClient} from "$lib/api";
export const load: PageLoad = async ({ params, fetch, url }) => {
	// const params = url.searchParams.get('params')
	const response = await APIClient.fetch(
        `/api/v1/trending/${params.slug}` +
			`${
				url.searchParams.get("params")
					? `?params=${url.searchParams.get("params")}`
					: ""
			}` +
			`${
				url.searchParams.get("itct")
					? `&itct=${encodeURIComponent(url.searchParams.get("itct"))}`
					: ""
			}`,
	);
	const data = await response.json();
	// console.log(sections, header, title)
	if (response.ok) {
		return data;
	}
};
