/**
 * Playback context (P2): where the queue came from ("Album : Discovery",
 * "Favoris", "Pour toi", ...), kept on the session list next to the mix and
 * persisted with the resume state (C1). Pure helpers, no store / DOM import.
 */

export type PlaybackContextKind =
	| "album"
	| "mixtape"
	| "favorites"
	| "foryou"
	| "playlist"
	| "offline"
	| "artist"
	| "queue"
	// c28c D4: library genre radio (/library/genres).
	| "genre"
	// c28c EQ1: targeted radio (favorites/album/artist seed, local/related?seed=).
	| "radio"
	// c29b D1: decade mix (/library/mixes, local/mix?decade=).
	| "decade";

export interface PlaybackContextInput {
	kind: PlaybackContextKind;
	title: string;
	href: string;
}

export interface PlaybackContext extends PlaybackContextInput {
	/** videoIds of the source list, in order (the "4/14" counter and "Revenir à l'album"). */
	ids: string[];
}

export const CONTEXT_MAX_IDS = 500;

const KIND_LABEL: Record<PlaybackContextKind, string> = {
	album: "Album",
	mixtape: "Mixtape",
	favorites: "Favoris",
	foryou: "Pour toi",
	playlist: "Playlist",
	offline: "Hors-ligne",
	artist: "Artiste",
	queue: "File",
	genre: "Genre",
	radio: "Radio",
	decade: "Décennie",
};

const RETURN_LABEL: Partial<Record<PlaybackContextKind, string>> = {
	album: "Revenir à l'album",
	mixtape: "Revenir à la mixtape",
	favorites: "Revenir aux favoris",
	artist: "Revenir à l'artiste",
};

export function contextKindLabel(kind: PlaybackContextKind): string {
	return KIND_LABEL[kind] ?? "File";
}

/** Build the stored context for `mix` (ids capped to CONTEXT_MAX_IDS). */
export function makeContext(
	input: PlaybackContextInput | null | undefined,
	mix: ReadonlyArray<{ videoId?: string } | undefined>,
): PlaybackContext | null {
	if (!input || !(input.kind in KIND_LABEL)) return null;
	const ids = (Array.isArray(mix) ? mix : [])
		.slice(0, CONTEXT_MAX_IDS)
		.map((t) => (t && typeof t.videoId === "string" ? t.videoId : ""));
	return {
		kind: input.kind,
		title: typeof input.title === "string" ? input.title : "",
		href: typeof input.href === "string" ? input.href : "",
		ids,
	};
}

/** Validate an untrusted (persisted) context; null when unusable. */
export function normalizeContext(raw: unknown): PlaybackContext | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.kind !== "string" || !(r.kind in KIND_LABEL)) return null;
	const href = typeof r.href === "string" && r.href.startsWith("/") ? r.href : "";
	const ids = Array.isArray(r.ids)
		? r.ids.slice(0, CONTEXT_MAX_IDS).map((x) => (typeof x === "string" ? x : ""))
		: [];
	return {
		kind: r.kind as PlaybackContextKind,
		title: typeof r.title === "string" ? r.title.slice(0, 200) : "",
		href,
		ids,
	};
}

export interface ContextView {
	/** "Album : Discovery · 4/14" */
	label: string;
	/** Link to the source ("" = no link). */
	href: string;
	/** 1-based index in the source, 0 when the playing track is not part of it. */
	index: number;
	total: number;
	/** A track outside the context ("Lire ensuite") is playing. */
	interrupted: boolean;
	/** Queue index of the next context track after the cursor (-1 = none). */
	returnIndex: number;
	/** "Revenir à l'album" ("" when no return is possible). */
	returnLabel: string;
}

/**
 * What the player shows for the queue. Without a context, a queue of 2+
 * rows reads "File · 3/20" (no link).
 */
export function describeContext(
	ctx: PlaybackContext | null | undefined,
	mix: ReadonlyArray<{ videoId?: string } | undefined>,
	position: number,
): ContextView | null {
	const list = Array.isArray(mix) ? mix : [];
	if (!list.length) return null;
	const pos = Math.min(Math.max(0, position | 0), list.length - 1);
	if (!ctx) {
		if (list.length < 2) return null;
		return {
			label: `File · ${pos + 1}/${list.length}`,
			href: "",
			index: pos + 1,
			total: list.length,
			interrupted: false,
			returnIndex: -1,
			returnLabel: "",
		};
	}
	const kindLabel = contextKindLabel(ctx.kind);
	const head =
		ctx.title && ctx.title !== kindLabel ? `${kindLabel} : ${ctx.title}` : kindLabel;
	const ids = ctx.ids ?? [];
	const set = new Set(ids.filter(Boolean));
	const currentId = list[pos]?.videoId ?? "";
	const i = currentId ? ids.indexOf(currentId) : -1;
	const interrupted = i < 0;
	let returnIndex = -1;
	if (interrupted) {
		for (let j = pos + 1; j < list.length; j++) {
			const id = list[j]?.videoId;
			if (id && set.has(id)) {
				returnIndex = j;
				break;
			}
		}
	}
	return {
		label: interrupted || !ids.length ? head : `${head} · ${i + 1}/${ids.length}`,
		href: ctx.href,
		index: interrupted ? 0 : i + 1,
		total: ids.length,
		interrupted,
		returnIndex,
		returnLabel:
			returnIndex >= 0 ? RETURN_LABEL[ctx.kind] ?? "Revenir à la liste" : "",
	};
}

/**
 * I8: the queue was extended past its source (C4 "Suite : dans ta
 * bibliothèque"). The appended rows belong to no album / playlist, so the
 * context becomes the queue itself ("File : Suite · 15/24", ids = the whole
 * queue): the counter and total stay right instead of showing only the
 * stale "Album : Discovery" header. No context stays no context.
 */
export function continuedContext(
	ctx: PlaybackContext | null | undefined,
	mix: ReadonlyArray<{ videoId?: string } | undefined>,
): PlaybackContext | null {
	if (!ctx) return null;
	return makeContext({ kind: "queue", title: "Suite", href: "" }, mix);
}

/**
 * I8: the context of a "Lire tout" / "Aléatoire" started on `pathname`
 * (`title` = the page heading, e.g. the playlist or artist name). null when
 * the page has no known source (the player then shows "File · n/N").
 */
export function playAllContextFor(pathname: string | null | undefined, title?: string | null): PlaybackContextInput | null {
	const path = typeof pathname === "string" ? pathname : "";
	const name = typeof title === "string" ? title.trim().slice(0, 200) : "";
	if (/^\/library\/saved\/?$/.test(path) || /^\/favorites\/?$/.test(path)) {
		return { kind: "favorites", title: "Favoris", href: path };
	}
	if (/^\/library\/playlists(-srv)?\/[^/]+\/?$/.test(path)) return { kind: "playlist", title: name, href: path };
	if (/^\/(artist|channel)\/[^/]+\/?$/.test(path)) return { kind: "artist", title: name, href: path };
	return null;
}
