// F7 + F15: pure helpers of the "Espace" card on the Hors-ligne page
// (downloads-offline/_SpaceCard.svelte): the one size selector shared by
// "Libérer" (HL2) and "Préparer un pack" (HL3), its button labels and the
// status line. No Svelte import so the wording is unit-testable.

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** French units, decimal comma: "0 Mo", "56 Mo", "1,5 Go", "11 Go". */
export function fmtBytesFr(bytes: number): string {
	if (!(bytes > 0)) return "0 Mo";
	if (bytes >= GB) {
		const go = (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1).replace(".", ",");
		return `${go} Go`;
	}
	return `${Math.max(1, Math.round(bytes / MB))} Mo`;
}

/** The quota as text; 0 (or less) is "illimité". */
export function fmtQuotaFr(quota: number): string {
	return quota > 0 ? fmtBytesFr(quota) : "illimité";
}

/** Labels of the two action buttons for the selected size (Mo). */
export function spaceButtonLabels(sizeMb: number): { freeUp: string; pack: string } {
	return { freeUp: `Libérer ${sizeMb} Mo`, pack: `Préparer un pack de ${sizeMb} Mo` };
}

export type SpaceStatusInput = {
	total: number;
	quota: number;
	pinnedBytes: number;
	loading?: boolean;
	/** The service worker did not answer: the cache size is unknown. */
	unknown?: boolean;
};

/**
 * "56 Mo en cache sur 2 Go, dont 12 Mo épinglés" (quota and pinned parts only
 * when they say something). `totalText` is the bare cache size, reused by the
 * free-up outcome ("… · 44 Mo restants").
 */
export function spaceStatusLine(s: SpaceStatusInput): { text: string; totalText: string } {
	const totalText = fmtBytesFr(s.total);
	if (s.loading) return { text: "Lecture du cache…", totalText };
	if (s.unknown) return { text: "Taille du cache inconnue", totalText };
	let text = `${totalText} en cache`;
	if (s.quota > 0) text += ` sur ${fmtQuotaFr(s.quota)}`;
	if (s.pinnedBytes > 0) text += `, dont ${fmtBytesFr(s.pinnedBytes)} épinglés`;
	return { text, totalText };
}
