// L13-13: the empty state of a collection list (_Browse.svelte). A refused deep
// link (local_browse.go answers 400 with `reason`) names WHY the list is empty
// instead of a bare "Aucun résultat" under the filter chip:
// /library/albums?filter=added-month&month=2026-06 (before the July 2026
// migration that rewrote the acquisition dates), a month in the future, a
// malformed month, an unknown filter / sort. Pure.

export type EmptyListInput = {
	q?: string | null;
	filter?: string | null;
	/** `reason` of a 4xx answer ("month in the future: 2027-01"), "" / null when the list is simply empty. */
	reason?: string | null;
};

/** "2026-07" -> "juillet 2026" (UTC, no locale surprise on the 1st). */
export function monthFr(yyyymm: string): string {
	const m = /^(\d{4})-(\d{2})$/.exec(yyyymm);
	if (!m) return yyyymm;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
	if (Number.isNaN(d.getTime())) return yyyymm;
	return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

/** The server's reason in French for the reasons local_browse.go emits; the raw text otherwise. */
export function reasonFr(reason: string | null | undefined): string {
	const r = String(reason ?? "").trim();
	if (!r) return "";
	let m = /^month before (\d{4}-\d{2})/.exec(r);
	if (m) return `les arrivées ne sont connues qu'à partir de ${monthFr(m[1])} (dates de migration)`;
	m = /^month in the future: (\d{4}-\d{2})/.exec(r);
	if (m) return `${monthFr(m[1])} n'est pas encore arrivé`;
	if (/^month must be YYYY-MM/.test(r)) return "le mois du lien est invalide";
	if (/^unknown filter/.test(r)) return "le filtre du lien est inconnu";
	if (/^unknown sort/.test(r)) return "le tri du lien est inconnu";
	if (/^offset too large/.test(r)) return "la liste ne va pas aussi loin";
	return r;
}

/** The line under an empty grid: the reason when the server gave one, else the usual texts. */
/**
 * L14-11: the count the collection header shows ("1 934 artistes"). The folded
 * artists list (local_browse.go `collapsed`) sends `shown` = rows after the
 * aliases are folded, next to `total` = raw index credits that the pager
 * still needs (nextOffset is a raw offset); the header prefers `shown`. Any
 * other list has only `total`; a list without either counts its rows.
 */
export function browseHeaderCount(data: { total?: unknown; shown?: unknown } | null | undefined, rows: number): number {
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
	return num(data?.shown) ?? num(data?.total) ?? rows;
}

export function emptyListText(i: EmptyListInput): string {
	const why = reasonFr(i.reason);
	if (why) return `Aucun résultat : ${why}.`;
	return i.q || i.filter ? "Aucun résultat" : "Rien ici pour l’instant";
}
