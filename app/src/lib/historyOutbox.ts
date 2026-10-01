// O9 "écoutes hors-ligne comptées": a play whose POST me/history fails (no
// network, 5xx) is queued in localStorage ("ytm-history-outbox", max 500,
// oldest dropped) with the client `playedAt`, and replayed on the window
// `online` event and at startup. The backend keeps a client playedAt when it
// lies within the last 7 days and not in the future (api/me.go).
// Pure helpers take the storage as a parameter (historyOutbox.test.ts).

export const OUTBOX_KEY = "ytm-history-outbox";
export const OUTBOX_MAX = 500;

export type OutboxEntry = { item: Record<string, unknown>; playedAt: number };
export type SendResult = "ok" | "retry" | "drop";
export type SendPlay = (item: Record<string, unknown>, playedAt: number) => Promise<SendResult>;
type KV = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KV | null {
	try {
		return typeof localStorage !== "undefined" ? localStorage : null;
	} catch {
		return null;
	}
}

// Heavy, replay-useless fields of a Beatbump item (the history keeps the
// stored JSON: title, artist, album, thumbnails, length stay).
const DROP_KEYS = ["loggingContext", "clickTrackingParams", "playerParams", "playlistSetVideoId", "itct", "params", "musicVideoType", "autoMixList"];

/** A queued copy of the item, small enough for 500 of them in localStorage. */
export function slimHistoryItem(item: any): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!item || typeof item !== "object") return out;
	for (const [k, v] of Object.entries(item)) {
		if (DROP_KEYS.includes(k) || typeof v === "function" || k === "playedAt") continue;
		out[k] = v;
	}
	if (Array.isArray(item.thumbnails)) out.thumbnails = item.thumbnails.slice(0, 2);
	return out;
}

/** HTTP status → what to do with the queued play. */
export function statusResult(status: number): SendResult {
	if (status >= 200 && status < 300) return "ok";
	if (status === 0 || status === 408 || status === 429 || status >= 500) return "retry";
	return "drop"; // 4xx: the server will never take it
}

export function readOutbox(store: KV | null = defaultStore()): OutboxEntry[] {
	if (!store) return [];
	try {
		const v = JSON.parse(store.getItem(OUTBOX_KEY) || "[]");
		return Array.isArray(v) ? v.filter((e) => e && typeof e.playedAt === "number" && e.item && typeof e.item === "object") : [];
	} catch {
		return [];
	}
}

function writeOutbox(list: OutboxEntry[], store: KV | null): void {
	if (!store) return;
	try {
		store.setItem(OUTBOX_KEY, JSON.stringify(list));
	} catch {
		/* storage full / private mode: the play is lost, as before O9 */
	}
}

/** Queue one play (oldest dropped beyond OUTBOX_MAX). */
export function enqueuePlay(item: any, playedAt: number, store: KV | null = defaultStore()): void {
	if (!item || !Number.isFinite(playedAt)) return;
	const list = readOutbox(store);
	list.push({ item: slimHistoryItem(item), playedAt });
	writeOutbox(list.length > OUTBOX_MAX ? list.slice(list.length - OUTBOX_MAX) : list, store);
}

const sameEntry = (a: OutboxEntry, b: OutboxEntry) =>
	a.playedAt === b.playedAt && (a.item as any)?.videoId === (b.item as any)?.videoId && (a.item as any)?.title === (b.item as any)?.title;

let flushing: Promise<{ sent: number; dropped: number; left: number }> | null = null;

/**
 * Replay the queue oldest first, one at a time; stops at the first "retry"
 * (still offline / server down). Entries are removed one by one from the
 * CURRENT storage content, so a play queued during the flush is kept.
 */
export function flushOutbox(send: SendPlay, store: KV | null = defaultStore()): Promise<{ sent: number; dropped: number; left: number }> {
	if (flushing) return flushing;
	flushing = (async () => {
		let sent = 0;
		let dropped = 0;
		try {
			for (;;) {
				const head = readOutbox(store)[0];
				if (!head) break;
				const r = await send(head.item, head.playedAt).catch(() => "retry" as SendResult);
				if (r === "retry") break;
				if (r === "ok") sent++;
				else dropped++;
				const cur = readOutbox(store);
				const i = cur.findIndex((e) => sameEntry(e, head));
				if (i !== -1) cur.splice(i, 1);
				writeOutbox(cur, store);
			}
		} finally {
			flushing = null;
		}
		return { sent, dropped, left: readOutbox(store).length };
	})();
	return flushing;
}

let installed = false;
/** Replay on `online` and shortly after startup (once per page). */
export function installHistoryOutbox(send: SendPlay): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	const run = () => {
		if (readOutbox().length) void flushOutbox(send);
	};
	window.addEventListener("online", run);
	setTimeout(run, 4_000);
}
