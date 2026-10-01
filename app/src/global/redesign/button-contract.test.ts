/**
 * QR3 (brainstorm v3) / L8-7: structural guard for the button contract of
 * `modules/_button.scss`. Every `<button>` in `src/**\/*.svelte` must carry
 * one of the system classes (`.btn-primary`, `.btn-secondary`, `.btn-ghost`)
 * or opt out of the global `button:not(.icon-btn)` rule with `.btn-reset`
 * or `.icon-btn`; otherwise it gets the white pill, `color: #0f0f0f
 * !important` and title case (nine regressions in one cycle, audit UX v9).
 *
 * Files that still rely on the global rule by design (Beatbump-origin
 * screens: Nav, Player, PlaylistPopper, Search, lyrics, _Sync, ...) are
 * listed in LEGACY with their count of unclassed buttons at the time this
 * test was written. The count is a ratchet: it may only go down (fix a
 * button, lower the number), never up, and a file that is not listed must
 * have zero. A new component with a bare `<button>` fails here.
 *
 * U11-1 (audit UX v11): `<a>` tags that look like buttons (a class token
 * `btn`, `btn-*`, `button`, `button-*` or `cta`) are scanned the same way
 * with their own ratchet (LEGACY_LINKS): a link that is dressed as a button
 * must carry a system class, otherwise it gets a one-off look and the link
 * rule's `display: inline` (base/_typography.scss) instead of the pill. The
 * last test pins that rule's exclusion of the system classes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Classes that satisfy the contract (as class tokens, or `class:x` directives). */
export const RECOGNISED = ["btn-primary", "btn-secondary", "btn-ghost", "btn-reset", "icon-btn"] as const;

/**
 * Unclassed-button budget of the files that predate the contract. Keys are
 * POSIX paths relative to `src/`. Lower a number when you fix a button in
 * that file; remove the entry at zero.
 */
const LEGACY: Record<string, number> = {
	"lib/components/Alert/Alert.svelte": 1,
	"lib/components/Button/Button.svelte": 1,
	"lib/components/Carousel/Carousel.svelte": 2,
	"lib/components/DownloadSongModal/DownloadSongModal.svelte": 2,
	"lib/components/DraggableList/DraggableList.svelte": 1,
	"lib/components/FollowButton/FollowButton.svelte": 1,
	"lib/components/Nav/Nav.svelte": 6,
	"lib/components/Offline/AlbumCard.svelte": 7,
	"lib/components/Offline/MixtapeSheet.svelte": 4,
	"lib/components/Offline/OfflineTrackRow.svelte": 5,
	"lib/components/Player/Controls.svelte": 6,
	"lib/components/Player/Fullscreen.svelte": 7,
	"lib/components/Player/Player.svelte": 4,
	"lib/components/Player/PlayerButton.svelte": 1,
	"lib/components/PlaylistPopper/CreatePlaylist.svelte": 5,
	"lib/components/PlaylistPopper/List.svelte": 1,
	"lib/components/Search/Search.svelte": 1,
	"routes/(app)/library/+page.svelte": 4,
	"routes/(app)/library/account/+page.svelte": 2,
	"routes/(app)/library/_components/Popup.svelte": 1,
	"routes/(app)/library/downloads-offline/+page.svelte": 6,
	"routes/(app)/library/for-you/+page.svelte": 0,
	"routes/(app)/library/playlists-srv/+page.svelte": 2,
	"routes/(app)/library/playlists-srv/[id]/+page.svelte": 1,
	"routes/(app)/library/stats/+page.svelte": 1,
	"routes/(app)/library/_Sync.svelte": 5,
	"routes/(app)/lyrics/+page.svelte": 4,
	"routes/(app)/trending/+page.svelte": 1,
	"routes/(app)/[watchOrListen=share]/+page.svelte": 1,
};

/**
 * Button-like `<a>` budget of the files that predate the contract (same
 * ratchet as LEGACY). Keys are POSIX paths relative to `src/`.
 */
const LEGACY_LINKS: Record<string, number> = {
	"routes/(app)/settings/+page.svelte": 1,
	"routes/+error.svelte": 1,
};

function svelteFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (name === "node_modules") continue;
			svelteFiles(p, out);
		} else if (name.endsWith(".svelte")) out.push(p);
	}
	return out;
}

/** The attribute text of every `<button ...>` opening tag in `source`. */
export function buttonOpenTags(source: string): string[] {
	const out: string[] = [];
	const re = /<button\b([^>]*)>/gs;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source))) out.push(m[1]);
	return out;
}

/** The attribute text of every `<a ...>` opening tag in `source`. */
export function linkOpenTags(source: string): string[] {
	const out: string[] = [];
	const re = /<a\b([^>]*)>/gs;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source))) out.push(m[1]);
	return out;
}

/** Class tokens of an attribute text (static `class="..."` / `class='...'` / `class={...}`). */
function classTokens(attrs: string): string[] {
	const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/s.exec(attrs);
	if (!cls) return [];
	return (cls[1] ?? cls[2] ?? cls[3] ?? "").split(/[^\w-]+/).filter(Boolean);
}

/** Whether an `<a>` is dressed as a button: a `btn`, `btn-*`, `button`, `button-*` or `cta` class token. */
export function isButtonLikeLink(attrs: string): boolean {
	return classTokens(attrs).some((t) => /^(btn|button)(-[\w-]+)?$|^cta$/.test(t));
}

/**
 * Whether a button's attribute text satisfies the contract: a recognised
 * token inside `class="..."` / `class={...}` / `class='...'`, or a
 * `class:<recognised>` directive.
 */
