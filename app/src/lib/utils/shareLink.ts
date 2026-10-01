// Share action ("Partager"): the canonical SPA URL of a track or an album,
// through the Web Share sheet when the browser has one, else copied to the
// clipboard with a "Lien copié" toast. Link-preview robots then get the Open
// Graph card for that URL (backend/api/og_preview.go).
import { notify } from "$lib/utils";

export type ShareKind = "track" | "album";

/** /listen?id= for a track, /release?id= for an album, on `origin`. */
export function canonicalShareURL(kind: ShareKind, id: string, origin: string): string {
	const path = kind === "track" ? "/listen" : "/release";
	return `${origin.replace(/\/+$/, "")}${path}?id=${encodeURIComponent(id)}`;
}

type ShareNavigator = Pick<Navigator, "share" | "canShare" | "clipboard">;

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

/**
 * Shares `data` with the native sheet when available; any non-cancel failure
 * (or no Web Share) falls back to the clipboard. Toasts: "Lien copié" on a
 * copy, an error toast when nothing worked, nothing when the user dismissed
 * the sheet.
 */
export async function shareLink(
	data: { title?: string; text?: string; url: string },
	nav: ShareNavigator | undefined = typeof navigator !== "undefined" ? navigator : undefined,
	toast: typeof notify = notify,
): Promise<ShareOutcome> {
	if (nav && typeof nav.share === "function" && (typeof nav.canShare !== "function" || nav.canShare(data))) {
		try {
			await nav.share(data);
			return "shared";
		} catch (err) {
			if ((err as { name?: string } | null)?.name === "AbortError") return "cancelled";
		}
	}
	try {
		if (!nav?.clipboard?.writeText) throw new Error("no clipboard");
		await nav.clipboard.writeText(data.url);
		toast("Lien copié", "success");
		return "copied";
	} catch {
		toast("Impossible de copier le lien", "error");
		return "failed";
	}
}
