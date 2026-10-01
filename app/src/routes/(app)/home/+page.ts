import { APIClient } from "$lib/api";
import { retryOnce } from "$lib/utils/retryOnce";
export const prerender = false;

// PF3-2: home.json (YouTube rows, up to ~1 s on a cache MISS) must not block
// the page: the personal rows (local, 10-45 ms) mount at once and the YouTube
// carousels fill in when this promise settles. SvelteKit 1 awaits top-level
// promises only, so the fetch is nested under `streamed`.
export const load = ({ url, depends }) => {
	depends("home:load");
	const params = url.searchParams.get("params");

	// L10-9: one retry after 2 s; the SW offline placeholder ({"offline":true},
	// 200) counts as a failure so the page shows its retry instead of nothing.
	const home: Promise<any> = retryOnce(() =>
		APIClient.fetch(`/api/v1/home.json${params ? `?params=${params}` : ""}`)
			.then((r) => {
				if (!r.ok) throw new Error(`home.json ${r.status}`);
				return r.json();
			})
			.then((d) => {
				if (d && d.offline === true) throw new Error("home.json offline");
				return d;
			}),
	);
	// The page handles the rejection; keep it from surfacing as unhandled.
	home.catch(() => {});

	return { params, path: url.pathname, streamed: { home } };
};