export function hasRecognisedClass(attrs: string): boolean {
	// A whole class token: not preceded / followed by a word char or a hyphen
	// (`my-btn-primary` is not `btn-primary`).
	const tokens = new RegExp(`(?<![\\w-])(${RECOGNISED.join("|")})(?![\\w-])`);
	const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/s.exec(attrs);
	if (cls && tokens.test(cls[1] ?? cls[2] ?? cls[3] ?? "")) return true;
	return new RegExp(`\\bclass:(${RECOGNISED.join("|")})(?![\\w-])`).test(attrs);
}

/** Unclassed `<button>` count per file (relative POSIX path -> count). */
function scan(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of svelteFiles(SRC)) {
		const rel = relative(SRC, file).split(sep).join("/");
		const bad = buttonOpenTags(readFileSync(file, "utf8")).filter((a) => !hasRecognisedClass(a)).length;
		if (bad > 0) counts.set(rel, bad);
	}
	return counts;
}

/** Button-like `<a>` without a system class, per file (relative POSIX path -> count). */
function scanLinks(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const file of svelteFiles(SRC)) {
		const rel = relative(SRC, file).split(sep).join("/");
		const bad = linkOpenTags(readFileSync(file, "utf8")).filter(
			(a) => isButtonLikeLink(a) && !hasRecognisedClass(a),
		).length;
		if (bad > 0) counts.set(rel, bad);
	}
	return counts;
}

describe("button contract (QR3): every <button> carries a system class or .btn-reset / .icon-btn", () => {
	it("recognises the contract classes and directives", () => {
		expect(hasRecognisedClass(' type="button" class="btn-secondary complete"')).toBe(true);
		expect(hasRecognisedClass(' class="btn-reset az-letter"')).toBe(true);
		expect(hasRecognisedClass(" class={`icon-btn ${x}`}")).toBe(true);
		expect(hasRecognisedClass(' class="chip" class:btn-reset={true}')).toBe(true);
		expect(hasRecognisedClass(' type="button"')).toBe(false);
		expect(hasRecognisedClass(' class="btn"')).toBe(false);
		expect(hasRecognisedClass(' class="my-btn-primary"')).toBe(false);
		expect(buttonOpenTags('<button\n\ttype="button"\n\tclass="x"\n>a</button><button>b</button>')).toEqual([
			'\n\ttype="button"\n\tclass="x"\n',
			"",
		]);
	});

	it("no new unclassed <button> anywhere under src/ (legacy files only within their budget)", () => {
		const counts = scan();
		const offenders: string[] = [];
		for (const [file, n] of counts) {
			const budget = LEGACY[file] ?? 0;
			if (n > budget) offenders.push(`${file}: ${n} unclassed <button> (budget ${budget})`);
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	it("the legacy budget only ratchets down (lower the number when a file is fixed)", () => {
		const counts = scan();
		const stale: string[] = [];
		for (const [file, budget] of Object.entries(LEGACY)) {
			const n = counts.get(file) ?? 0;
			if (n < budget) stale.push(`${file}: now ${n}, budget ${budget} -> lower it in LEGACY`);
		}
		expect(stale, stale.join("\n")).toEqual([]);
	});
});

describe("button contract (U11-1): a link dressed as a button carries a system class", () => {
	it("recognises button-like links", () => {
		expect(isButtonLikeLink(' href="/home" class="button home-link"')).toBe(true);
		expect(isButtonLikeLink(' class="btn" href="/about"')).toBe(true);
		expect(isButtonLikeLink(' class="cta btn-reset"')).toBe(true);
		expect(isButtonLikeLink(' class="btn-secondary export" href="/x"')).toBe(true);
		expect(isButtonLikeLink(' class="player-btn no-style" href="/lyrics"')).toBe(false);
		expect(isButtonLikeLink(' class="stats-card" href="/library/stats"')).toBe(false);
		expect(isButtonLikeLink(' href="/home"')).toBe(false);
		expect(linkOpenTags('<a\n\thref="/x"\n\tclass="btn-primary"\n>a</a><a href="/y">b</a>')).toEqual([
			'\n\thref="/x"\n\tclass="btn-primary"\n',
			' href="/y"',
		]);
	});

	it("no new button-like <a> without a system class (legacy files only within their budget)", () => {
		const counts = scanLinks();
		const offenders: string[] = [];
		for (const [file, n] of counts) {
			const budget = LEGACY_LINKS[file] ?? 0;
			if (n > budget) offenders.push(`${file}: ${n} button-like <a> without a system class (budget ${budget})`);
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	it("the link budget only ratchets down", () => {
		const counts = scanLinks();
		const stale: string[] = [];
		for (const [file, budget] of Object.entries(LEGACY_LINKS)) {
			const n = counts.get(file) ?? 0;
			if (n < budget) stale.push(`${file}: now ${n}, budget ${budget} -> lower it in LEGACY_LINKS`);
		}
		expect(stale, stale.join("\n")).toEqual([]);
	});

	it("the global link rule keeps excluding the button-system classes (base/_typography.scss)", () => {
		// No compilation: the rule text itself is the contract. `a:not(.no-style)`
		// must always be followed by the :where() exclusion, otherwise its
		// `display: inline` beats `.btn-*`'s `inline-flex` and the labels sit
		// on the top edge of their pills again (audit UX v11, U11-1).
		const scss = readFileSync(join(SRC, "global/redesign/base/_typography.scss"), "utf8");
		const EXCLUSION = ":where(:not(.btn-primary):not(.btn-secondary):not(.btn-ghost))";
		const selectors = scss.match(/(?:^|[,\s])(?:a|\.link):not\(\.no-style\)[^,{]*/gm) ?? [];
		expect(selectors.length).toBeGreaterThanOrEqual(2);
		for (const sel of selectors) expect(sel, sel).toContain(EXCLUSION);
	});
});
