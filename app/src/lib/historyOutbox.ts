// O9 "écoutes hors-ligne comptées": a play whose POST me/history fails (no
// network, 5xx) is queued in localStorage ("ytm-history-outbox", max 500,
// oldest dropped) with the client `playedAt`, and replayed on the window
// `online` event and at startup. The backend keeps a client playedAt when it
// lies within the last 7 days and not in the future (api/me.go).
// I11: a replay also carries `clientSentAt` (the client clock when it is
// sent) so the server can measure and correct a skewed client clock; a
// direct POST (no marker) is dated by the server unless the client clock is
// within 5 min of it.
// Pure helpers take the storage as a parameter (historyOutbox.test.ts).

export const OUTBOX_KEY = "ytm-history-outbox";
export const OUTBOX_MAX = 500;
/** I11: body key of an outbox replay: the client clock (ms) at send time. */
export const REPLAY_MARK = "clientSentAt";

/** I11: the item as sent by a replay (marked with the client clock now). */
export function replayItem(item: Record<string, unknown>, now: number): Record<string, unknown> {
	return { ...item, [REPLAY_MARK]: now };
}

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
		if (DROP_KEYS.includes(k) || typeof v === "function" || k === "playedAt" || k === REPLAY_MARK) continue;
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

let flushing: Promise<FlushResult> | null = null;
type FlushResult = { sent: number; dropped: number; left: number };

// I10: one flusher across tabs. `navigator.locks` (ifAvailable: a tab that
// finds the lock taken skips, the holder sends the queue) when available,
// else a localStorage lease renewed while flushing. The server is also
// idempotent on (profile, ref, playedAt) (api/me.go playAlreadyRecorded).
export const OUTBOX_LOCK = "ytm-history-outbox";
export const OUTBOX_LEASE_KEY = "ytm-history-outbox-lease";
export const OUTBOX_LEASE_MS = 30_000;
type LockManagerLike = {
	request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
};
export type FlushOpts = { locks?: LockManagerLike | null; owner?: string; now?: () => number };
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

function browserLocks(): LockManagerLike | null {
	try {
		const l = (globalThis as any).navigator?.locks;
		return l && typeof l.request === "function" ? l : null;
	} catch {
		return null;
	}
}

/** Take / renew the lease for `owner`; false when another tab holds a live one. */
export function takeOutboxLease(store: KV | null, owner: string, now: number): boolean {
	if (!store) return true;
	try {
		const cur = JSON.parse(store.getItem(OUTBOX_LEASE_KEY) || "null");
		if (cur && cur.owner !== owner && typeof cur.until === "number" && cur.until > now) return false;
		store.setItem(OUTBOX_LEASE_KEY, JSON.stringify({ owner, until: now + OUTBOX_LEASE_MS }));
		return true;
	} catch {
		return true; // storage unusable: no cross-tab coordination possible
	}
}

function releaseOutboxLease(store: KV | null, owner: string): void {
	if (!store) return;
	try {
		const cur = JSON.parse(store.getItem(OUTBOX_LEASE_KEY) || "null");
		if (cur && cur.owner === owner) store.setItem(OUTBOX_LEASE_KEY, JSON.stringify({ owner, until: 0 }));
	} catch {
		/* best-effort */
	}
}

/**
 * Replay the queue oldest first, one at a time; stops at the first "retry"
 * (still offline / server down). Entries are removed one by one from the
 * CURRENT storage content, so a play queued during the flush is kept.
 * Another tab flushing (lock / lease held) makes this a no-op.
 */
export function flushOutbox(send: SendPlay, store: KV | null = defaultStore(), opts: FlushOpts = {}): Promise<FlushResult> {
	if (flushing) return flushing;
	const owner = opts.owner ?? TAB_ID;
	const now = opts.now ?? Date.now;
	const locks = opts.locks === undefined ? browserLocks() : opts.locks;
	const skipped = (): FlushResult => ({ sent: 0, dropped: 0, left: readOutbox(store).length });
	const run = async (lease: boolean): Promise<FlushResult> => {
		let sent = 0;
		let dropped = 0;
		try {
			for (;;) {
				if (lease && !takeOutboxLease(store, owner, now())) break;
				const head = readOutbox(store)[0];
				if (!head) break;
				const r = await send(replayItem(head.item, now()), head.playedAt).catch(() => "retry" as SendResult);
				if (r === "retry") break;
				if (r === "ok") sent++;
				else dropped++;
				const cur = readOutbox(store);
				const i = cur.findIndex((e) => sameEntry(e, head));
				if (i !== -1) cur.splice(i, 1);
				writeOutbox(cur, store);
			}
		} finally {
			if (lease) releaseOutboxLease(store, owner);
		}
		return { sent, dropped, left: readOutbox(store).length };
	};
	const p: Promise<FlushResult> = (async () => {
		if (locks) {
			const r = await locks.request(OUTBOX_LOCK, { ifAvailable: true }, async (lock) => (lock ? run(false) : skipped()));
			return r as FlushResult;
		}
		if (!takeOutboxLease(store, owner, now())) return skipped();
		return run(true);
	})().finally(() => {
		if (flushing === p) flushing = null;
	});
	flushing = p;
	return p;
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
