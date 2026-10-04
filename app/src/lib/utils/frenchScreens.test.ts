/**
 * c31a item 4: structural guard against French/English mixing on the screens
 * the improvement program created or rewrote (cycle 8 onwards). Each listed
 * file is scanned for a short deny-list of English UI words in what a user
 * can read:
 *   - markup text (between tags, outside <script>/<style>/comments),
 *   - string literals inside markup `{...}` expressions,
 *   - user-facing attributes (aria-label, title, placeholder, alt, label),
 *   - string literals of the <script> block and of the listed .ts modules
 *     (toasts, aria-live announcements, label tables), except console.*,
 *     thrown Error messages and import specifiers, which never reach the UI.
 *
 * Decision 1 (lane c59a): the original Beatbump screens are French too and
 * listed below (search, player menus, row menus, library, sync wizard,
 * settings, nav, error page, explore, trending, artist). The menu identifiers
 * of dropdowns.config (English keys such as "View Artist") are not UI text:
 * their French display label lives in DROPDOWN_LABELS_FR, which is checked
 * on its own, and a text equal to a key is skipped here.
 * A legitimate hit (an identifier or a brand that happens to match) goes in
 * ALLOW with the exact text and a reason; keep it short.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DROPDOWN_LABELS_FR } from "../configs/dropdowns.config";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Program screens and modules (POSIX paths relative to `src/`). */
export const FILES = [
	"routes/(app)/library/downloads-offline/+page.svelte",
	"routes/(app)/library/downloads-offline/_SpaceCard.svelte",
	"routes/(app)/settings/OfflineSettings.svelte",
	"routes/(app)/library/_Browse.svelte",
	"routes/(app)/library/_CollectionNav.svelte",
	"routes/(app)/library/albums/+page.svelte",
	"routes/(app)/library/artists/+page.svelte",
	"routes/(app)/library/all-songs/+page.svelte",
	"routes/(app)/library/mixes/+page.svelte",
	"routes/(app)/library/for-you/+page.svelte",
	"routes/(app)/library/genres/+page.svelte",
	"routes/(app)/library/stats/+page.svelte",
	"routes/(app)/library/recent/+page.svelte",
	"routes/(app)/library/rediscover/+page.svelte",
	"routes/(app)/library/playlists-srv/+page.svelte",
	"routes/(app)/library/playlists-srv/[id]/+page.svelte",
	"routes/(app)/about/+page.svelte",
	"routes/share-target/+page.svelte",
	"routes/(app)/home/_FirstRun.svelte",
	"routes/(app)/home/_PersonalRows.svelte",
	"lib/components/InstallHint/InstallHint.svelte",
	"lib/components/PlayAllBar/PlayAllBar.svelte",
	"lib/components/ListItem/KeepOfflineButton.svelte",
	"lib/components/Layouts/InfoBox.svelte",
	"lib/offlineBatch.ts",
	"lib/offline.ts",
	"lib/lazyComponent.ts",
	// L10-13 / L10-5 (audit logic v10): program screens and modules added since c31.
	"routes/(app)/library/account/+page.svelte",
	"lib/components/ShareLinkButton/ShareLinkButton.svelte",
	"lib/components/EmptyState/EmptyState.svelte",
	"lib/components/EmptyState/ErrorState.svelte",
	"lib/mixes.ts",
	"lib/offlineFailed.ts",
	"lib/utils/shareLink.ts",
	"lib/utils/retryOnce.ts",
	// 39A: identity prompt and device-only banner.
	"lib/components/IdentityPrompt/IdentityPrompt.svelte",
	"lib/components/IdentityPrompt/DeviceOnlyBanner.svelte",
	"lib/identity.ts",
	// c39c B6-9: sleep timer sheet and its store (toasts, labels).
	"lib/components/Player/SleepTimerSheet.svelte",
	"lib/stores/sleepTimer.ts",
	// c40a: live resume (card, "Continuer ici" toasts, device name).
	"lib/stores/nowPlayingSync.ts",
	// 41A: Ton mois extras (série, grille, Ton année) and Partager ma semaine.
	"routes/(app)/library/stats/_Streak.svelte",
	"routes/(app)/library/stats/_Clock.svelte",
	"routes/(app)/library/stats/_Year.svelte",
	"lib/meStats.ts",
	"lib/components/ShareWeek/ShareWeek.svelte",
	"lib/utils/shareWeek.ts",
	// Decision 1 (c59a): the Beatbump-origin screens, now French.
	"routes/+error.svelte",
	"routes/(app)/home/+page.svelte",
	"routes/(app)/search/[slug]/+page.svelte",
	"routes/(app)/explore/+page.svelte",
	"routes/(app)/explore/[slug]/+page.svelte",
	"routes/(app)/trending/+page.svelte",
	"routes/(app)/trending/[slug]/+page.svelte",
	"routes/(app)/[artistOrChannel=channel]/[slug]/+page.svelte",
	"routes/(app)/playlist/[slug]/+page.svelte",
	"routes/(app)/session/+page.svelte",
	"routes/(app)/settings/+page.svelte",
	"routes/(app)/library/+page.svelte",
	"routes/(app)/library/_Sync.svelte",
	"routes/(app)/library/songs/+page.svelte",
	"routes/(app)/library/_components/Grid/Grid.svelte",
	"routes/(app)/library/_components/Popup.svelte",
	"lib/components/Nav/Nav.svelte",
	"lib/components/Layouts/Header.svelte",
	"lib/components/Carousel/Carousel.svelte",
	"lib/components/Carousel/CarouselItem.svelte",
	"lib/components/Item/Listing.svelte",
	"lib/components/ListItem/ListItem.svelte",
	"lib/components/ListItem/LocalListItem.svelte",
	"lib/components/Player/Player.svelte",
	"lib/components/Player/Fullscreen.svelte",
	"lib/components/Popper/MobilePopper.svelte",
	"lib/components/ArtistPageHeader/ArtistPageHeader.svelte",
	"lib/components/ArtistPageHeader/Description/Description.svelte",
	"lib/components/ListInfoBar/Select.svelte",
	"lib/components/ListInfoBar/ListInfoBar.svelte",
	"lib/components/PlaylistPopper/PlaylistPopper.svelte",
	"lib/components/PlaylistPopper/CreatePlaylist.svelte",
	"lib/components/DownloadSongModal/DownloadSongModal.svelte",
	"lib/components/GroupSessionCreator/GroupSessionCreator.svelte",
	"lib/components/Search/options.ts",
	"lib/stores/ogtags.ts",
] as const;

