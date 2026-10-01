// 41A (B6-22): Ton mois extras (série, grille jour x heure, décennies, Ton
// année) and their French wording. API calls pass the viewer's offset (?tz=,
// minutes east of UTC) so days and hours are local, like me/stats/summary.
// Pure helpers are exported for vitest.
import { APIClient } from "$lib/api";
import { getStatsSummary, getTopBy, type TopRow } from "$lib/me";
import { formatCountFr } from "$lib/utils/formatFr";
import type { WeekShare } from "$lib/utils/shareWeek";

export interface StreakDay {
	date: string; // YYYY-MM-DD, viewer local
	minutes: number;
}
export interface Streaks {
	current: number;
	longest: number;
	lastDay: string; // "" when the profile never played
	tz: number;
	days: StreakDay[]; // last 90 days, oldest first, ending today
}

const tzParam = () => -new Date().getTimezoneOffset();

export async function getStreaks(): Promise<Streaks> {
	return (await APIClient.fetch(`/api/v1/me/stats/streaks?tz=${tzParam()}`)).json();
}

/** YYYY-MM-DD of `d` in the browser's local time. */
export function localDateKey(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "12 jours d'affilée · record 31", "1 jour · record 4", "Aucune série en cours · record 3". */
export function streakLabel(s: Pick<Streaks, "current" | "longest">): string {
	const cur =
		s.current >= 2
			? `${formatCountFr(s.current, "jour")} d'affilée`
			: s.current === 1
				? formatCountFr(1, "jour")
				: "Aucune série en cours";
	return s.longest > 0 ? `${cur} · record ${s.longest}` : cur;
}

/** The streak is alive but today has no play yet: one nudge line. */
export function streakNeedsToday(s: Pick<Streaks, "current" | "lastDay">, today: string): boolean {
	return s.current > 0 && s.lastDay !== today;
}

export interface Clock {
	days: number;
	tz: number;
	minutes: number[][]; // 7 x 24, Monday first, viewer-local hours
	total: number;
	topDay: number; // -1 without plays
	topHour: number;
}

export async function getClock(days = 90): Promise<Clock> {
	return (await APIClient.fetch(`/api/v1/me/stats/clock?days=${days}&tz=${tzParam()}`)).json();
}

/** Monday first, like the API. */
export const WEEKDAYS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;

/** Parts of the day: [label, first hour, last hour + 1]. */
const DAY_PARTS: [string, number, number][] = [
	["la nuit", 0, 6],
	["le matin", 6, 12],
	["l'après-midi", 12, 18],
	["le soir", 18, 24],
];

/**
 * "Tu écoutes surtout le soir, le samedi." from the 7 x 24 matrix ("" without
 * plays): the part of the day and the weekday with the most minutes.
 */
export function clockSummary(minutes: number[][] | undefined | null): string {
	if (!Array.isArray(minutes) || minutes.length !== 7) return "";
	const perDay = minutes.map((row) => (Array.isArray(row) ? row.reduce((a, b) => a + (Number(b) || 0), 0) : 0));
	const total = perDay.reduce((a, b) => a + b, 0);
	if (!(total > 0)) return "";
	const parts = DAY_PARTS.map(([, from, to]) =>
		minutes.reduce((acc, row) => acc + (row ?? []).slice(from, to).reduce((a, b) => a + (Number(b) || 0), 0), 0),
	);
	let part = 0;
	parts.forEach((v, i) => {
		if (v > parts[part]) part = i;
	});
	let day = 0;
	perDay.forEach((v, i) => {
		if (v > perDay[day]) day = i;
	});
	return `Tu écoutes surtout ${DAY_PARTS[part][0]}, le ${WEEKDAYS_FR[day]}.`;
}

export interface DecadeRow {
	decade: number;
	minutes: number;
	plays: number;
}
export interface Decades {
	days: number;
	decades: DecadeRow[]; // oldest first
	plays: number;
	localPlays: number;
	matchedPlays: number;
}
export async function getDecades(days = 365): Promise<Decades> {
	return (await APIClient.fetch(`/api/v1/me/stats/decades?days=${days}`)).json();
}

export interface YearTop {
	key: string;
	title: string;
	artist?: string;
	artistId?: string;
	albumId?: string;
	count: number;
}
export interface YearView {
	year: number;
	tz: number;
	months: number[]; // 12, minutes, January first
	plays: number;
	minutes: number;
	estimated: boolean;
	distinctTracks: number;
	distinctArtists: number;
	distinctAlbums: number;
	topArtist: YearTop | null;
	topAlbum: YearTop | null;
	newArtists: number;
	newArtistNames: string[];
}
export async function getYear(year?: number): Promise<YearView> {
	const y = year ? `year=${year}&` : "";
	return (await APIClient.fetch(`/api/v1/me/stats/year?${y}tz=${tzParam()}`)).json();
}

export const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] as const;

/** "années 90", "années 2000", "années 2010" (French usage for a decade). */
export function decadeLabel(decade: number): string {
	if (decade >= 1900 && decade < 2000) return `années ${String(decade).slice(2)}`;
	return `années ${decade}`;
}

/** Share of each decade in the matched minutes, in whole percents (sum may be 99-101). */
export function decadeShares(rows: DecadeRow[]): { decade: number; pct: number }[] {
	const total = rows.reduce((a, r) => a + (r.minutes || 0), 0);
	if (!(total > 0)) return [];
	return rows.map((r) => ({ decade: r.decade, pct: Math.round(((r.minutes || 0) / total) * 100) }));
}

/** 41A (B6-13): the profile's own last 7 days for "Partager ma semaine"; null without plays. */
export async function loadWeekShare(): Promise<WeekShare | null> {
	const [summary, artists, albums] = await Promise.all([getStatsSummary(7), getTopBy("artists", 7, 1), getTopBy("albums", 7, 1)]);
	if (!summary || !(summary.plays > 0)) return null;
	const album = (albums?.rows?.[0] ?? null) as (TopRow & { albumId?: string }) | null;
	return {
		minutes: summary.minutes,
		tracks: summary.distinctTracks,
		topArtist: artists?.rows?.[0]?.title ?? "",
		topAlbum: album?.title,
		topAlbumId: album?.albumId || undefined,
	};
}
