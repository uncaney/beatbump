import { redirect } from "@sveltejs/kit";

// The app links albums as /release?id=<id>. Support the path form /release/<id>
// (bookmarks/shares) by redirecting to the canonical query form instead of dead-ending.
export const load = ({ params, url }) => {
	const type = url.searchParams.get("type");
	throw redirect(307, `/release?id=${params.id}${type ? `&type=${type}` : ""}`);
};