/**
 * Beatbump-origin files the program edited: only the program's own lines
 * are checked (the original English stays until Camille's decision 1): each
 * entry lists the exact strings that must be French.
 */
export const PROGRAM_STRINGS: Record<string, string[]> = {
	"routes/(app)/release/+page.svelte": ['label: "Radio de l\'album"', '"Tout lire"'],
	"routes/(app)/home/+page.svelte": ["Impossible de charger les suggestions YouTube", 'retryTestid="retry-home"'],
};

/** English UI words that must not show on a French program screen (case-sensitive, whole word). */
export const DENY = [
	"Loading",
	"Results",
	"Refresh",
	"Download",
	"Remove",
	"Cached",
	"Settings",
	"Clear",
	"Play all",
	"Shuffle",
	"MB",
	"GB",
	"Filter",
	"No results",
	"Sort",
	"Add to",
	// L10-13: words the v9/v10 audits found on screens one tap from the French nav.
	"Sign in",
	"Sign out",
	"Switch profile",
	"Your",
	"See All",
	"Album Radio",
	"Uh-Oh",
	// Decision 1 (c59a): words of the Beatbump-origin screens.
	"Favorite",
	"View Artist",
	"Lyrics",
	"Appearance",
	"Playback",
	"Account",
	"Show More",
	"Show All",
	"Showing results",
	"Not Playing",
	"Now playing",
	"Export Data",
	"Import Data",
	"Sync Your Data",
	"Next Step",
	"Trending",
	"Search",
	"Home",
	"Songs",
	"Beatbump",
] as const;

/** Menu identifiers (dropdowns.config keys): code, not UI text; their French label is checked below. */
const MENU_KEYS = new Set<string>(Object.keys(DROPDOWN_LABELS_FR));

/** Accepted hits: `${file}::${text}` -> reason. */
const ALLOW: Record<string, string> = {
	// Decision 1 (c59a): identifiers that never reach the screen as such.
	"routes/(app)/search/[slug]/+page.svelte::Your Library": "titre de l etagere renvoye par le backend, affiche via SHELF_TITLES_FR",
	"routes/(app)/playlist/[slug]/+page.svelte::key: \"Shuffle\",": "identifiant de menu construit dans le markup",
	"routes/(app)/playlist/[slug]/+page.svelte::text: fr(\"Shuffle\"),": "libelle via fr(), identifiant de menu",
	"lib/components/Carousel/Carousel.svelte::Trending": "test sur le titre d un carrousel YouTube, pas un texte affiche",
};

const USER_ATTRS = ["aria-label", "title", "placeholder", "alt", "label"];

function stripComments(s: string): string {
	return s.replace(/<!--[\s\S]*?-->/g, " ");
}

/** String literal contents of a JS/TS chunk, skipping console.*, throw new Error(...) and imports. */
export function scriptStrings(code: string): string[] {
	const out: string[] = [];
	const cleaned = code
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
		.filter((line) => !/\bconsole\.\w+\(|\bthrow new \w*Error\(|^\s*import\b|\bfrom\s+["']/.test(line))
		.join("\n");
	const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cleaned))) {
		// template literal: `${...}` holes are code (identifiers like MB), not text
		const text = m[3] !== undefined ? m[3].replace(/\$\{[^}]*\}/g, " ") : (m[1] ?? m[2] ?? "");
		out.push(text);
	}
	return out;
}

