// 39A (B6-7): inviting an anonymous profile WITH a history to give its first
// name, and telling what the login moved (POST me/login `migrated`). Pure
// helpers (no network): the components call login()/getStatsSummary().

/** `migrated` of POST me/login (null: nothing eligible, e.g. named -> named). */
export interface MigratedCounts {
	plays: number;
	favorites: number;
	follows: number;
	playlists: number;
}

/** The prompt only shows from this many plays (below, FirstRun covers it). */
export const IDENTITY_MIN_PLAYS = 10;
/** "Plus tard" hides the prompt this long (localStorage). */
export const IDENTITY_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const IDENTITY_SNOOZE_KEY = "ytm-identity-snooze";
/** The last login's migration, for the Compte page (localStorage). */
export const IDENTITY_MIGRATED_KEY = "ytm-identity-migrated";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function storage(s?: Store): Store {
	if (s) return s;
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

/** Epoch ms of the last "Plus tard", 0 when none (or unreadable). */
export function readIdentitySnooze(s?: Store): number {
	try {
		const n = Number(storage(s)?.getItem(IDENTITY_SNOOZE_KEY) || 0);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

export function snoozeIdentity(now = Date.now(), s?: Store): void {
	try {
		storage(s)?.setItem(IDENTITY_SNOOZE_KEY, String(now));
	} catch {
		/* no storage: hidden for this load only */
	}
}

/** "Plus tard" pressed less than 7 days ago (a snooze in the future: clock moved, ignored). */
export function identitySnoozed(snoozedAt: number, now: number): boolean {
	return snoozedAt > 0 && snoozedAt <= now && now - snoozedAt < IDENTITY_SNOOZE_MS;
}

/** Anonymous, at least IDENTITY_MIN_PLAYS plays, not snoozed in the last 7 days. */
export function shouldPromptIdentity(o: { anonymous: boolean; plays: number; snoozedAt: number; now: number }): boolean {
	if (!o.anonymous || !(o.plays >= IDENTITY_MIN_PLAYS)) return false;
	return !identitySnoozed(o.snoozedAt, o.now);
}

/** A well-formed `migrated` object, else null. */
export function parseMigrated(v: unknown): MigratedCounts | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) > 0 ? Math.floor(o[k] as number) : 0);
	return { plays: n("plays"), favorites: n("favorites"), follows: n("follows"), playlists: n("playlists") };
}

export function migratedTotal(m: MigratedCounts | null | undefined): number {
	return m ? m.plays + m.favorites + m.follows + m.playlists : 0;
}

const PARTS: Array<{ key: keyof MigratedCounts; one: string; many: string; fem: boolean }> = [
	{ key: "plays", one: "écoute", many: "écoutes", fem: true },
	{ key: "favorites", one: "favori", many: "favoris", fem: false },
	{ key: "follows", one: "artiste suivi", many: "artistes suivis", fem: false },
	{ key: "playlists", one: "playlist", many: "playlists", fem: true },
];

/**
 * "12 écoutes, 3 favoris et 1 playlist déplacés sur Camille"; "" when nothing
 * moved. The participle agrees with the parts (feminine only when every
 * part is, singular only for a single "1 ...").
 */
export function migratedSummary(m: MigratedCounts | null | undefined, name: string): string {
	if (!m) return "";
	const parts = PARTS.filter((p) => m[p.key] > 0);
	if (!parts.length) return "";
	const words = parts.map((p) => `${m[p.key]} ${m[p.key] > 1 ? p.many : p.one}`);
	const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} et ${words[words.length - 1]}` : words[0];
	const fem = parts.every((p) => p.fem);
	const plural = parts.length > 1 || m[parts[0].key] > 1;
	const participle = `déplacé${fem ? "e" : ""}${plural ? "s" : ""}`;
	return `${list} ${participle} sur ${name}`;
}

export interface RememberedMigration {
	name: string;
	at: number;
	migrated: MigratedCounts;
}

/** Keep the last non-empty migration for the Compte page. */
export function rememberMigration(name: string, migrated: MigratedCounts | null, now = Date.now(), s?: Store): void {
	try {
		if (!migrated || migratedTotal(migrated) === 0) return;
		storage(s)?.setItem(IDENTITY_MIGRATED_KEY, JSON.stringify({ name, at: now, migrated }));
	} catch {
		/* best-effort */
	}
}

export function readMigration(s?: Store): RememberedMigration | null {
	try {
		const raw = storage(s)?.getItem(IDENTITY_MIGRATED_KEY);
		if (!raw) return null;
		const j = JSON.parse(raw);
		const migrated = parseMigrated(j?.migrated);
		if (!j || typeof j.name !== "string" || typeof j.at !== "number" || !migrated) return null;
		return { name: j.name, at: j.at, migrated };
	} catch {
		return null;
	}
}
