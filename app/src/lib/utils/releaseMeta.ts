// Album / single header line: "Album · 13 titres · 2013 · 1 h 14 min".
// Pure functions (no DOM, no Svelte), unit-tested in releaseMeta.test.ts.
//
// Two producers feed `subtitles[0]`:
//  - backend/api/local_pages.go: { year: "2023", tracks: "1 songs",
//    length: "4 min", durationSec: 243 } (numbers are seconds).
//  - backend/api/album.go reads the YouTube MusicResponsiveHeaderRenderer runs
//    by index. YouTube's current header puts the year in `subtitle`
//    ("Album • 2013") and the length in `secondSubtitle`
//    ("13 songs • 1 hour, 14 minutes"), so the page receives
//    { year: "1 hour, 14 minutes", tracks: "13 songs", length: "2013" }.
//    Audit v7 TOP 4: "2013" read as seconds showed "34 min" and the year
//    was lost. The parser below takes the fields by SHAPE, not by name: a
//    bare 1900-2099 number is a year wherever it sits, a label with
//    hours / minutes / seconds (en or fr) or a hh:mm:ss is a duration.

export type ReleaseSubtitle = Record<string, unknown>;

const TYPE_LABELS: Record<string, string> = {
	album: "Album",
	single: "Single",
	ep: "EP",
	playlist: "Playlist",
};

const YEAR_RE = /^(19|20)\d{2}$/;
const HOURS_RE = /(\d+)\s*(?:hours?|hrs?|h)\b/;
const MINUTES_RE = /(\d+)\s*(?:minutes?|mins?|min|m)\b/;
const SECONDS_RE = /(\d+)\s*(?:seconds?|secs?|sec|s)\b/;

/** True for a bare four-digit year ("2013"), false for "2013 seconds" or "1 hour". */
export function isYearToken(raw: unknown): boolean {
	return YEAR_RE.test(String(raw ?? "").trim());
}

/**
 * Seconds from a number, a "hh:mm:ss" / "mm:ss" string, or a YouTube label
 * ("1 hour, 14 minutes", "74 minutes", "1 hr 14 min", "1 h 14 min",
 * "45 seconds"). 0 when nothing usable; a bare year is never a duration.
 */
export function durationSeconds(raw: unknown): number {
	if (typeof raw === "number") {
		return Number.isFinite(raw) && raw > 0 ? raw : 0;
	}
	const str = String(raw ?? "").trim().toLowerCase();
	if (!str) return 0;
	if (/^\d+(:\d{1,2}){1,2}$/.test(str)) {
		return str.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
	}
	const unit = (re: RegExp) => {
		const m = str.match(re);
		return m ? Number(m[1]) : 0;
	};
	const total =
		unit(HOURS_RE) * 3600 + unit(MINUTES_RE) * 60 + unit(SECONDS_RE);
	if (total > 0) return total;
	// Bare digits: seconds, unless it is a year (the swapped YouTube field).
	if (/^\d+$/.test(str) && !YEAR_RE.test(str)) return Number(str);
	return 0;
}

/** "12 min" / "1 h 14 min" / "1 h" from seconds; "" when not positive. */
export function formatDuration(totalSeconds: number): string {
	if (!(totalSeconds > 0)) return "";
	const minutes = Math.max(1, Math.round(totalSeconds / 60));
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m} min`;
	return m ? `${h} h ${m} min` : `${h} h`;
}

/** Same as formatDuration but from any raw value (label, clock, seconds). */
export function formatReleaseDuration(raw: unknown): string {
	return formatDuration(durationSeconds(raw));
}

/**
 * The release year as "2013" or "": `year` first, then any other string field
 * that is a bare year (`length` when the backend swapped the YouTube runs),
 * then a year inside `year` ("Album • 2013").
 */
export function releaseYear(sub: ReleaseSubtitle | null | undefined): string {
	if (!sub || typeof sub !== "object") return "";
	const fields: unknown[] = [sub.year, sub.length, sub.type, sub.subtitle];
	for (const f of fields) {
		if (typeof f === "number" && YEAR_RE.test(String(f))) return String(f);
		if (isYearToken(f)) return String(f).trim();
	}
	for (const f of fields) {
		if (typeof f !== "string") continue;
		const m = f.match(/\b((?:19|20)\d{2})\b/);
		if (m && !durationSeconds(f)) return m[1];
	}
	return "";
}

/**
 * The release length in seconds: the first of `length`, `durationSec`,
 * `duration`, `year` (swapped YouTube runs) that parses as a duration. A
 * numeric `durationSec` is always seconds.
 */
export function releaseDurationSeconds(
	sub: ReleaseSubtitle | null | undefined,
): number {
	if (!sub || typeof sub !== "object") return 0;
	for (const f of [sub.length, sub.durationSec, sub.duration, sub.year]) {
		const s = durationSeconds(f);
		if (s > 0) return s;
	}
	return 0;
}

/** "13 titres" / "1 titre" / "" from 13, "13 songs", "1 song", "13 titres". */
export function releaseTracks(sub: ReleaseSubtitle | null | undefined): string {
	const raw = sub?.tracks;
	const n =
		typeof raw === "number"
			? raw
			: parseInt(String(raw ?? "").replace(/[^\d]+/g, " ").trim(), 10);
	return Number.isFinite(n) && n > 0 ? `${n} ${n > 1 ? "titres" : "titre"}` : "";
}

/** "Album" / "Single" / "EP" / "Playlist" (default Album). */
export function releaseTypeLabel(sub: ReleaseSubtitle | null | undefined): string {
	const rawType = String(sub?.type ?? "").trim();
	// `type` holding a year or a duration is not a type (field shapes vary).
	if (!rawType || isYearToken(rawType) || durationSeconds(rawType) > 0) return "Album";
	return (
		TYPE_LABELS[rawType.toLowerCase()] ??
		rawType.charAt(0).toUpperCase() + rawType.slice(1)
	);
}

/** "Album · 13 titres · 2013 · 1 h 14 min" (parts omitted when unknown). */
export function buildReleaseLine(sub: ReleaseSubtitle | null | undefined): string {
	return [
		releaseTypeLabel(sub),
		releaseTracks(sub),
		releaseYear(sub),
		formatDuration(releaseDurationSeconds(sub)),
	]
		.filter(Boolean)
		.join(" · ");
}
