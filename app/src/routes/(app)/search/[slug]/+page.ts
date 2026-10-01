import type { NextContinuationData } from "$lib/types";
import type { SearchFilter } from "$lib/types/api/search";
import type { MusicShelf } from "$lib/types/musicShelf";
import type { PageLoad } from "./$types";
import {APIClient} from "$lib/api";

export interface SearchResponse {
	results?: MusicShelf[];
	continuation?: NextContinuationData;
	filter: SearchFilter;
	type?: "next" | undefined;
	correction?: {
		showingResultsFor: string;
		correctedQuery: string;
		searchInsteadFor: string;
		originalQuery: string;
	} | null;
}

// Surface YouTube Music's spell-correction ("Showing results for … / search
// instead for …"). The renderer is buried deep in the raw response; walk it
// defensively and normalize to a flat object (or null if there is no correction).
function runsText(x: any): string {
	return ((x && x.runs) || []).map((r: any) => r && r.text).filter(Boolean).join("");
}
function extractSearchCorrection(data: any) {
	try {
		const tabs = (((((data || {}).response || {}).contents || {}).tabbedSearchResultsRenderer || {}).tabs) || [];
		for (const t of tabs) {
			const sections = (((((t || {}).tabRenderer || {}).content || {}).sectionListRenderer || {}).contents) || [];
			for (const s of sections) {
				const items = (((s || {}).itemSectionRenderer || {}).contents) || [];
				for (const it of items) {
					const r = (it || {}).showingResultsForRenderer;
					if (!r) continue;
					const correctedQuery = runsText(r.correctedQuery);
					const showingResultsFor = runsText(r.showingResultsFor);
					if (!correctedQuery && !showingResultsFor) continue;
					const oqe = (r.originalQueryEndpoint || {}).searchEndpoint || {};
					const originalQuery = oqe.query || runsText(r.originalQuery);
					return {
						showingResultsFor,
						correctedQuery,
						searchInsteadFor: runsText(r.searchInsteadFor),
						originalQuery,
					};
				}
			}
		}
	} catch {
		/* ignore malformed responses */
	}
	return null;
}
export const load: PageLoad = async ({
	url,
	params,
	fetch,
}): Promise<SearchResponse> => {
	const slug = params.slug;
	const filter = url.searchParams.get("filter") || "";
	const restricted = url.searchParams.get("restricted") || "";

	const apiUrl = `/api/v1/search.json?q=${slug}${
		filter !== "" ? `&filter=${encodeURIComponent(filter)}` : ""
	}${restricted ? `&restricted=${restricted}` : ""}`;
	const response = await APIClient.fetch(apiUrl);
	const data = (await response.json()) as SearchResponse;
	// PF3-3: search.json no longer echoes the raw YouTube "response"; the
	// server sends the parsed correction (the walk stays as a fallback for an
	// older backend still sending "response").
	Object.assign(data, { filter, correction: data.correction ?? extractSearchCorrection(data) });
	// if (response.ok) {
	return data;
	// }
};
