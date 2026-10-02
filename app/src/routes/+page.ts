import { redirect } from "@sveltejs/kit";

// B7-12: "/" carries its query to /home so an icon shortcut or a shared link
// such as /?album-of-day=1 or /?resume=1 keeps its one-shot action.
export function load({ url }: { url: URL }) {
	throw redirect(301, "/home" + url.search);
}
