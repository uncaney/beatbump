import { redirect } from "@sveltejs/kit";
import { APIClient, PREFETCH_INIT } from "$lib/api";
import { listenStartTime } from "$lib/shareTarget";

/** Structured error of /api/v1/player.json ({error, status, reason}). */
export type ShareError = { kind: string; reason: string };

export const load = async ({ url }) => {
	const id =
		url.searchParams.get("id") ??
		url.searchParams.get("v") ??
		url.searchParams.get("videoId");
	const playlist = url.searchParams.get("list") || undefined;
	// L10-2: `t` of a shared link (share target: /listen?id=<id>&t=<s>).
	const startAt = listenStartTime(url.searchParams);

	if (!id) {
		throw redirect(301, "/trending");
	}

	const qs = `videoId=${id}${playlist ? `&playlistId=${playlist}` : ""}`;
	// Opening a shared link is a preview, not a play: the acquisition happens
	// when the user presses "Start Listening" (getSrc without the header) (F12).
	const [playerRes, list] = await Promise.all([
		APIClient.fetch(`/api/v1/player.json?${qs}`, PREFETCH_INIT),
		APIClient.fetch(`/api/v1/next.json?${qs}`)
			.then((res) => res.json())
			.catch(() => null),
	]);
	const data = await playerRes.json().catch(() => null);

	// Unplayable / unknown track: player.json answers the structured error
	// contract (404 {error:"unplayable", reason}) with no videoDetails. Surface
	// it as data so the page renders a message instead of crashing on the
	// missing thumbnails (F13).
	let error: ShareError | undefined;
	if (!playerRes.ok || !data || typeof data.error === "string" || !data.videoDetails) {
		error = {
			kind: (data && typeof data.error === "string" && data.error) || "unplayable",
			reason: String((data && (data.reason || data.playabilityStatus?.reason)) || ""),
		};
	}

	const {
		videoDetails: {
			title = "",
			videoId = "",
			thumbnail: { thumbnails = [] } = {},
		} = {},
	} = data || {};

	return {
		title,
		thumbnails,
		videoId: videoId || id,
		playlist,
		startAt,
		related: list,
		data,
		error,
	};
};