/** The user-readable text of a Svelte component (see the header). */
export function visibleTexts(source: string): string[] {
	const out: string[] = [];
	const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	for (const code of scripts) out.push(...scriptStrings(code));
	let markup = stripComments(
		source
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " "),
	);
	// user-facing static attributes (the static part of attr="text {expr} text")
	const attrRe = new RegExp(`\\s(?:${USER_ATTRS.join("|")})=(?:"([^"]*)"|'([^']*)')`, "g");
	for (const m of markup.matchAll(attrRe)) out.push((m[1] ?? m[2] ?? "").replace(/\{[^}]*\}/g, " "));
	// string literals in {...} expressions anywhere in the markup
	for (const m of markup.matchAll(/\{([^{}]*)\}/g)) out.push(...scriptStrings(m[1]));
	// text nodes: drop tags and expressions, keep what is left
	markup = markup.replace(/\{[^{}]*\}/g, " ").replace(/<[^>]*>/g, "\n");
	out.push(...markup.split("\n").map((t) => t.trim()).filter(Boolean));
	return out;
}

export function denyHits(texts: string[]): { word: string; text: string }[] {
	const hits: { word: string; text: string }[] = [];
	for (const text of texts)
		for (const word of DENY) {
			const re = new RegExp(`(^|[^A-Za-z0-9_-])${word.replace(/ /g, "\\s+")}($|[^A-Za-z0-9_-])`);
			if (re.test(text)) hits.push({ word, text: text.trim().slice(0, 80) });
		}
	return hits;
}

describe("frenchScreens: helpers", () => {
	it("finds markup text, user attributes and script strings, not identifiers or CSS", () => {
		const src = `<script>
import Download from "./Download.svelte";
const a = "Play all";
console.log("Loading");
</script>
<button aria-label="Remove item" class="Clear" data-testid="Settings">Refresh</button>
{#if x}<p>{busy ? "Loading…" : n + " MB"}</p>{/if}
<!-- Shuffle --><style>.Sort { color: red }</style>`;
		const words = denyHits(visibleTexts(src)).map((h) => h.word).sort();
		expect(words).toEqual(["Loading", "MB", "Play all", "Refresh", "Remove"]);
	});
	it("ignores French text and words inside identifiers", () => {
		expect(denyHits(visibleTexts(`<p>Télécharger · 12 Mo</p><Downloader /><p>{sortDesc}</p>`))).toEqual([]);
	});
});

describe("frenchScreens: program screens carry no English UI words", () => {
	for (const file of FILES) {
		it(file, () => {
			const src = readFileSync(join(SRC, file), "utf-8");
			const texts = file.endsWith(".ts") ? scriptStrings(src) : visibleTexts(src);
			const hits = denyHits(texts).filter((h) => !ALLOW[`${file}::${h.text}`] && !MENU_KEYS.has(h.text));
			expect(hits).toEqual([]);
		});
	}
});

describe("frenchScreens: menu labels (dropdowns.config) are French", () => {
	it("every menu key has a non-empty French label without English UI words", () => {
		const labels = Object.values(DROPDOWN_LABELS_FR);
		expect(labels.every((l) => typeof l === "string" && l.trim().length > 0)).toBe(true);
		expect(denyHits(labels)).toEqual([]);
		// The keys the code still filters on keep their English spelling but never reach the screen.
		expect(DROPDOWN_LABELS_FR["View Artist"]).toBe("Voir l'artiste");
		expect(DROPDOWN_LABELS_FR.Favorite).toBe("Favori");
		expect(DROPDOWN_LABELS_FR["Download to device"]).toBe("Télécharger sur l'appareil");
	});
});

describe("frenchScreens: shell and PWA name (decisions 1 and 13)", () => {
	it("app.html is lang=fr and names the app Musique", () => {
		const html = readFileSync(join(SRC, "app.html"), "utf-8");
		expect(html).toMatch(/<html\s+lang="fr"/);
		expect(html).not.toContain('content="Beatbump"');
		expect(html).toMatch(/name="apple-mobile-web-app-title"\s+content="Musique"/);
	});
	it("manifest.json is named Musique and keeps its icons and shortcuts", () => {
		const m = JSON.parse(readFileSync(join(SRC, "../static/manifest.json"), "utf-8"));
		expect(m.name).toBe("Musique");
		expect(m.short_name).toBe("Musique");
		expect(m.lang).toBe("fr");
		expect(Array.isArray(m.icons) && m.icons.length >= 2).toBe(true);
		expect(Array.isArray(m.shortcuts) && m.shortcuts.length >= 4).toBe(true);
	});
});

describe("frenchScreens: program lines of Beatbump-origin files", () => {
	for (const [file, needles] of Object.entries(PROGRAM_STRINGS)) {
		it(file, () => {
			const src = readFileSync(join(SRC, file), "utf-8");
			for (const n of needles) expect(src).toContain(n);
			expect(src).not.toMatch(/label:\s*"Album Radio"/);
		});
	}
});
