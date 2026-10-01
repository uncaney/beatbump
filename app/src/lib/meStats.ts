// 41A (B6-22): Ton mois extras (série, grille jour x heure, décennies, Ton
// année) and their French wording. API calls pass the viewer's offset (?tz=,
// minutes east of UTC) so days and hours are local, like me/stats/summary.
// Pure helpers are exported for vitest.
import { APIClient } from "$lib/api";
import { formatCountFr } from "$lib/utils/formatFr";

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
