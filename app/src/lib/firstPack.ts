// c48c B8-2 "Emporte 1 h de musique": a first-visit card on the home for a
// profile WITHOUT history (no play recorded: the same rule as _FirstRun),
// shown once the service worker is active. One tap prepares a 1 h trip pack
// drawn from the album of the day, the artist of the day and a decade mix
// (a blank profile has no favourites / recent plays, the sources of the
// Espace card's pack), run as THE pack job of the Hors-ligne page (same key,
// same "Annuler", same progress). Pure helpers, unit-tested; the card itself
// is routes/(app)/home/_FirstPackCard.svelte.
import { ALBUM_OF_DAY_URL, albumOfDayFrom } from "./albumOfDay";
import { ARTIST_OF_DAY_URL, artistOfDayFrom, artistOfDaySongsUrl } from "./artistOfDay";
import { mixCardsFrom, mixCardUrl } from "./mixes";
import { PACK_DATA_SAVER_CAP, cutPackToBytes, packDurationLabel, planPack, type PackCandidates, type PackPlan } from "./offlinePack";
import { formatBytesFr } from "./utils/formatFr";

/** localStorage memo: "1" once the card was dismissed or its pack launched (never shown again). */
export const FIRST_PACK_KEY = "ytm-first-pack-card";
/** Listening time of the pack (1 h: the Espace card's "dur:3600" choice). */
export const FIRST_PACK_SECONDS = 3600;
/** The Espace card's pack job (its PACK_KEY): it shows, cancels and remembers this pack like its own. */
export const FIRST_PACK_JOB_KEY = "pack:offline";
/** Where the tap lands: the Hors-ligne page, whose Espace card unfolds on a running pack. */
export const FIRST_PACK_HREF = "/library/downloads-offline";
/** GET local/mixes: the first card of this kind feeds the third source of the pack. */
export const FIRST_PACK_MIX_KIND = "decade";
export const LOCAL_MIXES_URL = "/api/v1/local/mixes";

export type FirstPackState = {
	/** The stored memo (localStorage FIRST_PACK_KEY), null when absent or unreadable. */
	stored: string | null | undefined;
	/** Plays recorded for the profile (me/stats/recent); 0 = no history; null = unknown (the call failed: L14-5, never assumed empty). */
	recentCount: number | null;
	/** The service worker is active (the pack needs its cache-audio). */
	swActive: boolean;
	/**
	 * U13-4: a sound was heard this session (AudioPlayer.paused went
	 * true -> false once: `heardFirstSound` of InstallHint/gate). Undefined
	 * reads as "not yet": the card never shares the first screen with the
	 * Bienvenue block, it comes once Bienvenue has stepped aside.
	 */
	heardSound?: boolean;
};

/**
 * The card shows for a profile without history (no play recorded), once the
 * service worker is active, after the first sound of the session (U13-4: the
 * day-one first screen used to stack five calls to action), and never again
 * once dismissed or used (memo "1"). An unknown history (me/stats/recent
 * failed) hides it: a profile with plays on another device must not be
 * offered a day-one pack.
 */
export function shouldShowFirstPackCard(s: FirstPackState): boolean {
	if (s.stored === "1") return false;
	if (!s.swActive) return false;
	if (s.heardSound !== true) return false;
	if (s.recentCount === null) return false;
	return !(Number.isFinite(s.recentCount) && s.recentCount > 0);
}

export type FirstPackSources = {
	/** The album of the day's tracks (taken first). */
	album: any[];
	/** The artist of the day's titles (then). */
	artist: any[];
	/** A decade mix of the library (last). */
	mix: any[];
};

type GetJson = (url: string) => Promise<unknown>;

function itemsOf(resp: unknown): any[] {
	const items = (resp as { items?: unknown } | null | undefined)?.items;
	return Array.isArray(items) ? items : [];
}

/**
 * The three day-one sources, each best-effort (a failed call reads as an
 * empty list): album of the day (its `tracks`), artist of the day (local
 * songs of the artist), the first decade card of local/mixes.
 */
