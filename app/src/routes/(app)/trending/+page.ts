import type { MoodsAndGenresItem } from "$lib/types";
import { error } from "@sveltejs/kit";
import type { ParsedCarousel } from "../api/_lib/models/Carousel";
import {APIClient} from "$lib/api";

export const load = async ({ fetch }) => {

    const response = await APIClient.fetch(`/api/v1/trending`).then((res) => {
		if (!res.ok) {
			throw error(res.status, res.statusText);
		}
		return res.json();
	});
	return response;
};
