import { error } from "@sveltejs/kit";
import { APIClient } from "$lib/api";

export const load = async ({ url, params }) => {
	const res = await APIClient.fetch(`/api/v1/explore/${params.slug}`);
	const path = url.pathname;
	// Unknown category: the API answers 404 JSON (audit v3 F22/G19) and the
	// page shows "Catégorie introuvable" with a link back to Explorer.
	if (res.status === 404) {
		return { response: null as any, notFound: true, path };
	}
	if (!res.ok) {
		// "fr:" marks our own message so +error.svelte shows it (audit v4 H10).
		throw error(502, "fr:Explorer est indisponible pour le moment.");
	}
	const response: any = await res.json();
	return { response, notFound: false, path };
};