export async function firstPackSources(getJson: GetJson): Promise<FirstPackSources> {
	const safe = async (url: string): Promise<unknown> => {
		try {
			return await getJson(url);
		} catch {
			return null;
		}
	};
	const [albumResp, artistResp, mixesResp] = await Promise.all([safe(ALBUM_OF_DAY_URL), safe(ARTIST_OF_DAY_URL), safe(LOCAL_MIXES_URL)]);
	const album = albumOfDayFrom(albumResp);
	const artist = artistOfDayFrom(artistResp);
	const card = mixCardsFrom(mixesResp).find((c) => c.kind === FIRST_PACK_MIX_KIND) ?? mixCardsFrom(mixesResp)[0];
	const [artistItems, mixItems] = await Promise.all([
		artist ? safe(artistOfDaySongsUrl(artist)).then(itemsOf) : Promise.resolve([] as any[]),
		card ? safe(mixCardUrl(card)).then(itemsOf) : Promise.resolve([] as any[]),
	]);
	return { album: album ? album.tracks : [], artist: artistItems, mix: mixItems };
}

/** The pack plan: album first, then the artist, then the mix, up to FIRST_PACK_SECONDS of listening (duration mode of planPack). */
export function planFirstPack(src: FirstPackSources, cached?: PackCandidates["cached"], sizes?: PackCandidates["sizes"], seconds = FIRST_PACK_SECONDS): PackPlan {
	return planPack({ favorites: src.album, recent: src.artist, mix: src.mix, cached, sizes }, seconds, "seconds");
}

/** True when at least one source has a track to take. */
export function hasFirstPackMaterial(src: FirstPackSources): boolean {
	const isTrack = (x: any) => !!x && typeof x.videoId === "string" && x.videoId !== "";
	return src.album.some(isTrack) || src.artist.some(isTrack) || src.mix.some(isTrack);
}

/** U13-2: what the card announces before the tap. */
export type FirstPackEstimate = {
	/** Estimated bytes of the pack (known sizes, else length x the cache's average bitrate). */
	bytes: number;
	/** Economie de donnees is on (the switch in Reglages, the OS switch or a 2g link). */
	dataSaver: boolean;
	/** The plan was cut to PACK_DATA_SAVER_CAP (data saver only). */
	capped: boolean;
	count: number;
	seconds: number;
};

/**
 * U13-2: size the plan before anything downloads. The library keeps lossless
 * files, so "1 h" can mean 1,1 Go on a phone's data plan: the estimate uses
 * the cache's measured bitrate (averageBytesPerSecond). Under data saver the
 * plan is cut to PACK_DATA_SAVER_CAP (first fit, same order). The copies are
 * the library's own (local/duplicates groups albums, not tracks, so no
 * compressed copy is swapped in), hence "qualité d'origine" in the text.
 */
export function sizeFirstPack(plan: PackPlan, bps: number, dataSaver: boolean): { plan: PackPlan; estimate: FirstPackEstimate } {
	const cut = cutPackToBytes(plan, dataSaver ? PACK_DATA_SAVER_CAP : Infinity, bps);
	return { plan: cut.plan, estimate: { bytes: cut.estimated, dataSaver, capped: cut.cut, count: cut.plan.count, seconds: cut.plan.seconds } };
}

/**
 * The size line of the card: "Environ 1,1 Go à télécharger (qualité
 * d'origine)."; under data saver the cap is named with what it holds
 * ("pack limité à 300 Mo, soit 25 min"). "" without a plan.
 */
export function firstPackSizeText(e: FirstPackEstimate | null | undefined): string {
	if (!e || !(e.count > 0) || !(e.bytes > 0)) return "";
	const size = formatBytesFr(e.bytes);
	if (e.capped) return `Économie de données : pack limité à ${formatBytesFr(PACK_DATA_SAVER_CAP)}, soit ${packDurationLabel(e.seconds)} (qualité d'origine, env. ${size}).`;
	if (e.dataSaver) return `Environ ${size} à télécharger (qualité d'origine), économie de données active.`;
	return `Environ ${size} à télécharger (qualité d'origine).`;
}
