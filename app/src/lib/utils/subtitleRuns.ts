/**
 * Subtitle runs (`item.subtitle`: `[{ text, browseId?, pageType? }, ...]`) are
 * rendered one by one by ListItem / Listing, separators (" • ") included. A
 * restored queue (resumeState slims the rows) or a home card without a year
 * loses a run but keeps its separator, so rows read "Daft Punk • One More
 * Time •" (audit v7 finishing lot, v8 TOP 2). Trim separator-only runs at both
 * ends and collapse adjacent ones; never mutate the input, return it untouched
 * when nothing changes (keeps Svelte's `{#each}` cheap).
 */
export interface SubtitleRun {
	text?: unknown;
}

const SEPARATOR_RUN = /^[\s•·|]+$/;

export function isSeparatorRun(run: unknown): boolean {
	if (!run || typeof run !== "object") return true;
	const text = (run as SubtitleRun).text;
	if (typeof text !== "string") return text == null;
	return text === "" || SEPARATOR_RUN.test(text);
}

/**
 * Typed to return exactly the array type it is given (`A`), so a Svelte
 * `{#each trimSeparatorRuns(item.subtitle) as run}` sees the same element type
 * as `{#each item.subtitle as run}` did (a generic `T[]` re-inferred the
 * element as the narrow `Subtitle` interface and broke `.browseId` access).
 * `null` / `undefined` give `[]`.
 */
export function trimSeparatorRuns<A extends readonly SubtitleRun[]>(runs: A | null | undefined): A {
	if (!Array.isArray(runs) || !runs.length) return (Array.isArray(runs) ? runs : []) as unknown as A;
	let start = 0;
	let end = runs.length;
	while (start < end && isSeparatorRun(runs[start])) start++;
	while (end > start && isSeparatorRun(runs[end - 1])) end--;
	let changed = start !== 0 || end !== runs.length;
	const out: SubtitleRun[] = [];
	let prevSep = false;
	for (let i = start; i < end; i++) {
		const sep = isSeparatorRun(runs[i]);
		if (sep && prevSep) {
			changed = true;
			continue;
		}
		prevSep = sep;
		out.push(runs[i]);
	}
	return (changed ? out : runs) as unknown as A;
}
