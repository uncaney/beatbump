import { error } from "@sveltejs/kit";
import {APIClient} from "$lib/api";
export const prerender = false;
export const load = async ({ fetch, url }) => {
	const data = await APIClient.fetch(`/api/v1/explore`);
	// Never surface the upstream statusText; "fr:" marks our own message for
	// +error.svelte (audit v4 H10). Check the status before parsing the body.
	if (!data?.ok) {
		throw error(502, "fr:Explorer est indisponible pour le moment.");
	}
	const response = await data.json();
	return {
		response,
		path: url.pathname,
	};
};
