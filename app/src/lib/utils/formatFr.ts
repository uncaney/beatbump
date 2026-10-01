// c31a (F8): one French formatter for sizes and counts on the screens this
// program created (Hors-ligne, Espace card, Réglages > Hors-ligne, /about,
// stats). French typography: decimal comma, a narrow no-break space (U+202F)
// between a number and its unit ("24 Mo", "1,2 Go"), a no-break space (U+00A0)
// between a count and its noun ("12 titres"), "1 234" thousands (fr-FR).
// No Svelte import: unit-testable and usable from plain .ts helpers.

/** Narrow no-break space: number <-> unit ("24 Mo"). */
export const NNBSP = " ";
/** No-break space: count <-> noun ("12 titres"). */
export const NBSP = " ";

const UNITS = ["o", "Ko", "Mo", "Go", "To"] as const;

function decimalFr(v: number, digits: number): string {
	const s = v.toFixed(digits);
	// "2,0 Go" reads as noise: drop a zero decimal.
	return (digits > 0 ? s.replace(/\.0+$/, "") : s).replace(".", ",");
}

/**
 * "0 Mo", "512 o", "3,5 Mo", "24 Mo", "1,2 Go", "11 Go" (1024 based, one
 * decimal under 10 of a unit, none above). Not a positive finite number ->
 * "0 Mo" (an empty cache), so callers never print "NaN".
 */
export function formatBytesFr(bytes: number | undefined | null): string {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n <= 0) return `0${NNBSP}Mo`;
	let v = n;
	let i = 0;
	while (v >= 1024 && i < UNITS.length - 1) {
		v /= 1024;
		i++;
	}
	let digits = i === 0 ? 0 : v < 10 ? 1 : 0;
	// 1023,96 Ko rounds to "1024 Ko": move up one unit instead.
	if (Number(v.toFixed(digits)) >= 1024 && i < UNITS.length - 1) {
		v /= 1024;
		i++;
		digits = 1;
	}
	return `${decimalFr(v, digits)}${NNBSP}${UNITS[i]}`;
}

/** A whole number in Mo ("100 Mo"): the size selectors of the Espace card. */
export function formatMoFr(mb: number): string {
	return `${formatIntFr(mb)}${NNBSP}Mo`;
}

/** "1 234" (fr-FR grouping), rounded; not finite -> "0". */
export function formatIntFr(n: number): string {
	const v = Math.round(Number(n) || 0);
	try {
		return new Intl.NumberFormat("fr-FR").format(v);
	} catch {
		return String(v);
	}
}

/**
 * "0 titre", "1 titre", "12 titres", "1 234 titres". French rule: singular
 * under 2. `pluriel` defaults to `singulier + "s"` ("morceau" needs "morceaux").
 */
export function formatCountFr(n: number, singulier: string, pluriel?: string): string {
	const v = Math.round(Number(n) || 0);
	const word = Math.abs(v) >= 2 ? (pluriel ?? `${singulier}s`) : singulier;
	return `${formatIntFr(v)}${NBSP}${word}`;
}
