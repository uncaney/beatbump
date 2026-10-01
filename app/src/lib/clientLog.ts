/**
 * ST3 client error reporting: uncaught errors, unhandled rejections and
 * player/media errors are POSTed once per distinct message per session to
 * /api/v1/client-log (in-memory ring on the server, no profile data). Sent
 * with `navigator.sendBeacon` (survives page unload) and `fetch keepalive`
 * as the fallback. The pure parts (payload shape, clipping, dedupe) are
 * unit tested; `initClientLog` wires the window listeners once.
 */
import { SERVER_DOMAIN } from "../env";

export type ClientLogKind = "error" | "unhandledrejection" | "media" | "player" | "chunk";

export interface ClientLogPayload {
	kind: ClientLogKind | string;
	message: string;
	stack?: string;
	url?: string;
	ua?: string;
}

/** Server limit is 4 KB per body; the fields are clipped well under it. */
export const CLIENT_LOG_MAX_BODY = 4 * 1024;
const MAX_MESSAGE = 1000;
const MAX_STACK = 2000;
const MAX_URL = 500;
const MAX_UA = 250;

export const CLIENT_LOG_PATH = "/api/v1/client-log";

/** Dedupe key: kind + message (the stack varies with minified chunk names). */
export function clientLogKey(kind: string, message: string): string {
	return `${kind}\u0000${String(message ?? "").trim()}`;
}

/**
 * Whether a report with `key` should be sent now: true the first time, false
 * for every later occurrence this session. `seen` is the session set (the
 * caller owns it); it is bounded so a pathological loop of distinct
 * messages cannot grow it for ever.
 */
export function shouldReport(seen: Set<string>, key: string, max = 200): boolean {
	if (seen.has(key)) return false;
	if (seen.size >= max) return false;
	seen.add(key);
	return true;
}

const clip = (s: unknown, n: number): string => {
	const str = String(s ?? "").trim();
	return str.length > n ? str.slice(0, n) : str;
};

/** Build the clipped payload; `message` is required (empty -> null, nothing to send). */
export function buildClientLogPayload(
	kind: ClientLogKind | string,
	message: unknown,
	extra: { stack?: unknown; url?: unknown; ua?: unknown } = {},
): ClientLogPayload | null {
	const msg = clip(message, MAX_MESSAGE);
	if (!msg) return null;
	const out: ClientLogPayload = { kind: clip(kind, 32) || "error", message: msg };
	const stack = clip(extra.stack, MAX_STACK);
	if (stack && stack !== msg) out.stack = stack;
	const url = clip(extra.url, MAX_URL);
	if (url) out.url = url;
	const ua = clip(extra.ua, MAX_UA);
	if (ua) out.ua = ua;
	return out;
}

/** Message + stack of anything thrown (Error, string, DOMException, object). */
export function describeThrown(reason: unknown): { message: string; stack?: string } {
	if (reason instanceof Error) return { message: `${reason.name}: ${reason.message}`, stack: reason.stack };
	if (typeof reason === "string") return { message: reason };
	if (reason && typeof reason === "object") {
		const r = reason as { message?: unknown; name?: unknown; reason?: unknown };
		if (typeof r.message === "string") return { message: `${typeof r.name === "string" ? r.name + ": " : ""}${r.message}` };
		try {
			return { message: JSON.stringify(reason).slice(0, MAX_MESSAGE) };
		} catch {
			/* circular */
		}
	}
	return { message: String(reason) };
}

type Sender = (body: string) => void;

function defaultSender(body: string): void {
	const url = `${SERVER_DOMAIN ?? ""}${CLIENT_LOG_PATH}`;
	try {
		if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
			// text/plain keeps the beacon a simple request (no CORS preflight);
			// the server parses the body as JSON regardless of the type.
			if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
		}
	} catch {
		/* fall through to fetch */
	}
	try {
		void fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			keepalive: true,
			credentials: "same-origin",
		}).catch(() => {});
	} catch {
		/* nothing else to try */
	}
}

const seen = new Set<string>();
let send: Sender = defaultSender;

/** Tests: swap the transport and reset the session dedupe. */
export function _setClientLogSender(s: Sender | null): void {
	send = s ?? defaultSender;
	seen.clear();
}

/**
 * Report one client error (deduped per kind+message for the session). Safe
 * to call anywhere: never throws, no-op outside the browser.
 */
export function reportClientError(kind: ClientLogKind | string, message: unknown, extra: { stack?: unknown; url?: unknown } = {}): boolean {
	try {
		if (typeof window === "undefined") return false;
		const payload = buildClientLogPayload(kind, message, {
			...extra,
			url: extra.url ?? window.location?.href,
			ua: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
		});
		if (!payload) return false;
		if (!shouldReport(seen, clientLogKey(payload.kind, payload.message))) return false;
		const body = JSON.stringify(payload);
		if (body.length > CLIENT_LOG_MAX_BODY) return false;
		send(body);
		return true;
	} catch {
		return false;
	}
}

let installed = false;

/** Hook window `error` + `unhandledrejection` once (root layout onMount). */
export function initClientLog(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	window.addEventListener("error", (e: ErrorEvent) => {
		const d = e.error ? describeThrown(e.error) : { message: e.message };
		const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
		reportClientError("error", (d.message || "Script error") + where, { stack: d.stack });
	});
	window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
		const d = describeThrown(e.reason);
		reportClientError("unhandledrejection", d.message, { stack: d.stack });
	});
}
