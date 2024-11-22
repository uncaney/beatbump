
   import {APIClient} from "$lib/api";
export const prerender = false;
export const load = async ({ fetch, url, depends }) => {
	depends("home:load");
	const params = url.searchParams.get("params");

	const data = await APIClient.fetch(
        `/api/v1/home.json${params ? `?params=${params}` : ""}`,
	).then((r) => r.json());

	return { ...data, params, path: url.pathname };
};
