import { redirect } from "@sveltejs/kit";
import { APIClient } from "$lib/api";

/** Structured error of /api/v1/player.json ({error, status, reason}). */
export type ShareError = { kind: string; reason: string };

export const load = async ({ url }) => {
	const id =
		url.searchParams.get("id") ??
		url.searchParams.get("v") ??
		url.searchParams.get("videoId");
	const playlist = url.searchParams.get("list") || undefined;

	if (!id) {
		throw redirect(301, "/trending");
	}

	const qs = `videoId=${id}${playlist ? `&playlistId=${playlist}` : ""}`;
	const [playerRes, list] = await Promise.all([
		APIClient.fetch(`/api/v1/player.json?${qs}`),
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
		related: list,
		data,
		error,
	};
};
