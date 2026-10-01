import { describe, expect, it } from "vitest";
import {
	IDENTITY_MIGRATED_KEY,
	IDENTITY_SNOOZE_MS,
	migratedSummary,
	migratedTotal,
	parseMigrated,
	readIdentitySnooze,
	readMigration,
	rememberMigration,
	shouldPromptIdentity,
	snoozeIdentity,
} from "./identity";

function mem() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		m,
	};
}

describe("39A identity prompt", () => {
	const now = 1_800_000_000_000;
	it("shows for an anonymous profile with >= 10 plays only", () => {
		expect(shouldPromptIdentity({ anonymous: true, plays: 10, snoozedAt: 0, now })).toBe(true);
		expect(shouldPromptIdentity({ anonymous: true, plays: 9, snoozedAt: 0, now })).toBe(false);
		expect(shouldPromptIdentity({ anonymous: false, plays: 50, snoozedAt: 0, now })).toBe(false);
		expect(shouldPromptIdentity({ anonymous: true, plays: NaN, snoozedAt: 0, now })).toBe(false);
	});
	it("'Plus tard' hides it for 7 days", () => {
		const s = mem();
		snoozeIdentity(now, s);
		const at = readIdentitySnooze(s);
		expect(at).toBe(now);
		expect(shouldPromptIdentity({ anonymous: true, plays: 20, snoozedAt: at, now: now + IDENTITY_SNOOZE_MS - 1 })).toBe(false);
		expect(shouldPromptIdentity({ anonymous: true, plays: 20, snoozedAt: at, now: now + IDENTITY_SNOOZE_MS })).toBe(true);
		// a snooze in the future (clock moved back) does not hide it forever
		expect(shouldPromptIdentity({ anonymous: true, plays: 20, snoozedAt: now + 1000, now })).toBe(true);
	});
	it("summarises what moved, in French", () => {
		expect(migratedSummary({ plays: 12, favorites: 3, follows: 0, playlists: 1 }, "Camille")).toBe(
			"12 écoutes, 3 favoris et 1 playlist déplacés sur Camille",
		);
		expect(migratedSummary({ plays: 1, favorites: 0, follows: 0, playlists: 0 }, "Léa")).toBe("1 écoute déplacée sur Léa");
		expect(migratedSummary({ plays: 4, favorites: 0, follows: 0, playlists: 2 }, "Léa")).toBe("4 écoutes et 2 playlists déplacées sur Léa");
		expect(migratedSummary({ plays: 0, favorites: 0, follows: 2, playlists: 0 }, "Léa")).toBe("2 artistes suivis déplacés sur Léa");
		expect(migratedSummary({ plays: 0, favorites: 0, follows: 0, playlists: 0 }, "Léa")).toBe("");
		expect(migratedSummary(null, "Léa")).toBe("");
	});
	it("parses the server's migrated object defensively", () => {
		expect(parseMigrated(null)).toBeNull();
		expect(parseMigrated("x")).toBeNull();
		expect(parseMigrated({ plays: 2, favorites: -1, follows: "3" })).toEqual({ plays: 2, favorites: 0, follows: 0, playlists: 0 });
		expect(migratedTotal({ plays: 2, favorites: 1, follows: 1, playlists: 1 })).toBe(5);
	});
	it("remembers the last non-empty migration for the Compte page", () => {
		const s = mem();
		rememberMigration("Camille", { plays: 0, favorites: 0, follows: 0, playlists: 0 }, now, s);
		expect(s.m.has(IDENTITY_MIGRATED_KEY)).toBe(false);
		rememberMigration("Camille", null, now, s);
		expect(readMigration(s)).toBeNull();
		rememberMigration("Camille", { plays: 5, favorites: 1, follows: 0, playlists: 0 }, now, s);
		expect(readMigration(s)).toEqual({ name: "Camille", at: now, migrated: { plays: 5, favorites: 1, follows: 0, playlists: 0 } });
		s.setItem(IDENTITY_MIGRATED_KEY, "{bad");
		expect(readMigration(s)).toBeNull();
	});
});
