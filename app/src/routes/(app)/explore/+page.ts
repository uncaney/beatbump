import { error } from "@sveltejs/kit";
import {APIClient} from "$lib/api";
export const prerender = false;
export const load = async ({ fetch, url }) => {
	const data = await APIClient.fetch(`/api/v1/explore`);
	const response = await data.json();

	if (!data.ok) {
		throw error(500, data.statusText);
	}
	return {
		response,
		path: url.pathname,
	};
};
